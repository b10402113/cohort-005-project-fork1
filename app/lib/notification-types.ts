// ─── Notification vocabulary ───
// Cadence's names for the things a Notification carries. Shared by the server
// transport, the browser port and the pure feed mapper, so no feature ever
// needs the vendor's vocabulary. See GLOSSARY.md.

/** Where a Notification can be delivered. Email joins this union later. */
export type Channel = "in_app_feed";

/** The 8 Notifications Cadence sends in v1, named as Cadence names them. */
export type NotificationType =
  | "refund_approved"
  | "refund_declined"
  | "refund_raised"
  | "seat_claimed"
  | "new_enrollment"
  | "discussion_question"
  | "discussion_reply"
  | "refund_confirmation";

/** The preference category a Notification belongs to. */
export type NotificationCategory =
  | "refund_updates"
  | "open_refund_requests"
  | "seat_claims"
  | "enrollments"
  | "discussion_questions"
  | "discussion_replies";

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "refund_updates",
  "open_refund_requests",
  "seat_claims",
  "enrollments",
  "discussion_questions",
  "discussion_replies",
];

/** Every category is on by default except Enrollments, which Instructors opt into. */
export const DEFAULT_PREFERENCES: Record<NotificationCategory, boolean> = {
  refund_updates: true,
  open_refund_requests: true,
  seat_claims: true,
  enrollments: false,
  discussion_questions: true,
  discussion_replies: true,
};
