import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  createFakeTransport,
  type NotificationTransport,
} from "~/lib/notification-transport.server";
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
  onLesson = lessonId,
  transport?: NotificationTransport
) {
  return createComment(db, userId, onLesson, parentId, body, NOW, transport);
}

describe("posting a comment", () => {
  it("posts a Discussion Question", async () => {
    const result = await post(base.user.id, "  How do I start?  ");

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

  it("posts a Discussion Reply under a question", async () => {
    const question = await post(base.user.id, "How do I start?");
    if (!question.ok) throw new Error(question.error);

    const result = await post(
      base.instructor.id,
      "Start with lesson one.",
      question.comment.id
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.comment.parentId).toBe(question.comment.id);
  });

  it("refuses an empty comment", async () => {
    expect(await post(base.user.id, "   ")).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment cannot be empty",
    });
  });

  it("refuses a comment longer than 5000 characters", async () => {
    expect(await post(base.user.id, "x".repeat(5001))).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment must be 5000 characters or fewer",
    });
  });

  it("refuses a comment on a lesson that does not exist", async () => {
    expect(await post(base.user.id, "Hello", null, 9999)).toMatchObject({
      ok: false,
      status: 404,
      error: "Lesson not found",
    });
  });

  it("refuses a reply to a missing parent", async () => {
    expect(await post(base.user.id, "Hello", 9999)).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment not found",
    });
  });

  it("refuses a reply whose parent is on another lesson", async () => {
    const question = await post(base.user.id, "Question", null, otherLessonId);
    if (!question.ok) throw new Error(question.error);

    expect(
      await post(base.user.id, "Reply", question.comment.id, lessonId)
    ).toMatchObject({
      ok: false,
      status: 400,
      error: "Parent comment belongs to a different lesson",
    });
  });

  it("refuses a reply to a reply", async () => {
    const question = await post(base.user.id, "Question");
    if (!question.ok) throw new Error(question.error);
    const reply = await post(
      base.instructor.id,
      "Reply",
      question.comment.id
    );
    if (!reply.ok) throw new Error(reply.error);

    expect(await post(base.user.id, "Nested", reply.comment.id)).toMatchObject({
      ok: false,
      status: 400,
      error: "Replies can only be one level deep",
    });
  });
});

describe("notifying on a Discussion Question", () => {
  it("notifies the course's Instructor with actor, data and idempotency key", async () => {
    const transport = createFakeTransport();

    const result = await post(
      base.user.id,
      "How do I start?\nIt is not obvious.",
      null,
      lessonId,
      transport
    );
    if (!result.ok) throw new Error(result.error);

    expect(transport.calls.triggered).toEqual([
      {
        type: "discussion_question",
        category: "discussion_questions",
        recipientIds: [base.instructor.id],
        actor: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        data: {
          commentId: result.comment.id,
          snippet: "How do I start? It is not obvious.",
          lessonTitle: "Lesson One",
          courseTitle: "Test Course",
          url: `/courses/test-course/lessons/${lessonId}#comment-${result.comment.id}`,
        },
        idempotencyKey: `comment-question:${result.comment.id}`,
      },
    ]);
  });

  it("does not notify the Instructor when the Instructor asks their own question", async () => {
    const transport = createFakeTransport();

    await post(base.instructor.id, "A note to my students", null, lessonId, transport);

    expect(transport.calls.triggered).toEqual([]);
  });

  it("truncates a long snippet to one line", async () => {
    const transport = createFakeTransport();

    await post(base.user.id, `${"a".repeat(200)}\nsecond line`, null, lessonId, transport);

    const snippet = transport.calls.triggered[0].data.snippet;
    expect(typeof snippet).toBe("string");
    expect(String(snippet)).not.toContain("\n");
    expect(String(snippet).length).toBeLessThanOrEqual(141);
    expect(String(snippet).endsWith("…")).toBe(true);
  });
});

describe("notifying on a Discussion Reply", () => {
  it("notifies only the Discussion Question's author", async () => {
    const transport = createFakeTransport();
    const question = await post(base.user.id, "How do I start?", null, lessonId, transport);
    if (!question.ok) throw new Error(question.error);
    transport.calls.triggered.length = 0;

    const result = await post(
      base.instructor.id,
      "Start with lesson one.",
      question.comment.id,
      lessonId,
      transport
    );
    if (!result.ok) throw new Error(result.error);

    expect(transport.calls.triggered).toEqual([
      {
        type: "discussion_reply",
        category: "discussion_replies",
        recipientIds: [base.user.id],
        actor: {
          id: base.instructor.id,
          name: "Test Instructor",
          email: "instructor@example.com",
          avatarUrl: null,
        },
        data: {
          commentId: result.comment.id,
          snippet: "Start with lesson one.",
          lessonTitle: "Lesson One",
          courseTitle: "Test Course",
          url: `/courses/test-course/lessons/${lessonId}#comment-${result.comment.id}`,
        },
        idempotencyKey: `comment-reply:${result.comment.id}`,
      },
    ]);
  });

  it("does not notify the author when they reply to their own question", async () => {
    const transport = createFakeTransport();
    const question = await post(base.user.id, "How do I start?", null, lessonId, transport);
    if (!question.ok) throw new Error(question.error);
    transport.calls.triggered.length = 0;

    await post(base.user.id, "Adding detail.", question.comment.id, lessonId, transport);

    expect(transport.calls.triggered).toEqual([]);
  });

  it("notifies only the question's author, not everyone in the thread", async () => {
    const other = addLearner("Riley");
    const transport = createFakeTransport();
    const question = await post(base.user.id, "How do I start?", null, lessonId, transport);
    if (!question.ok) throw new Error(question.error);
    transport.calls.triggered.length = 0;

    await post(other.id, "Here is what worked for me.", question.comment.id, lessonId, transport);

    expect(transport.calls.triggered).toHaveLength(1);
    expect(transport.calls.triggered[0].recipientIds).toEqual([base.user.id]);
  });
});

describe("editing a comment", () => {
  it("lets the author edit their own comment and marks it edited", async () => {
    const posted = await post(base.user.id, "First draft");
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

  it("does not trigger or archive any Notification", async () => {
    const transport = createFakeTransport();
    const posted = await post(base.user.id, "First draft", null, lessonId, transport);
    if (!posted.ok) throw new Error(posted.error);
    transport.calls.triggered.length = 0;

    editComment(db, posted.comment.id, base.user.id, "Second draft", LATER);

    expect(transport.calls.triggered).toEqual([]);
    expect(transport.calls.archived).toEqual([]);
  });

  it("refuses an edit by someone other than the author", async () => {
    const posted = await post(base.user.id, "First draft");
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

  it("refuses an edit once the comment is deleted", async () => {
    const posted = await post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);
    await deleteComment(db, posted.comment.id, base.user.id, false, LATER);

    expect(
      editComment(db, posted.comment.id, base.user.id, "Second draft", LATER)
    ).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment has been deleted",
    });
  });

  it("refuses an edit to a missing comment", () => {
    expect(editComment(db, 9999, base.user.id, "Hello", LATER)).toMatchObject({
      ok: false,
      status: 404,
      error: "Comment not found",
    });
  });
});

describe("soft-deleting a comment", () => {
  it("soft-deletes the author's own comment", async () => {
    const posted = await post(base.user.id, "First draft");
    if (!posted.ok) throw new Error(posted.error);

    const result = await deleteComment(
      db,
      posted.comment.id,
      base.user.id,
      false,
      LATER
    );

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)).toMatchObject({
      deletedAt: LATER.toISOString(),
    });
  });

  it("archives the Notifications the comment caused", async () => {
    const transport = createFakeTransport();
    const posted = await post(base.user.id, "First draft", null, lessonId, transport);
    if (!posted.ok) throw new Error(posted.error);

    await deleteComment(db, posted.comment.id, base.user.id, false, LATER, transport);

    expect(transport.calls.archived).toEqual([posted.comment.id]);
  });

  it("leaves replies' Notifications alone when their question is deleted", async () => {
    const transport = createFakeTransport();
    const question = await post(base.user.id, "Question", null, lessonId, transport);
    if (!question.ok) throw new Error(question.error);
    const reply = await post(
      base.instructor.id,
      "Answer",
      question.comment.id,
      lessonId,
      transport
    );
    if (!reply.ok) throw new Error(reply.error);

    await deleteComment(db, question.comment.id, base.user.id, false, LATER, transport);

    expect(transport.calls.archived).toEqual([question.comment.id]);
    expect(transport.calls.archived).not.toContain(reply.comment.id);
  });

  it("archives a reply's own Notifications when the reply is deleted", async () => {
    const transport = createFakeTransport();
    const question = await post(base.user.id, "Question", null, lessonId, transport);
    if (!question.ok) throw new Error(question.error);
    const reply = await post(
      base.instructor.id,
      "Answer",
      question.comment.id,
      lessonId,
      transport
    );
    if (!reply.ok) throw new Error(reply.error);

    await deleteComment(db, reply.comment.id, base.instructor.id, false, LATER, transport);

    expect(transport.calls.archived).toEqual([reply.comment.id]);
  });

  it("lets staff delete someone else's comment", async () => {
    const posted = await post(base.user.id, "Something rude");
    if (!posted.ok) throw new Error(posted.error);

    const result = await deleteComment(
      db,
      posted.comment.id,
      base.instructor.id,
      true,
      LATER
    );

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)?.deletedAt).toBe(LATER.toISOString());
  });

  it("refuses a delete by someone who is neither the author nor staff", async () => {
    const posted = await post(base.user.id, "My comment");
    if (!posted.ok) throw new Error(posted.error);
    const stranger = addLearner("Sam");

    expect(
      await deleteComment(db, posted.comment.id, stranger.id, false, LATER)
    ).toMatchObject({
      ok: false,
      status: 403,
      error: "You can only delete your own comments",
    });
    expect(getComment(posted.comment.id)?.deletedAt).toBeNull();
  });

  it("refuses a delete of a missing comment", async () => {
    expect(await deleteComment(db, 9999, base.user.id, true, LATER)).toMatchObject({
      ok: false,
      status: 404,
      error: "Comment not found",
    });
  });

  it("leaves replies readable when their question is deleted", async () => {
    const question = await post(base.user.id, "Question");
    if (!question.ok) throw new Error(question.error);
    const reply = await post(
      base.instructor.id,
      "Answer",
      question.comment.id
    );
    if (!reply.ok) throw new Error(reply.error);

    await deleteComment(db, question.comment.id, base.user.id, false, LATER);

    expect(getComment(question.comment.id)?.deletedAt).toBe(LATER.toISOString());
    expect(getComment(reply.comment.id)).toMatchObject({
      body: "Answer",
      deletedAt: null,
    });
  });
});

describe("resilience", () => {
  it("still writes the comment when the transport throws", async () => {
    const transport = createFakeTransport();
    transport.trigger = async () => {
      throw new Error("vendor down");
    };

    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "Still saved",
      NOW,
      transport
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(getComment(result.comment.id)?.body).toBe("Still saved");
  });

  it("still deletes the comment when archiving throws", async () => {
    const transport = createFakeTransport();
    const posted = await post(base.user.id, "First draft", null, lessonId, transport);
    if (!posted.ok) throw new Error(posted.error);
    transport.archiveForComment = async () => {
      throw new Error("vendor down");
    };

    const result = await deleteComment(
      db,
      posted.comment.id,
      base.user.id,
      false,
      LATER,
      transport
    );

    expect(result.ok).toBe(true);
    expect(getComment(posted.comment.id)?.deletedAt).toBe(LATER.toISOString());
  });
});
