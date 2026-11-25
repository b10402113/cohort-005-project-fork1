import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  createComment,
  deleteComment,
  editComment,
} from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 9, 30, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const mod = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson One", position: 1 })
    .returning()
    .get().id;

  otherLessonId = db
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson Two", position: 2 })
    .returning()
    .get().id;
});

function addLearner(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function getComment(commentId: number) {
  return db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.id, commentId))
    .get();
}

function post(
  userId: number,
  body: string,
  parentId: number | null = null,
  onLesson = lessonId
) {
  return createComment(db, userId, onLesson, parentId, body, NOW);
}

describe("posting a comment", () => {
  it("posts a Discussion Question", () => {
    const result = post(base.user.id, "  How do I start?  ");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.comment).toMatchObject({
      lessonId,
      userId: base.user.id,
      parentId: null,
      body: "How do I start?",
      createdAt: NOW.toISOString(),
      deletedAt: null,
    });
  });

  it("posts a Discussion Reply under a question", () => {
    const question = post(base.user.id, "How do I start?");
    if (!question.ok) throw new Error(question.error);

    const result = post(base.instructor.id, "Start with lesson one.", question.comment.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.comment.parentId).toBe(question.comment.id);
  });

  it("refuses an empty comment", () => {
    expect(post(base.user.id, "   ")).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment cannot be empty",
    });
  });

  it("refuses a comment longer than 5000 characters", () => {
    expect(post(base.user.id, "x".repeat(5001))).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment must be 5000 characters or fewer",
    });
  });

  it("refuses a comment on a lesson that does not exist", () => {
    expect(post(base.user.id, "Hello", null, 9999)).toMatchObject({
      ok: false,
      status: 404,
      error: "Lesson not found",
    });
  });

  it("refuses a reply to a missing parent", () => {
    expect(post(base.user.id, "Hello", 9999)).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment not found",
    });
  });

  it("refuses a reply whose parent is on another lesson", () => {
    const question = post(base.user.id, "Question", null, otherLessonId);
    if (!question.ok) throw new Error(question.error);

    expect(post(base.user.id, "Reply", question.comment.id, lessonId)).toMatchObject(
      {
        ok: false,
        status: 400,
        error: "Parent comment belongs to a different lesson",
      }
    );
  });

  it("refuses a reply to a reply", () => {
    const question = post(base.user.id, "Question");
    if (!question.ok) throw new Error(question.error);
    const reply = post(base.instructor.id, "Reply", question.comment.id);
    if (!reply.ok) throw new Error(reply.error);

    expect(post(base.user.id, "Nested", reply.comment.id)).toMatchObject({
      ok: false,
      status: 400,
      error: "Replies can only be one level deep",
    });
  });
});

describe("editing a comment", () => {
  it("lets the author edit their own comment and marks it edited", () => {
    const posted = post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);

    const result = editComment(
      db,
      posted.comment.id,
      base.user.id,
      "  Second draft  ",
      LATER
    );

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)).toMatchObject({
      body: "Second draft",
      editedAt: LATER.toISOString(),
    });
  });

  it("refuses an edit by someone other than the author", () => {
    const posted = post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);

    expect(
      editComment(db, posted.comment.id, base.instructor.id, "Hijacked", LATER)
    ).toMatchObject({
      ok: false,
      status: 403,
      error: "You can only edit your own comments",
    });
    expect(getComment(posted.comment.id)?.body).toBe("First draft");
  });

  it("refuses an edit once the comment is deleted", () => {
    const posted = post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);
    deleteComment(db, posted.comment.id, base.user.id, false, LATER);

    expect(
      editComment(db, posted.comment.id, base.user.id, "Second draft", LATER)
    ).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment has been deleted",
    });
  });

  it("refuses an edit to a missing comment", () => {
    expect(
      editComment(db, 9999, base.user.id, "Hello", LATER)
    ).toMatchObject({
      ok: false,
      status: 404,
      error: "Comment not found",
    });
  });
});

describe("soft-deleting a comment", () => {
  it("soft-deletes the author's own comment", () => {
    const posted = post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);

    const result = deleteComment(db, posted.comment.id, base.user.id, false, LATER);

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)).toMatchObject({
      deletedAt: LATER.toISOString(),
    });
  });

  it("lets staff delete someone else's comment", () => {
    const posted = post(base.user.id, "Something rude");
    if (!posted.ok) throw new Error(posted.error);

    const result = deleteComment(
      db,
      posted.comment.id,
      base.instructor.id,
      true,
      LATER
    );

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)?.deletedAt).toBe(LATER.toISOString());
  });

  it("refuses a delete by someone who is neither the author nor staff", () => {
    const posted = post(base.user.id, "My comment");
    if (!posted.ok) throw new Error(posted.error);
    const stranger = addLearner("Sam");

    expect(
      deleteComment(db, posted.comment.id, stranger.id, false, LATER)
    ).toMatchObject({
      ok: false,
      status: 403,
      error: "You can only delete your own comments",
    });
    expect(getComment(posted.comment.id)?.deletedAt).toBeNull();
  });

  it("refuses a delete of a missing comment", () => {
    expect(
      deleteComment(db, 9999, base.user.id, true, LATER)
    ).toMatchObject({
      ok: false,
      status: 404,
      error: "Comment not found",
    });
  });

  it("leaves replies readable when their question is deleted", () => {
    const question = post(base.user.id, "Question");
    if (!question.ok) throw new Error(question.error);
    const reply = post(base.instructor.id, "Answer", question.comment.id);
    if (!reply.ok) throw new Error(reply.error);

    deleteComment(db, question.comment.id, base.user.id, false, LATER);

    expect(getComment(question.comment.id)?.deletedAt).toBe(LATER.toISOString());
    expect(getComment(reply.comment.id)).toMatchObject({
      body: "Answer",
      deletedAt: null,
    });
  });
});
