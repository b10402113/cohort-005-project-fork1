import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";

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
 * Posts a top-level Discussion Question when `parentId` is null, or a
 * Discussion Reply under it otherwise. Replies are one level deep and stay on
 * the same lesson as their question.
 */
export function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): CommentResult {
  const checked = checkBody(body);
  if (!checked.ok) return checked;

  if (!lessonExists(db, lessonId)) {
    return { ok: false, status: 404, error: "Lesson not found" };
  }

  if (parentId !== null) {
    const parent = getCommentById(db, parentId);
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
 */
export function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean,
  now: Date
): CommentResult {
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

  return { ok: true, comment };
}
