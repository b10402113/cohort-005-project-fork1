import { describe, expect, it } from "vitest";
import {
  toNotificationViewModel,
  type NotificationData,
  type NotificationEntry,
} from "./notification-feed";

const INSERTED_AT = "2026-11-20T09:30:00.000Z";
const ACTOR = {
  name: "Sarah Chen",
  avatarUrl: "https://example.com/sarah.png",
};

function entry(
  data: NotificationData,
  actor: { name: string; avatarUrl: string | null } | null = ACTOR
): NotificationEntry {
  return {
    id: "msg-1",
    insertedAt: INSERTED_AT,
    read: false,
    actor,
    data,
  };
}

describe("toNotificationViewModel", () => {
  it("renders an approved Refund Request for the buyer", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "refund_approved",
        courseTitle: "Introduction to TypeScript",
        amount: "$79.00",
        decisionNote: "Sorry it wasn't for you.",
        url: "/courses/introduction-to-typescript",
      })
    );

    expect(view).toEqual({
      id: "msg-1",
      category: "refund_updates",
      title: "Your Refund Request was approved",
      snippet:
        "“Sorry it wasn't for you.” · $79.00 for Introduction to TypeScript",
      createdAt: INSERTED_AT,
      read: false,
      avatarUrl: ACTOR.avatarUrl,
      actorName: ACTOR.name,
      isSystem: false,
      href: "/courses/introduction-to-typescript",
    });
  });

  it("renders a declined Refund Request with the ability to ask again", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "refund_declined",
        courseTitle: "Introduction to TypeScript",
        decisionNote: "You finished most of the course.",
        url: "/courses/introduction-to-typescript",
      })
    );

    expect(view.category).toBe("refund_updates");
    expect(view.title).toBe("Your Refund Request was declined");
    expect(view.snippet).toBe(
      "“You finished most of the course.” — you can ask again."
    );
  });

  it("renders a new Open Refund Request for a Platform Admin", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "refund_raised",
        courseTitle: "Introduction to TypeScript",
        amount: "$79.00",
        reason: "Bought the wrong course.",
        requester: "Sarah Chen",
        url: "/admin/refunds",
      })
    );

    expect(view.category).toBe("open_refund_requests");
    expect(view.title).toBe("Sarah Chen requested a $79.00 refund");
    expect(view.snippet).toBe(
      "“Bought the wrong course.” · Introduction to TypeScript"
    );
    expect(view.href).toBe("/admin/refunds");
  });

  it("renders a claimed Seat for the Team Admin", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "seat_claimed",
        courseTitle: "Introduction to TypeScript",
        seatsLeft: 3,
      })
    );

    expect(view.category).toBe("seat_claims");
    expect(view.title).toBe("Sarah Chen claimed a Seat");
    expect(view.snippet).toBe("Introduction to TypeScript · 3 Seats left");
    expect(view.href).toBeUndefined();
  });

  it("renders a new Enrollment for the Instructor", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "new_enrollment",
        courseTitle: "Introduction to TypeScript",
      })
    );

    expect(view.category).toBe("enrollments");
    expect(view.title).toBe(
      "Sarah Chen enrolled in Introduction to TypeScript"
    );
    expect(view.snippet).toBeNull();
  });

  it("renders a new Discussion Question with the lesson and snippet", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "discussion_question",
        snippet: "Why does this not narrow?",
        lessonTitle: "Type narrowing",
        url: "/courses/introduction-to-typescript/lessons/12#comment-4",
      })
    );

    expect(view.category).toBe("discussion_questions");
    expect(view.title).toBe("Sarah Chen asked a question");
    expect(view.snippet).toBe("“Why does this not narrow?” · Type narrowing");
    expect(view.href).toBe(
      "/courses/introduction-to-typescript/lessons/12#comment-4"
    );
  });

  it("renders a Discussion Reply to the question's author", () => {
    const view = toNotificationViewModel(
      entry({
        kind: "discussion_reply",
        snippet: "You need a discriminated union here.",
        lessonTitle: "Type narrowing",
        url: "/courses/introduction-to-typescript/lessons/12#comment-9",
      })
    );

    expect(view.category).toBe("discussion_replies");
    expect(view.title).toBe("Sarah Chen replied to your question");
    expect(view.snippet).toBe(
      "“You need a discriminated union here.” · Type narrowing"
    );
  });

  it("renders the Refund Request confirmation as a system Notification", () => {
    const view = toNotificationViewModel(
      entry(
        {
          kind: "refund_confirmation",
          courseTitle: "Introduction to TypeScript",
          amount: "$79.00",
        },
        null
      )
    );

    expect(view.category).toBe("refund_updates");
    expect(view.title).toBe("We've received your Refund Request");
    expect(view.snippet).toBe(
      "A Platform Admin will review it. $79.00 for Introduction to TypeScript"
    );
    expect(view.avatarUrl).toBeNull();
    expect(view.actorName).toBeNull();
    expect(view.isSystem).toBe(true);
    expect(view.href).toBeUndefined();
  });

  it("falls back to Someone when the actor is missing on an actor Notification", () => {
    const view = toNotificationViewModel(
      entry(
        {
          kind: "discussion_question",
          snippet: "Hello?",
          lessonTitle: "Intro",
        },
        null
      )
    );

    expect(view.title).toBe("Someone asked a question");
    expect(view.actorName).toBeNull();
    expect(view.isSystem).toBe(false);
    expect(view.avatarUrl).toBeNull();
  });
});
