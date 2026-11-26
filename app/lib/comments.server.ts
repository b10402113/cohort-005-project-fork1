import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import {
  getNotificationTransport,
  guardedTransport,
  type NotificationActor,
  type NotificationTransport,
} from "~/lib/notification-transport.server";

// ─── Comments ───
// Creating, editing and soft-deleting Discussion Questions and Replies. Both
// the lesson page and the Instructor Questions page call this module, so the
// rules live in one place. See GLOSSARY.md for the language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Comment = typeof comments.$inferSelect;

export type CommentFailure = { ok: false; status: 400 | 403 | 404; error: string };
export type CommentResult = { ok: true; comment: Comment } | CommentFailure;

function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

function lessonExists(db: Db, lessonId: number) {
  return (
    db
      .select({ id: schema.lessons.id })
      .from(schema.lessons)
      .where(eq(schema.lessons.id, lessonId))
      .get() !== undefined
  );
}

const SNIPPET_LIMIT = 140;

/** One line, whitespace collapsed, truncated sensibly with an ellipsis. */
function toSnippet(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SNIPPET_LIMIT) return oneLine;
  return `${oneLine.slice(0, SNIPPET_LIMIT).trimEnd()}…`;
}

type CommentContext = {
  lessonTitle: string;
  courseTitle: string;
  courseSlug: string;
  instructorId: number;
};

function getCommentContext(
  db: Db,
  lessonId: number
): CommentContext | undefined {
  return db
    .select({
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

function getActor(db: Db, userId: number): NotificationActor | null {
  const user = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return user ?? null;
}

function lessonUrl(
  courseSlug: string,
  lessonId: number,
  commentId: number
): string {
  return `/courses/${courseSlug}/lessons/${lessonId}#comment-${commentId}`;
}

type BodyCheck = { ok: true; body: string } | CommentFailure;

function checkBody(body: string): BodyCheck {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    return { ok: false, status: 400, error: "Comment cannot be empty" };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    };
  }
  return { ok: true, body: trimmed };
}

/**
 * Notifies the recipient a Discussion Question or Reply was posted, after the
 * write committed. A throwing transport is swallowed, so a vendor outage never
 * fails the comment. Returns nothing the caller needs.
 */
async function notifyComment(
  db: Db,
  transport: NotificationTransport,
  comment: Comment,
  action: "question" | "reply",
  recipientId: number,
  context: CommentContext
): Promise<void> {
  const actor = getActor(db, comment.userId);
  const url = lessonUrl(context.courseSlug, comment.lessonId, comment.id);

  await guardedTransport(transport).trigger({
    type:
      action === "question" ? "discussion_question" : "discussion_reply",
    category:
      action === "question" ? "discussion_questions" : "discussion_replies",
    recipientIds: [recipientId],
    actor,
    data: {
      commentId: comment.id,
      snippet: toSnippet(comment.body),
      lessonTitle: context.lessonTitle,
      courseTitle: context.courseTitle,
      url,
    },
    idempotencyKey: `comment-${action}:${comment.id}`,
  });
}

/**
 * Posts a top-level Discussion Question when `parentId` is null, or a
 * Discussion Reply under it otherwise. Replies are one level deep and stay on
 * the same lesson as their question.
 *
 * After the write, a Discussion Question notifies the course's Instructor
 * unless they asked it; a Discussion Reply notifies the question's author
 * unless they wrote it.
 */
export async function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date,
  transport: NotificationTransport = getNotificationTransport()
): Promise<CommentResult> {
  const checked = checkBody(body);
  if (!checked.ok) return checked;

  if (!lessonExists(db, lessonId)) {
    return { ok: false, status: 404, error: "Lesson not found" };
  }

  let parent: Comment | undefined;
  if (parentId !== null) {
    parent = getCommentById(db, parentId);
    if (!parent) {
      return { ok: false, status: 404, error: "Parent comment not found" };
    }
    if (parent.lessonId !== lessonId) {
      return {
        ok: false,
        status: 400,
        error: "Parent comment belongs to a different lesson",
      };
    }
    if (parent.parentId !== null) {
      return {
        ok: false,
        status: 400,
        error: "Replies can only be one level deep",
      };
    }
  }

  const comment = db
    .insert(comments)
    .values({
      userId,
      lessonId,
      parentId,
      body: checked.body,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();

  const context = getCommentContext(db, lessonId);
  if (context) {
    if (parent) {
      // Only the Discussion Question's author hears about a Reply, and never
      // when they are the one replying.
      if (parent.userId !== userId) {
        await notifyComment(
          db,
          transport,
          comment,
          "reply",
          parent.userId,
          context
        );
      }
    } else if (context.instructorId !== userId) {
      await notifyComment(
        db,
        transport,
        comment,
        "question",
        context.instructorId,
        context
      );
    }
  }

  return { ok: true, comment };
}

/** Edits a comment the author still owns and that has not been deleted. */
export function editComment(
  db: Db,
  commentId: number,
  userId: number,
  body: string,
  now: Date
): CommentResult {
  const checked = checkBody(body);
  if (!checked.ok) return checked;

  const existing = getCommentById(db, commentId);
  if (!existing) {
    return { ok: false, status: 404, error: "Comment not found" };
  }
  if (existing.deletedAt !== null) {
    return { ok: false, status: 400, error: "Comment has been deleted" };
  }
  if (existing.userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: "You can only edit your own comments",
    };
  }

  const comment = db
    .update(comments)
    .set({ body: checked.body, editedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();

  return { ok: true, comment };
}

/**
 * Soft-deletes a comment. The author may delete their own; staff may delete
 * anyone's. Replies under a deleted question stay readable. Deleting twice is
 * a no-op that returns the already-deleted comment.
 *
 * Archives the Notifications this comment caused, and only those: deleting a
 * Discussion Question leaves its Replies' Notifications alone.
 */
export async function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean,
  now: Date,
  transport: NotificationTransport = getNotificationTransport()
): Promise<CommentResult> {
  const existing = getCommentById(db, commentId);
  if (!existing) {
    return { ok: false, status: 404, error: "Comment not found" };
  }
  if (existing.userId !== userId && !isStaff) {
    return {
      ok: false,
      status: 403,
      error: "You can only delete your own comments",
    };
  }
  if (existing.deletedAt !== null) {
    return { ok: true, comment: existing };
  }

  const comment = db
    .update(comments)
    .set({ deletedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();

  await guardedTransport(transport).archiveForComment(commentId);

  return { ok: true, comment };
}
