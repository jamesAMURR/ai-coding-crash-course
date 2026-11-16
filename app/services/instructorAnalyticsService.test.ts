import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getInstructorAnalytics } from "./instructorAnalyticsService";

// ─── Fixtures ───
// Small builders shared by every metric's tests. Later tickets add their own
// builders (purchases, ratings, ...) here rather than inline in each test.

let slugCounter = 0;

function createCourse(
  status: schema.CourseStatus,
  instructorId: number = base.instructor.id
) {
  slugCounter += 1;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${slugCounter}`,
      slug: `course-${slugCounter}`,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

let userCounter = 0;

function createUser(role: schema.UserRole = schema.UserRole.Student) {
  userCounter += 1;
  return testDb
    .insert(schema.users)
    .values({
      name: `User ${userCounter}`,
      email: `user${userCounter}@example.com`,
      role,
    })
    .returning()
    .get();
}

function enrol(userId: number, courseId: number) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId })
    .returning()
    .get();
}

function enrolAt(
  userId: number,
  courseId: number,
  dates: { enrolledAt?: string; completedAt?: string | null }
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, ...dates })
    .returning()
    .get();
}

let positionCounter = 0;

function createLesson(courseId: number) {
  positionCounter += 1;
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${positionCounter}`, position: positionCounter })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: `Lesson ${positionCounter}`, position: positionCounter })
    .returning()
    .get();
}

function completeLesson(userId: number, lessonId: number) {
  return testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

function courseRow(analytics: ReturnType<typeof getInstructorAnalytics>, id: number) {
  return analytics.courses.find((c) => c.id === id);
}

describe("instructorAnalyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("course selection", () => {
    it("leaves draft courses out", () => {
      const draft = createCourse(schema.CourseStatus.Draft);
      enrol(base.user.id, draft.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.courses.map((c) => c.id)).toEqual([base.course.id]);
      expect(analytics.summary.totalStudents).toBe(0);
    });

    it("includes archived courses with their status", () => {
      const archived = createCourse(schema.CourseStatus.Archived);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, archived.id)).toMatchObject({
        id: archived.id,
        title: archived.title,
        slug: archived.slug,
        status: schema.CourseStatus.Archived,
      });
      expect(courseRow(analytics, base.course.id)?.status).toBe(
        schema.CourseStatus.Published
      );
    });

    it("never includes another instructor's courses", () => {
      const other = createUser(schema.UserRole.Instructor);
      const theirs = createCourse(schema.CourseStatus.Published, other.id);
      enrol(base.user.id, theirs.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, theirs.id)).toBeUndefined();
      expect(analytics.summary.coursesTeaching).toBe(1);
      expect(analytics.summary.totalStudents).toBe(0);
    });

    it("returns zeros and an empty list for an instructor with no published or archived courses", () => {
      const newcomer = createUser(schema.UserRole.Instructor);
      createCourse(schema.CourseStatus.Draft, newcomer.id);

      const analytics = getInstructorAnalytics(newcomer.id);

      expect(analytics.courses).toEqual([]);
      expect(analytics.summary).toMatchObject({
        coursesTeaching: 0,
        totalStudents: 0,
      });
    });
  });

  describe("courses teaching", () => {
    it("counts only published courses", () => {
      createCourse(schema.CourseStatus.Published);
      createCourse(schema.CourseStatus.Archived);
      createCourse(schema.CourseStatus.Draft);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.coursesTeaching).toBe(2);
    });
  });

  describe("students", () => {
    it("counts enrolment rows per course and in total, including archived courses", () => {
      const archived = createCourse(schema.CourseStatus.Archived);
      const second = createUser();
      enrol(base.user.id, base.course.id);
      enrol(second.id, base.course.id);
      // The same student in two courses counts once per enrolment.
      enrol(base.user.id, archived.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, base.course.id)?.students).toBe(2);
      expect(courseRow(analytics, archived.id)?.students).toBe(1);
      expect(analytics.summary.totalStudents).toBe(3);
    });

    it("reports zero students for a course with no enrolments", () => {
      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, base.course.id)?.students).toBe(0);
    });
  });
  describe("new students", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const daysAgo = (days: number, extraMs = 0) =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000 - extraMs).toISOString();

    it("counts enrolments within 30 days of now, inclusive of the boundary", () => {
      const archived = createCourse(schema.CourseStatus.Archived);
      const [a, b, c, d] = [createUser(), createUser(), createUser(), createUser()];
      enrolAt(a.id, base.course.id, { enrolledAt: daysAgo(1) });
      enrolAt(b.id, base.course.id, { enrolledAt: daysAgo(30) });
      enrolAt(c.id, base.course.id, { enrolledAt: daysAgo(30, 1) });
      enrolAt(d.id, archived.id, { enrolledAt: daysAgo(10) });

      const analytics = getInstructorAnalytics(base.instructor.id, now);

      expect(analytics.summary.newStudentsLast30Days).toBe(3);
    });

    it("is zero when there are no recent enrolments", () => {
      enrolAt(base.user.id, base.course.id, { enrolledAt: daysAgo(90) });

      const analytics = getInstructorAnalytics(base.instructor.id, now);

      expect(analytics.summary.newStudentsLast30Days).toBe(0);
    });
  });

  describe("completion rate and average progress", () => {
    it("handles a mix of finished, partly done and not-started students", () => {
      const lessons = [1, 2, 3, 4].map(() => createLesson(base.course.id));
      const [finished, partial, notStarted] = [createUser(), createUser(), createUser()];
      enrolAt(finished.id, base.course.id, { completedAt: new Date().toISOString() });
      enrolAt(partial.id, base.course.id, {});
      enrolAt(notStarted.id, base.course.id, {});
      for (const lesson of lessons) completeLesson(finished.id, lesson.id);
      completeLesson(partial.id, lessons[0].id);

      // Progress in another course must not leak into this one.
      const other = createCourse(schema.CourseStatus.Published);
      const otherLesson = createLesson(other.id);
      completeLesson(notStarted.id, otherLesson.id);
      // An in-progress (not completed) lesson does not count.
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: partial.id,
          lessonId: lessons[1].id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      const analytics = getInstructorAnalytics(base.instructor.id);
      const row = courseRow(analytics, base.course.id);

      expect(row?.completionRate).toBeCloseTo(1 / 3);
      // (4/4 + 1/4 + 0/4) / 3
      expect(row?.averageProgress).toBeCloseTo(1.25 / 3);
    });

    it("returns null for a course with no students", () => {
      createLesson(base.course.id);

      const analytics = getInstructorAnalytics(base.instructor.id);
      const row = courseRow(analytics, base.course.id);

      expect(row?.completionRate).toBeNull();
      expect(row?.averageProgress).toBeNull();
    });

    it("returns null average progress for a course with students but no lessons", () => {
      enrolAt(base.user.id, base.course.id, {});

      const analytics = getInstructorAnalytics(base.instructor.id);
      const row = courseRow(analytics, base.course.id);

      expect(row?.completionRate).toBe(0);
      expect(row?.averageProgress).toBeNull();
    });
  });
});
