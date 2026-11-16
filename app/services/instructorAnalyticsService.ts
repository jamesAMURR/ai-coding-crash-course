import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  CourseStatus,
  LessonProgressStatus,
} from "~/db/schema";

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
  completionRate: number | null;
  averageProgress: number | null;
};

export type InstructorAnalyticsSummary = {
  coursesTeaching: number;
  totalStudents: number;
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
      completionRate:
        students === 0 ? null : (completedCounts.get(course.id) ?? 0) / students,
      averageProgress: averageProgress.get(course.id) ?? null,
    };
  });

  const summary: InstructorAnalyticsSummary = {
    coursesTeaching: rows.filter((r) => r.status === CourseStatus.Published)
      .length,
    totalStudents: sum(rows.map((r) => r.students)),
    newStudentsLast30Days: newStudents,
  };

  return { summary, courses: rows };
}
