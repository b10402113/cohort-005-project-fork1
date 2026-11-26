import type {
  NotificationCategory,
  NotificationType,
} from "~/lib/notification-types";

// ─── Notification Feed view models ───
// The pure mapper that turns a vendor feed entry's trigger data into the
// Cadence Notification a person reads. No vendor types and no DOM in here, so
// tests and the client adapter share the same text. See GLOSSARY.md.

export type NotificationKind = NotificationType;

export type NotificationData =
  | {
      kind: "refund_approved";
      courseTitle: string;
      amount: string;
      decisionNote: string | null;
      url?: string;
    }
  | {
      kind: "refund_declined";
      courseTitle: string;
      amount?: string;
      decisionNote: string;
      url?: string;
    }
  | {
      kind: "refund_raised";
      courseTitle: string;
      amount: string;
      reason: string;
      url?: string;
    }
  | {
      kind: "seat_claimed";
      courseTitle: string;
      seatsLeft: number;
      url?: string;
    }
  | { kind: "new_enrollment"; courseTitle: string; url?: string }
  | {
      kind: "discussion_question";
      snippet: string;
      lessonTitle: string;
      url?: string;
    }
  | {
      kind: "discussion_reply";
      snippet: string;
      lessonTitle: string;
      url?: string;
    }
  | {
      kind: "refund_confirmation";
      courseTitle: string;
      amount: string;
      url?: string;
    };

export type NotificationActor = {
  name: string;
  avatarUrl: string | null;
} | null;

export type NotificationEntry = {
  id: string;
  insertedAt: string;
  read: boolean;
  actor: NotificationActor;
  data: NotificationData;
};

export type NotificationViewModel = {
  id: string;
  category: NotificationCategory;
  title: string;
  snippet: string | null;
  createdAt: string;
  read: boolean;
  avatarUrl: string | null;
  actorName: string | null;
  isSystem: boolean;
  href?: string;
};

const CATEGORY: Record<NotificationKind, NotificationCategory> = {
  refund_approved: "refund_updates",
  refund_declined: "refund_updates",
  refund_confirmation: "refund_updates",
  refund_raised: "open_refund_requests",
  seat_claimed: "seat_claims",
  new_enrollment: "enrollments",
  discussion_question: "discussion_questions",
  discussion_reply: "discussion_replies",
};

const SYSTEM_KINDS: ReadonlySet<NotificationKind> = new Set([
  "refund_confirmation",
]);

function quote(text: string): string {
  return `“${text}”`;
}

function join(parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

type Copy = { title: string; snippet: string | null };

function copyFor(data: NotificationData, actorName: string): Copy {
  switch (data.kind) {
    case "refund_approved":
      return {
        title: "Your Refund Request was approved",
        snippet: join([
          data.decisionNote ? quote(data.decisionNote) : null,
          `${data.amount} for ${data.courseTitle}`,
        ]),
      };
    case "refund_declined":
      return {
        title: "Your Refund Request was declined",
        snippet: `${quote(data.decisionNote)} — you can ask again.`,
      };
    case "refund_confirmation":
      return {
        title: "We've received your Refund Request",
        snippet: `A Platform Admin will review it. ${data.amount} for ${data.courseTitle}`,
      };
    case "refund_raised":
      return {
        title: `${actorName} requested a ${data.amount} refund`,
        snippet: join([quote(data.reason), data.courseTitle]),
      };
    case "seat_claimed":
      return {
        title: `${actorName} claimed a Seat`,
        snippet: join([
          data.courseTitle,
          `${data.seatsLeft} ${data.seatsLeft === 1 ? "Seat" : "Seats"} left`,
        ]),
      };
    case "new_enrollment":
      return {
        title: `${actorName} enrolled in ${data.courseTitle}`,
        snippet: null,
      };
    case "discussion_question":
      return {
        title: `${actorName} asked a question`,
        snippet: join([quote(data.snippet), data.lessonTitle]),
      };
    case "discussion_reply":
      return {
        title: `${actorName} replied to your question`,
        snippet: join([quote(data.snippet), data.lessonTitle]),
      };
  }
}

/**
 * Builds the Cadence Notification a person reads from one feed entry. The text
 * is always Cadence's, never the vendor's template.
 */
export function toNotificationViewModel(
  entry: NotificationEntry
): NotificationViewModel {
  const isSystem = SYSTEM_KINDS.has(entry.data.kind);
  const actorName = isSystem ? null : (entry.actor?.name ?? "Someone");
  const copy = copyFor(entry.data, actorName ?? "Someone");
  const href = entry.data.url;

  return {
    id: entry.id,
    category: CATEGORY[entry.data.kind],
    title: copy.title,
    snippet: copy.snippet,
    createdAt: entry.insertedAt,
    read: entry.read,
    avatarUrl: entry.actor?.avatarUrl ?? null,
    actorName: isSystem ? null : (entry.actor?.name ?? null),
    isSystem,
    ...(href ? { href } : {}),
  };
}
