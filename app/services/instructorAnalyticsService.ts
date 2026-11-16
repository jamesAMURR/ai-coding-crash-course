import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, courseRatings, enrollments, CourseStatus } from "~/db/schema";
import { lessons, modules, quizAttempts, quizzes } from "~/db/schema";
import { getCourseRatingSummaries } from "~/services/courseRatingService";

// ─── Instructor Analytics Service ───
// Builds the whole instructor analytics payload for /dashboard in one call.
//
// Scope: the instructor's published and archived courses. Drafts and other
// instructors' courses are left out of every number. Archived courses count
// toward totals; "courses teaching" counts published courses only.
//
// Shape, so each metric stays a small, separate change:
// - One helper per metric, taking the included course IDs and returning a
//   Map keyed by course ID. Each is a single batched GROUP BY over those IDs —
//   never a query per course (same pattern as getCourseRatingSummaries).
// - getInstructorAnalytics fetches the included courses, calls each helper
//   once, then assembles per-course rows and the portfolio summary.
// - A metric with no data is `null` (the UI renders "—"). Counts that are
//   naturally zero (students, courses) stay numbers.
//
// `now` anchors time-windowed metrics (e.g. "last 30 days") so tests can pin it.

export type InstructorCourseRow = {
  id: number;
  title: string;
  slug: string;
  status: CourseStatus;
  students: number;
  ratingAverage: number | null;
  ratingCount: number;
  averageQuizScore: number | null;
  quizPassRate: number | null;
};

export type InstructorAnalyticsSummary = {
  coursesTeaching: number;
  totalStudents: number;
  averageRating: number | null;
  ratingCount: number;
};

export type InstructorAnalytics = {
  summary: InstructorAnalyticsSummary;
  courses: InstructorCourseRow[];
};

const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

function getIncludedCourses(instructorId: number) {
  return db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
    })
    .from(courses)
    .where(
      and(
        eq(courses.instructorId, instructorId),
        inArray(courses.status, INCLUDED_STATUSES)
      )
    )
    .orderBy(courses.title)
    .all();
}

// ─── Metric: students ───
// Enrolment rows per course (a student in two courses counts twice).
function getStudentCountsByCourse(courseIds: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  if (courseIds.length === 0) return counts;

  const rows = db
    .select({
      courseId: enrollments.courseId,
      count: sql<number>`count(*)`,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId)
    .all();

  for (const row of rows) counts.set(row.courseId, row.count);
  return counts;
}

// ─── Metric: ratings ───
// Per-course average and count reuse the batched getCourseRatingSummaries.
// The portfolio average is weighted by rating count — the mean of every
// individual rating — so it is computed from the raw rows in one query rather
// than from the (rounded) course averages.
function getPortfolioRating(courseIds: number[]): number | null {
  if (courseIds.length === 0) return null;

  const result = db
    .select({ average: sql<number | null>`avg(${courseRatings.rating})` })
    .from(courseRatings)
    .where(inArray(courseRatings.courseId, courseIds))
    .get();

  const average = result?.average ?? null;
  return average === null ? null : Math.round(average * 10) / 10;
}

// ─── Metric: quiz score and pass rate ───
// For each (student, quiz) in the course, keep only the best attempt (highest
// score; a passing attempt wins a tie). Then average those best scores and
// take the share of them that passed. Courses with no attempts are absent
// from the map, so both metrics come out `null`.
type QuizStats = { averageQuizScore: number; quizPassRate: number };

function getQuizStatsByCourse(courseIds: number[]): Map<number, QuizStats> {
  const stats = new Map<number, QuizStats>();
  if (courseIds.length === 0) return stats;

  const ranked = db
    .select({
      courseId: modules.courseId,
      score: quizAttempts.score,
      passed: quizAttempts.passed,
      rank: sql<number>`row_number() over (
        partition by ${quizAttempts.userId}, ${quizAttempts.quizId}
        order by ${quizAttempts.score} desc, ${quizAttempts.passed} desc
      )`.as("rank"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(inArray(modules.courseId, courseIds))
    .as("ranked");

  const rows = db
    .select({
      courseId: ranked.courseId,
      averageQuizScore: sql<number>`avg(${ranked.score})`,
      quizPassRate: sql<number>`avg(case when ${ranked.passed} then 1.0 else 0.0 end)`,
    })
    .from(ranked)
    .where(eq(ranked.rank, 1))
    .groupBy(ranked.courseId)
    .all();

  for (const row of rows) {
    stats.set(row.courseId, {
      averageQuizScore: row.averageQuizScore,
      quizPassRate: row.quizPassRate,
    });
  }
  return stats;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function getInstructorAnalytics(
  instructorId: number,
  now: Date = new Date()
): InstructorAnalytics {
  void now; // Reserved for time-windowed metrics.

  const includedCourses = getIncludedCourses(instructorId);
  const courseIds = includedCourses.map((c) => c.id);

  // One batched query per metric.
  const studentCounts = getStudentCountsByCourse(courseIds);
  const ratingSummaries = getCourseRatingSummaries(courseIds);
  const quizStats = getQuizStatsByCourse(courseIds);

  const rows: InstructorCourseRow[] = includedCourses.map((course) => ({
    id: course.id,
    title: course.title,
    slug: course.slug,
    status: course.status,
    students: studentCounts.get(course.id) ?? 0,
    ratingAverage: ratingSummaries.get(course.id)?.average ?? null,
    ratingCount: ratingSummaries.get(course.id)?.count ?? 0,
    averageQuizScore: quizStats.get(course.id)?.averageQuizScore ?? null,
    quizPassRate: quizStats.get(course.id)?.quizPassRate ?? null,
  }));

  const summary: InstructorAnalyticsSummary = {
    coursesTeaching: rows.filter((r) => r.status === CourseStatus.Published)
      .length,
    totalStudents: sum(rows.map((r) => r.students)),
    averageRating: getPortfolioRating(courseIds),
    ratingCount: sum(rows.map((r) => r.ratingCount)),
  };

  return { summary, courses: rows };
}
