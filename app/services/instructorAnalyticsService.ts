import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, CourseStatus } from "~/db/schema";

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
};

export type InstructorAnalyticsSummary = {
  coursesTeaching: number;
  totalStudents: number;
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

  const rows: InstructorCourseRow[] = includedCourses.map((course) => ({
    id: course.id,
    title: course.title,
    slug: course.slug,
    status: course.status,
    students: studentCounts.get(course.id) ?? 0,
  }));

  const summary: InstructorAnalyticsSummary = {
    coursesTeaching: rows.filter((r) => r.status === CourseStatus.Published)
      .length,
    totalStudents: sum(rows.map((r) => r.students)),
  };

  return { summary, courses: rows };
}
