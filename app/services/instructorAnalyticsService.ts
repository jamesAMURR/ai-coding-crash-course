import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  courseRatings,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  CourseStatus,
  LessonProgressStatus,
} from "~/db/schema";
import { getCourseRatingSummaries } from "~/services/courseRatingService";
import { getUnansweredCommentCountsByCourse } from "~/services/commentService";

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
  grossSalesCents: number;
  unansweredComments: number;
  averageQuizScore: number | null;
  quizPassRate: number | null;
  completionRate: number | null;
  averageProgress: number | null;
};

export type InstructorAnalyticsSummary = {
  coursesTeaching: number;
  totalStudents: number;
  averageRating: number | null;
  ratingCount: number;
  grossSalesCents: number;
  grossSalesLast30DaysCents: number;
  unansweredComments: number;
  newStudentsLast30Days: number;
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

// ─── Metric: gross sales ───
// Sum of amountPaid on purchase rows per course, in USD cents. amountPaid
// already reflects PPP pricing, and a team purchase is a single row, so it
// counts once at what the team paid. The 30-day window uses the purchase date
// measured back from `now` (inclusive of the boundary instant).
type GrossSales = { allTimeCents: number; last30DaysCents: number };

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getGrossSalesByCourse(
  courseIds: number[],
  now: Date
): Map<number, GrossSales> {
  const sales = new Map<number, GrossSales>();
  if (courseIds.length === 0) return sales;

  const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();

  const rows = db
    .select({
      courseId: purchases.courseId,
      allTimeCents: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      last30DaysCents: sql<number>`coalesce(sum(case when ${purchases.createdAt} >= ${cutoff} then ${purchases.amountPaid} else 0 end), 0)`,
    })
    .from(purchases)
    .where(inArray(purchases.courseId, courseIds))
    .groupBy(purchases.courseId)
    .all();

  for (const row of rows) {
    sales.set(row.courseId, {
      allTimeCents: row.allTimeCents,
      last30DaysCents: row.last30DaysCents,
    });
  }
  return sales;
}

// ─── Metric: unanswered comments ───
// The questions queue's rule, shared from commentService so the dashboard and
// /instructor/questions always agree. One batched GROUP BY over the course IDs.
function getUnansweredCommentsByCourse(courseIds: number[]): Map<number, number> {
  return getUnansweredCommentCountsByCourse(courseIds);
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

// ─── Metric: new students ───
// Enrolments whose enrolment date falls within 30 days of `now` (inclusive),
// across all included courses.
const NEW_STUDENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function getNewStudentCount(courseIds: number[], now: Date): number {
  if (courseIds.length === 0) return 0;

  const since = new Date(now.getTime() - NEW_STUDENT_WINDOW_MS).toISOString();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(
      and(
        inArray(enrollments.courseId, courseIds),
        gte(enrollments.enrolledAt, since),
        lte(enrollments.enrolledAt, now.toISOString())
      )
    )
    .get();

  return row?.count ?? 0;
}

// ─── Metric: completion rate ───
// Enrolments with a completion date per course; divided by students when
// assembling rows (null when a course has no students).
function getCompletedCountsByCourse(courseIds: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  if (courseIds.length === 0) return counts;

  const rows = db
    .select({
      courseId: enrollments.courseId,
      count: sql<number>`count(${enrollments.completedAt})`,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId)
    .all();

  for (const row of rows) counts.set(row.courseId, row.count);
  return counts;
}

// ─── Metric: average progress ───
// Per enrolled student: completed lessons ÷ total lessons in the course,
// averaged across enrolled students. Null when a course has no students or
// no lessons. Two batched queries: lesson totals per course, and completed
// lessons per enrolment.
function getAverageProgressByCourse(
  courseIds: number[]
): Map<number, number | null> {
  const averages = new Map<number, number | null>();
  if (courseIds.length === 0) return averages;

  const lessonTotals = new Map<number, number>();
  const totalRows = db
    .select({
      courseId: modules.courseId,
      count: sql<number>`count(${lessons.id})`,
    })
    .from(modules)
    .innerJoin(lessons, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .groupBy(modules.courseId)
    .all();
  for (const row of totalRows) lessonTotals.set(row.courseId, row.count);

  // One row per enrolment, with that student's completed lessons in the course.
  const perEnrolment = db
    .select({
      courseId: enrollments.courseId,
      completed: sql<number>`count(${lessonProgress.id})`,
    })
    .from(enrollments)
    .leftJoin(modules, eq(modules.courseId, enrollments.courseId))
    .leftJoin(lessons, eq(lessons.moduleId, modules.id))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.userId, enrollments.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.id)
    .all();

  const fractions = new Map<number, number[]>();
  for (const row of perEnrolment) {
    const total = lessonTotals.get(row.courseId) ?? 0;
    if (total === 0) continue;
    const list = fractions.get(row.courseId) ?? [];
    list.push(row.completed / total);
    fractions.set(row.courseId, list);
  }

  for (const courseId of courseIds) {
    const list = fractions.get(courseId);
    averages.set(courseId, list ? sum(list) / list.length : null);
  }
  return averages;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function getInstructorAnalytics(
  instructorId: number,
  now: Date = new Date()
): InstructorAnalytics {
  const includedCourses = getIncludedCourses(instructorId);
  const courseIds = includedCourses.map((c) => c.id);

  // One batched query per metric.
  const studentCounts = getStudentCountsByCourse(courseIds);
  const ratingSummaries = getCourseRatingSummaries(courseIds);
  const grossSales = getGrossSalesByCourse(courseIds, now);
  const unansweredCounts = getUnansweredCommentsByCourse(courseIds);
  const quizStats = getQuizStatsByCourse(courseIds);
  const newStudents = getNewStudentCount(courseIds, now);
  const completedCounts = getCompletedCountsByCourse(courseIds);
  const averageProgress = getAverageProgressByCourse(courseIds);

  const rows: InstructorCourseRow[] = includedCourses.map((course) => {
    const students = studentCounts.get(course.id) ?? 0;
    return {
      id: course.id,
      title: course.title,
      slug: course.slug,
      status: course.status,
      students,
      ratingAverage: ratingSummaries.get(course.id)?.average ?? null,
      ratingCount: ratingSummaries.get(course.id)?.count ?? 0,
      grossSalesCents: grossSales.get(course.id)?.allTimeCents ?? 0,
      unansweredComments: unansweredCounts.get(course.id) ?? 0,
      averageQuizScore: quizStats.get(course.id)?.averageQuizScore ?? null,
      quizPassRate: quizStats.get(course.id)?.quizPassRate ?? null,
      completionRate:
        students === 0 ? null : (completedCounts.get(course.id) ?? 0) / students,
      averageProgress: averageProgress.get(course.id) ?? null,
    };
  });

  const summary: InstructorAnalyticsSummary = {
    coursesTeaching: rows.filter((r) => r.status === CourseStatus.Published)
      .length,
    totalStudents: sum(rows.map((r) => r.students)),
    averageRating: getPortfolioRating(courseIds),
    ratingCount: sum(rows.map((r) => r.ratingCount)),
    grossSalesCents: sum(rows.map((r) => r.grossSalesCents)),
    grossSalesLast30DaysCents: sum(
      [...grossSales.values()].map((s) => s.last30DaysCents)
    ),
    unansweredComments: sum(rows.map((r) => r.unansweredComments)),
    newStudentsLast30Days: newStudents,
  };

  return { summary, courses: rows };
}
