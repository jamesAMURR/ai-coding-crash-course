import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  courseRatings,
  enrollments,
  purchases,
  CourseStatus,
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
};

export type InstructorAnalyticsSummary = {
  coursesTeaching: number;
  totalStudents: number;
  averageRating: number | null;
  ratingCount: number;
  grossSalesCents: number;
  grossSalesLast30DaysCents: number;
  unansweredComments: number;
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

  const rows: InstructorCourseRow[] = includedCourses.map((course) => ({
    id: course.id,
    title: course.title,
    slug: course.slug,
    status: course.status,
    students: studentCounts.get(course.id) ?? 0,
    ratingAverage: ratingSummaries.get(course.id)?.average ?? null,
    ratingCount: ratingSummaries.get(course.id)?.count ?? 0,
    grossSalesCents: grossSales.get(course.id)?.allTimeCents ?? 0,
    unansweredComments: unansweredCounts.get(course.id) ?? 0,
  }));

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
  };

  return { summary, courses: rows };
}
