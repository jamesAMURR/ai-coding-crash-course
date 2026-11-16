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
import { getUnansweredQuestions } from "./commentService";

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

function rate(courseId: number, rating: number, userId: number = createUser().id) {
  return testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating })
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

  describe("ratings", () => {
    it("weights the portfolio average by the number of ratings", () => {
      const second = createCourse(schema.CourseStatus.Published);
      rate(base.course.id, 5);
      for (let i = 0; i < 10; i++) rate(second.id, 3);

      const analytics = getInstructorAnalytics(base.instructor.id);

      // (5 + 10 × 3) / 11 ≈ 3.18, not the course-average mean of 4.
      expect(analytics.summary.averageRating).toBe(3.2);
      expect(analytics.summary.ratingCount).toBe(11);
      expect(courseRow(analytics, base.course.id)).toMatchObject({
        ratingAverage: 5,
        ratingCount: 1,
      });
      expect(courseRow(analytics, second.id)).toMatchObject({
        ratingAverage: 3,
        ratingCount: 10,
      });
    });

    it("includes archived courses and leaves drafts out", () => {
      const archived = createCourse(schema.CourseStatus.Archived);
      const draft = createCourse(schema.CourseStatus.Draft);
      rate(archived.id, 4);
      rate(archived.id, 2);
      rate(draft.id, 1);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, archived.id)).toMatchObject({
        ratingAverage: 3,
        ratingCount: 2,
      });
      expect(analytics.summary.averageRating).toBe(3);
      expect(analytics.summary.ratingCount).toBe(2);
    });

    it("returns null averages when there are no ratings", () => {
      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.averageRating).toBeNull();
      expect(analytics.summary.ratingCount).toBe(0);
      expect(courseRow(analytics, base.course.id)).toMatchObject({
        ratingAverage: null,
        ratingCount: 0,
      });
    });
  });

  describe("gross sales", () => {
    const NOW = new Date("2026-06-30T12:00:00.000Z");
    const DAY_MS = 86_400_000;

    function daysBeforeNow(days: number) {
      return new Date(NOW.getTime() - days * DAY_MS).toISOString();
    }

    function purchase(
      courseId: number,
      amountPaid: number,
      createdAt: string = daysBeforeNow(100),
      userId: number = base.user.id,
      country: string | null = null
    ) {
      return testDb
        .insert(schema.purchases)
        .values({ userId, courseId, amountPaid, country, createdAt })
        .returning()
        .get();
    }

    it("sums the amount paid, so a PPP-discounted purchase counts at what the buyer paid", () => {
      // A full-price buyer, and an Indian buyer who paid a PPP-discounted price.
      purchase(base.course.id, 4999);
      purchase(base.course.id, 1500, daysBeforeNow(100), createUser().id, "IN");

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(courseRow(analytics, base.course.id)?.grossSalesCents).toBe(6499);
      expect(analytics.summary.grossSalesCents).toBe(6499);
    });

    it("counts a team purchase once at the amount paid, however many seats it has", () => {
      const teamPurchase = purchase(base.course.id, 20000);
      const team = testDb.insert(schema.teams).values({}).returning().get();
      const redeemer = createUser();
      testDb
        .insert(schema.coupons)
        .values([
          {
            teamId: team.id,
            courseId: base.course.id,
            code: "SEAT-1",
            purchaseId: teamPurchase.id,
            redeemedByUserId: redeemer.id,
            redeemedAt: daysBeforeNow(90),
          },
          {
            teamId: team.id,
            courseId: base.course.id,
            code: "SEAT-2",
            purchaseId: teamPurchase.id,
          },
        ])
        .run();
      enrol(redeemer.id, base.course.id);

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(courseRow(analytics, base.course.id)?.grossSalesCents).toBe(20000);
      expect(analytics.summary.grossSalesCents).toBe(20000);
    });

    it("includes archived courses and leaves drafts out", () => {
      const archived = createCourse(schema.CourseStatus.Archived);
      const draft = createCourse(schema.CourseStatus.Draft);
      purchase(base.course.id, 1000);
      purchase(archived.id, 2000);
      purchase(draft.id, 4000);

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(courseRow(analytics, archived.id)?.grossSalesCents).toBe(2000);
      expect(analytics.summary.grossSalesCents).toBe(3000);
      expect(analytics.summary.grossSalesLast30DaysCents).toBe(0);
    });

    it("honours the 30-day boundary measured back from now", () => {
      purchase(base.course.id, 100, daysBeforeNow(30)); // exactly on the boundary: in
      purchase(base.course.id, 200, daysBeforeNow(1)); // in
      purchase(base.course.id, 400, daysBeforeNow(30.01)); // just outside: out
      purchase(base.course.id, 800, daysBeforeNow(365)); // out

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(analytics.summary.grossSalesLast30DaysCents).toBe(300);
      expect(analytics.summary.grossSalesCents).toBe(1500);
    });

    it("leaves purchases dated after now out of the 30-day window", () => {
      purchase(base.course.id, 100, daysBeforeNow(1)); // in
      purchase(base.course.id, 200, daysBeforeNow(-1)); // after now: out

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(analytics.summary.grossSalesLast30DaysCents).toBe(100);
    });

    it("shows 0 sales for a course with no purchases", () => {
      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(courseRow(analytics, base.course.id)?.grossSalesCents).toBe(0);
      expect(analytics.summary).toMatchObject({
        grossSalesCents: 0,
        grossSalesLast30DaysCents: 0,
      });
    });

    it("never counts another instructor's sales", () => {
      const other = createUser(schema.UserRole.Instructor);
      const theirs = createCourse(schema.CourseStatus.Published, other.id);
      purchase(theirs.id, 9999, daysBeforeNow(1));

      const analytics = getInstructorAnalytics(base.instructor.id, NOW);

      expect(analytics.summary.grossSalesCents).toBe(0);
      expect(analytics.summary.grossSalesLast30DaysCents).toBe(0);
    });
  });

  describe("unanswered comments", () => {
    function createLesson(courseId: number) {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId, title: "Module", position: 1 })
        .returning()
        .get();
      return testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: "Lesson", position: 1 })
        .returning()
        .get();
    }

    function comment(
      userId: number,
      lessonId: number,
      opts: { parentId?: number; deleted?: boolean } = {}
    ) {
      return testDb
        .insert(schema.comments)
        .values({
          userId,
          lessonId,
          parentId: opts.parentId ?? null,
          body: "A comment",
          deletedAt: opts.deleted ? new Date().toISOString() : null,
        })
        .returning()
        .get();
    }

    it("counts per course and in total, matching the questions queue", () => {
      const archived = createCourse(schema.CourseStatus.Archived);
      const lesson = createLesson(base.course.id);
      const archivedLesson = createLesson(archived.id);
      const second = createUser();
      comment(base.user.id, lesson.id);
      comment(second.id, lesson.id);
      comment(base.user.id, archivedLesson.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, base.course.id)?.unansweredComments).toBe(2);
      expect(courseRow(analytics, archived.id)?.unansweredComments).toBe(1);
      expect(analytics.summary.unansweredComments).toBe(3);
      expect(analytics.summary.unansweredComments).toBe(
        getUnansweredQuestions(base.instructor.id).length
      );
    });

    it("treats a reply from the instructor or an admin as resolving the comment", () => {
      const lesson = createLesson(base.course.id);
      const admin = createUser(schema.UserRole.Admin);
      const byInstructor = comment(base.user.id, lesson.id);
      const byAdmin = comment(base.user.id, lesson.id);
      const byStudent = comment(base.user.id, lesson.id);
      comment(base.instructor.id, lesson.id, { parentId: byInstructor.id });
      comment(admin.id, lesson.id, { parentId: byAdmin.id });
      comment(createUser().id, lesson.id, { parentId: byStudent.id });

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, base.course.id)?.unansweredComments).toBe(1);
      expect(analytics.summary.unansweredComments).toBe(1);
    });

    it("ignores deleted comments and deleted staff replies", () => {
      const lesson = createLesson(base.course.id);
      comment(base.user.id, lesson.id, { deleted: true });
      const stillOpen = comment(base.user.id, lesson.id);
      comment(base.instructor.id, lesson.id, {
        parentId: stillOpen.id,
        deleted: true,
      });

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.unansweredComments).toBe(1);
      expect(analytics.summary.unansweredComments).toBe(
        getUnansweredQuestions(base.instructor.id).length
      );
    });

    it("leaves out comments written by the instructor or an admin", () => {
      const lesson = createLesson(base.course.id);
      comment(base.instructor.id, lesson.id);
      comment(createUser(schema.UserRole.Admin).id, lesson.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseRow(analytics, base.course.id)?.unansweredComments).toBe(0);
      expect(analytics.summary.unansweredComments).toBe(0);
    });

    it("leaves out comments on draft courses and other instructors' courses", () => {
      const draft = createCourse(schema.CourseStatus.Draft);
      const other = createUser(schema.UserRole.Instructor);
      const theirs = createCourse(schema.CourseStatus.Published, other.id);
      comment(base.user.id, createLesson(draft.id).id);
      comment(base.user.id, createLesson(theirs.id).id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.unansweredComments).toBe(0);
    });
  });

  describe("quiz score and pass rate", () => {
    let positionCounter = 0;

    function createQuiz(courseId: number) {
      positionCounter += 1;
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId, title: `Module ${positionCounter}`, position: positionCounter })
        .returning()
        .get();
      const lesson = testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${positionCounter}`, position: 1 })
        .returning()
        .get();
      return testDb
        .insert(schema.quizzes)
        .values({ lessonId: lesson.id, title: `Quiz ${positionCounter}`, passingScore: 0.7 })
        .returning()
        .get();
    }

    function attempt(userId: number, quizId: number, score: number, passed: boolean) {
      return testDb
        .insert(schema.quizAttempts)
        .values({ userId, quizId, score, passed })
        .returning()
        .get();
    }

    it("counts only each student's best attempt for score and pass/fail", () => {
      const quiz = createQuiz(base.course.id);
      enrol(base.user.id, base.course.id);
      attempt(base.user.id, quiz.id, 0.4, false);
      attempt(base.user.id, quiz.id, 0.9, true);
      attempt(base.user.id, quiz.id, 0.5, false);

      const row = courseRow(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(row?.averageQuizScore).toBeCloseTo(0.9);
      expect(row?.quizPassRate).toBe(1);
    });

    it("averages best attempts across several quizzes and students", () => {
      const quizA = createQuiz(base.course.id);
      const quizB = createQuiz(base.course.id);
      const second = createUser();
      enrol(base.user.id, base.course.id);
      enrol(second.id, base.course.id);
      // Best per (student, quiz): user/A 0.8 pass, user/B 0.6 fail,
      // second/A 1.0 pass, second/B 0.2 fail.
      attempt(base.user.id, quizA.id, 0.5, false);
      attempt(base.user.id, quizA.id, 0.8, true);
      attempt(base.user.id, quizB.id, 0.6, false);
      attempt(second.id, quizA.id, 1.0, true);
      attempt(second.id, quizB.id, 0.1, false);
      attempt(second.id, quizB.id, 0.2, false);

      // Another course's attempts stay in their own row.
      const other = createCourse(schema.CourseStatus.Archived);
      const otherQuiz = createQuiz(other.id);
      enrol(base.user.id, other.id);
      attempt(base.user.id, otherQuiz.id, 0.3, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      const row = courseRow(analytics, base.course.id);
      expect(row?.averageQuizScore).toBeCloseTo((0.8 + 0.6 + 1.0 + 0.2) / 4);
      expect(row?.quizPassRate).toBeCloseTo(0.5);

      const otherRow = courseRow(analytics, other.id);
      expect(otherRow?.averageQuizScore).toBeCloseTo(0.3);
      expect(otherRow?.quizPassRate).toBe(0);
    });

    it("counts only attempts from users enrolled in the course", () => {
      const quiz = createQuiz(base.course.id);
      enrol(base.user.id, base.course.id);
      attempt(base.user.id, quiz.id, 0.9, true);
      // The instructor trying their own quiz, and a user with no enrolment.
      attempt(base.instructor.id, quiz.id, 0.1, false);
      attempt(createUser().id, quiz.id, 0.2, false);

      const row = courseRow(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(row?.averageQuizScore).toBeCloseTo(0.9);
      expect(row?.quizPassRate).toBe(1);
    });

    it("is null when the only attempts are from unenrolled users", () => {
      const quiz = createQuiz(base.course.id);
      attempt(base.instructor.id, quiz.id, 0.1, false);

      const row = courseRow(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(row?.averageQuizScore).toBeNull();
      expect(row?.quizPassRate).toBeNull();
    });

    it("is null for a course with no quizzes", () => {
      const row = courseRow(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(row?.averageQuizScore).toBeNull();
      expect(row?.quizPassRate).toBeNull();
    });

    it("is null for a course whose quizzes have no attempts", () => {
      createQuiz(base.course.id);

      const row = courseRow(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(row?.averageQuizScore).toBeNull();
      expect(row?.quizPassRate).toBeNull();
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
