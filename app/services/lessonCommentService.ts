import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonComments,
  lessons,
  modules,
  courses,
  users,
  UserRole,
  CourseStatus,
} from "~/db/schema";
import { isUserEnrolled } from "~/services/enrollmentService";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

// ─── Lesson Comment Service ───
// Discussion threads on lessons. Top-level comments plus one level of replies.
// - Readable by enrolled students, the course's instructor and admins.
// - Postable on published courses only (archived courses are read-only).
// - No editing. Deleting a comment with replies soft-deletes it to a
//   placeholder; otherwise the row is hard-deleted.
// Uses positional parameters (project convention).

export class CommentError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404
  ) {
    super(message);
    this.name = "CommentError";
  }
}

export type CommentPermissions = {
  canView: boolean;
  canPost: boolean;
  canModerate: boolean;
};

const NO_PERMISSIONS: CommentPermissions = {
  canView: false,
  canPost: false,
  canModerate: false,
};

export type CommentBadge = "instructor" | "admin" | null;

export type LessonCommentView = {
  id: number;
  parentId: number | null;
  body: string;
  createdAt: string;
  deleted: boolean;
  removedByModerator: boolean;
  author: {
    id: number;
    name: string;
    avatarUrl: string | null;
    badge: CommentBadge;
  } | null;
  canDelete: boolean;
};

export type LessonCommentThread = LessonCommentView & {
  replies: LessonCommentView[];
};

function getLessonCourse(lessonId: number) {
  return db
    .select({
      courseId: courses.id,
      instructorId: courses.instructorId,
      status: courses.status,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

function getUserRole(userId: number) {
  return db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get()?.role;
}

/**
 * What the given user may do with comments on a lesson. Drafts have no
 * discussion; archived courses are read-only.
 */
export function getCommentPermissions(
  userId: number | null,
  lessonId: number
): CommentPermissions {
  if (!userId) return NO_PERMISSIONS;

  const course = getLessonCourse(lessonId);
  if (!course || course.status === CourseStatus.Draft) return NO_PERMISSIONS;

  const role = getUserRole(userId);
  if (!role) return NO_PERMISSIONS;

  const canModerate =
    role === UserRole.Admin || course.instructorId === userId;
  const canView = canModerate || isUserEnrolled(userId, course.courseId);

  return {
    canView,
    canPost: canView && course.status === CourseStatus.Published,
    canModerate,
  };
}

export function findComment(commentId: number) {
  return db
    .select()
    .from(lessonComments)
    .where(eq(lessonComments.id, commentId))
    .get();
}

/**
 * All comments on a lesson as threads: top-level newest first, replies oldest
 * first. `viewerId` is used to work out which comments the viewer may delete.
 */
export function getLessonComments(
  lessonId: number,
  viewerId: number | null
): LessonCommentThread[] {
  const course = getLessonCourse(lessonId);
  if (!course) return [];

  const permissions = getCommentPermissions(viewerId, lessonId);

  const rows = db
    .select({
      comment: lessonComments,
      author: {
        id: users.id,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: users.role,
      },
    })
    .from(lessonComments)
    .leftJoin(users, eq(lessonComments.userId, users.id))
    .where(eq(lessonComments.lessonId, lessonId))
    .orderBy(asc(lessonComments.createdAt), asc(lessonComments.id))
    .all();

  const toView = ({
    comment,
    author,
  }: (typeof rows)[number]): LessonCommentView => {
    const deleted = comment.deletedAt !== null;
    const badge: CommentBadge =
      author?.id === course.instructorId
        ? "instructor"
        : author?.role === UserRole.Admin
          ? "admin"
          : null;

    return {
      id: comment.id,
      parentId: comment.parentId,
      body: deleted ? "" : comment.body,
      createdAt: comment.createdAt,
      deleted,
      removedByModerator: deleted && comment.removedByModerator,
      author: author
        ? {
            id: author.id,
            name: author.name,
            avatarUrl: author.avatarUrl,
            badge,
          }
        : null,
      canDelete:
        !deleted &&
        permissions.canView &&
        (permissions.canModerate ||
          (viewerId !== null && comment.userId === viewerId)),
    };
  };

  const threads: LessonCommentThread[] = [];
  const byId = new Map<number, LessonCommentThread>();

  for (const row of rows) {
    if (row.comment.parentId === null) {
      const thread = { ...toView(row), replies: [] };
      threads.push(thread);
      byId.set(thread.id, thread);
    }
  }
  for (const row of rows) {
    if (row.comment.parentId !== null) {
      byId.get(row.comment.parentId)?.replies.push(toView(row));
    }
  }

  return threads.reverse();
}

/** Visible (not deleted) comments and replies on a lesson. */
export function getLessonCommentCount(lessonId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonComments)
    .where(
      and(
        eq(lessonComments.lessonId, lessonId),
        isNull(lessonComments.deletedAt)
      )
    )
    .get();
  return result?.count ?? 0;
}

/**
 * Posts a top-level comment (parentId null) or a reply to a top-level comment.
 */
export function createComment(
  userId: number,
  lessonId: number,
  body: string,
  parentId: number | null
) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new CommentError("Comment can't be empty", 400);
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new CommentError(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
      400
    );
  }

  const permissions = getCommentPermissions(userId, lessonId);
  if (!permissions.canView) {
    throw new CommentError("You don't have access to this discussion", 403);
  }
  if (!permissions.canPost) {
    throw new CommentError("Discussion is closed for this course", 403);
  }

  if (parentId !== null) {
    const parent = findComment(parentId);
    if (!parent || parent.lessonId !== lessonId) {
      throw new CommentError("Comment not found", 404);
    }
    if (parent.parentId !== null) {
      throw new CommentError("You can't reply to a reply", 400);
    }
    if (parent.deletedAt !== null) {
      throw new CommentError("You can't reply to a deleted comment", 400);
    }
  }

  return db
    .insert(lessonComments)
    .values({ lessonId, userId, parentId, body: trimmed })
    .returning()
    .get();
}

/**
 * Deletes a comment as the given user. Authors may delete their own; the
 * course instructor and admins may delete any. A comment with replies becomes
 * a placeholder; anything else is removed outright.
 */
export function deleteComment(userId: number, commentId: number) {
  const comment = findComment(commentId);
  if (!comment || comment.deletedAt !== null) {
    throw new CommentError("Comment not found", 404);
  }

  const permissions = getCommentPermissions(userId, comment.lessonId);
  const isAuthor = comment.userId === userId;
  if (!permissions.canView || (!isAuthor && !permissions.canModerate)) {
    throw new CommentError("You can't delete this comment", 403);
  }

  const replyCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(lessonComments)
      .where(eq(lessonComments.parentId, commentId))
      .get()?.count ?? 0;

  if (replyCount === 0) {
    db.delete(lessonComments).where(eq(lessonComments.id, commentId)).run();
    return { mode: "hard" as const };
  }

  db.update(lessonComments)
    .set({
      body: "",
      deletedAt: new Date().toISOString(),
      removedByModerator: !isAuthor,
    })
    .where(
      and(eq(lessonComments.id, commentId), isNull(lessonComments.deletedAt))
    )
    .run();
  return { mode: "soft" as const };
}
