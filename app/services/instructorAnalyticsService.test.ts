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
});
