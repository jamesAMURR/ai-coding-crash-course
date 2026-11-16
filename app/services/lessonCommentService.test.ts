import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the modules pick up our test db
import { enrollUser } from "./enrollmentService";
import {
  CommentError,
  createComment,
  deleteComment,
  findComment,
  getCommentPermissions,
  getLessonCommentCount,
  getLessonComments,
} from "./lessonCommentService";

function createUser(name: string, email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

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

function setCourseStatus(status: schema.CourseStatus) {
  testDb
    .update(schema.courses)
    .set({ status })
    .where(eq(schema.courses.id, base.course.id))
    .run();
}

function expectCommentError(fn: () => unknown, status: number, message?: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CommentError);
    expect((error as CommentError).status).toBe(status);
    if (message) expect((error as CommentError).message).toBe(message);
    return;
  }
  throw new Error("Expected a CommentError to be thrown");
}

describe("lessonCommentService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    lessonId = createLesson(base.course.id).id;
    enrollUser(base.user.id, base.course.id, false, false);
  });

  describe("getCommentPermissions", () => {
    it("lets enrolled students view and post but not moderate", () => {
      expect(getCommentPermissions(base.user.id, lessonId)).toEqual({
        canView: true,
        canPost: true,
        canModerate: false,
      });
    });

    it("gives nothing to logged-out or unenrolled users", () => {
      const outsider = createUser("Out", "out@example.com", schema.UserRole.Student);
      const none = { canView: false, canPost: false, canModerate: false };
      expect(getCommentPermissions(null, lessonId)).toEqual(none);
      expect(getCommentPermissions(outsider.id, lessonId)).toEqual(none);
    });

    it("lets the course instructor and admins moderate without enrolling", () => {
      const admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
      const all = { canView: true, canPost: true, canModerate: true };
      expect(getCommentPermissions(base.instructor.id, lessonId)).toEqual(all);
      expect(getCommentPermissions(admin.id, lessonId)).toEqual(all);
    });

    it("gives other instructors no access unless enrolled", () => {
      const other = createUser("Other", "other@example.com", schema.UserRole.Instructor);
      expect(getCommentPermissions(other.id, lessonId).canView).toBe(false);
    });

    it("hides discussion on draft courses", () => {
      setCourseStatus(schema.CourseStatus.Draft);
      expect(getCommentPermissions(base.user.id, lessonId).canView).toBe(false);
      expect(getCommentPermissions(base.instructor.id, lessonId).canView).toBe(false);
    });

    it("makes archived courses read-only", () => {
      setCourseStatus(schema.CourseStatus.Archived);
      expect(getCommentPermissions(base.user.id, lessonId)).toEqual({
        canView: true,
        canPost: false,
        canModerate: false,
      });
    });
  });

  describe("createComment", () => {
    it("stores a trimmed top-level comment", () => {
      const comment = createComment(base.user.id, lessonId, "  Hello there  ", null);
      expect(comment.body).toBe("Hello there");
      expect(comment.parentId).toBeNull();
      expect(comment.userId).toBe(base.user.id);
    });

    it("rejects empty and over-long comments", () => {
      expectCommentError(() => createComment(base.user.id, lessonId, "   ", null), 400);
      expectCommentError(
        () => createComment(base.user.id, lessonId, "a".repeat(2001), null),
        400
      );
      expect(createComment(base.user.id, lessonId, "a".repeat(2000), null).body).toHaveLength(2000);
    });

    it("rejects users without access", () => {
      const outsider = createUser("Out", "out@example.com", schema.UserRole.Student);
      expectCommentError(() => createComment(outsider.id, lessonId, "Hi", null), 403);
    });

    it("rejects posting on archived courses", () => {
      setCourseStatus(schema.CourseStatus.Archived);
      expectCommentError(
        () => createComment(base.user.id, lessonId, "Hi", null),
        403,
        "Discussion is closed for this course"
      );
    });

    it("allows a reply to a top-level comment", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      const reply = createComment(base.instructor.id, lessonId, "Answer", parent.id);
      expect(reply.parentId).toBe(parent.id);
    });

    it("rejects replying to a reply", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      const reply = createComment(base.instructor.id, lessonId, "Answer", parent.id);
      expectCommentError(
        () => createComment(base.user.id, lessonId, "Thanks", reply.id),
        400,
        "You can't reply to a reply"
      );
    });

    it("rejects replying to a deleted comment", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      createComment(base.instructor.id, lessonId, "Answer", parent.id);
      deleteComment(base.user.id, parent.id);
      expectCommentError(() => createComment(base.user.id, lessonId, "Hi", parent.id), 400);
    });

    it("rejects a parent from a different lesson", () => {
      const otherLesson = createLesson(base.course.id);
      const parent = createComment(base.user.id, otherLesson.id, "Elsewhere", null);
      expectCommentError(() => createComment(base.user.id, lessonId, "Hi", parent.id), 404);
    });
  });

  describe("deleteComment", () => {
    it("hard-deletes a comment with no replies", () => {
      const comment = createComment(base.user.id, lessonId, "Oops", null);
      expect(deleteComment(base.user.id, comment.id)).toEqual({ mode: "hard" });
      expect(findComment(comment.id)).toBeUndefined();
    });

    it("soft-deletes a comment with replies, keeping the replies", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      const reply = createComment(base.instructor.id, lessonId, "Answer", parent.id);

      expect(deleteComment(base.user.id, parent.id)).toEqual({ mode: "soft" });

      const stored = findComment(parent.id);
      expect(stored?.deletedAt).not.toBeNull();
      expect(stored?.body).toBe("");
      expect(stored?.removedByModerator).toBe(false);
      expect(findComment(reply.id)).toBeDefined();
    });

    it("marks removals by the instructor as moderator removals", () => {
      const parent = createComment(base.user.id, lessonId, "Spam", null);
      createComment(base.instructor.id, lessonId, "Reply", parent.id);
      deleteComment(base.instructor.id, parent.id);
      expect(findComment(parent.id)?.removedByModerator).toBe(true);
    });

    it("lets admins delete any comment", () => {
      const admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
      const comment = createComment(base.user.id, lessonId, "Hi", null);
      expect(deleteComment(admin.id, comment.id)).toEqual({ mode: "hard" });
    });

    it("stops students deleting other people's comments", () => {
      const other = createUser("Other", "other@example.com", schema.UserRole.Student);
      enrollUser(other.id, base.course.id, false, false);
      const comment = createComment(base.user.id, lessonId, "Mine", null);
      expectCommentError(() => deleteComment(other.id, comment.id), 403);
    });

    it("still allows deleting on archived courses", () => {
      const comment = createComment(base.user.id, lessonId, "Hi", null);
      setCourseStatus(schema.CourseStatus.Archived);
      expect(deleteComment(base.user.id, comment.id)).toEqual({ mode: "hard" });
    });

    it("leaves an empty placeholder after its last reply is deleted", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      const reply = createComment(base.instructor.id, lessonId, "Answer", parent.id);
      deleteComment(base.user.id, parent.id);
      deleteComment(base.instructor.id, reply.id);
      expect(findComment(parent.id)?.deletedAt).not.toBeNull();
    });

    it("rejects deleting an already-deleted comment", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      createComment(base.instructor.id, lessonId, "Answer", parent.id);
      deleteComment(base.user.id, parent.id);
      expectCommentError(() => deleteComment(base.user.id, parent.id), 404);
    });
  });

  describe("getLessonComments", () => {
    it("orders top-level newest first and replies oldest first", () => {
      const first = createComment(base.user.id, lessonId, "First", null);
      const second = createComment(base.user.id, lessonId, "Second", null);
      createComment(base.instructor.id, lessonId, "Reply A", first.id);
      createComment(base.user.id, lessonId, "Reply B", first.id);

      const threads = getLessonComments(lessonId, base.user.id);

      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]);
      expect(threads[1].replies.map((r) => r.body)).toEqual(["Reply A", "Reply B"]);
    });

    it("badges the course instructor and admins only", () => {
      const admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
      createComment(base.user.id, lessonId, "Student", null);
      createComment(base.instructor.id, lessonId, "Instructor", null);
      createComment(admin.id, lessonId, "Admin", null);

      const badges = Object.fromEntries(
        getLessonComments(lessonId, base.user.id).map((t) => [t.body, t.author?.badge])
      );
      expect(badges).toEqual({ Student: null, Instructor: "instructor", Admin: "admin" });
    });

    it("hides the body of deleted comments and blocks deleting them again", () => {
      const parent = createComment(base.user.id, lessonId, "Secret", null);
      createComment(base.instructor.id, lessonId, "Reply", parent.id);
      deleteComment(base.instructor.id, parent.id);

      const [thread] = getLessonComments(lessonId, base.instructor.id);
      expect(thread.deleted).toBe(true);
      expect(thread.removedByModerator).toBe(true);
      expect(thread.body).toBe("");
      expect(thread.canDelete).toBe(false);
      expect(thread.replies).toHaveLength(1);
    });

    it("works out canDelete for the viewer", () => {
      const other = createUser("Other", "other@example.com", schema.UserRole.Student);
      enrollUser(other.id, base.course.id, false, false);
      createComment(base.user.id, lessonId, "Mine", null);

      expect(getLessonComments(lessonId, base.user.id)[0].canDelete).toBe(true);
      expect(getLessonComments(lessonId, other.id)[0].canDelete).toBe(false);
      expect(getLessonComments(lessonId, base.instructor.id)[0].canDelete).toBe(true);
    });

    it("keeps comments from deleted users with no author", () => {
      const temp = createUser("Temp", "temp@example.com", schema.UserRole.Student);
      enrollUser(temp.id, base.course.id, false, false);
      createComment(temp.id, lessonId, "Bye", null);
      testDb.delete(schema.enrollments).where(eq(schema.enrollments.userId, temp.id)).run();
      testDb.delete(schema.users).where(eq(schema.users.id, temp.id)).run();

      const [thread] = getLessonComments(lessonId, base.user.id);
      expect(thread.body).toBe("Bye");
      expect(thread.author).toBeNull();
    });
  });

  describe("getLessonCommentCount", () => {
    it("counts visible comments and replies only", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      createComment(base.instructor.id, lessonId, "Answer", parent.id);
      createComment(base.user.id, lessonId, "Another", null);
      expect(getLessonCommentCount(lessonId)).toBe(3);

      deleteComment(base.user.id, parent.id);
      expect(getLessonCommentCount(lessonId)).toBe(2);
    });
  });

  describe("cascades", () => {
    it("deletes a lesson's comments along with the lesson", () => {
      const parent = createComment(base.user.id, lessonId, "Question", null);
      createComment(base.instructor.id, lessonId, "Answer", parent.id);
      testDb.delete(schema.lessons).where(eq(schema.lessons.id, lessonId)).run();
      expect(testDb.select().from(schema.lessonComments).all()).toHaveLength(0);
    });
  });
});
