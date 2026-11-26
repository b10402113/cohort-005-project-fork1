import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "~/lib/notification-types";

// ─── Preference visibility ───
// Which preference switches a person sees, decided by what they are or have
// rather than by a single role: a Student with a Purchase still gets Refund
// Request updates, an Instructor who is also a Platform Admin sees both sets.
// Pure so it can be tested without the database. See GLOSSARY.md.

export type NotificationFacts = {
  hasPurchase: boolean;
  isTeamAdmin: boolean;
  isInstructor: boolean;
  isPlatformAdmin: boolean;
};

/**
 * The categories whose switches a person sees, in the catalogue's stable
 * order. A category that isn't visible keeps its default, so it can appear
 * later — after a first Purchase, say — with nothing written.
 */
export function visibleNotificationCategories(
  facts: NotificationFacts
): NotificationCategory[] {
  return NOTIFICATION_CATEGORIES.filter((category) =>
    canSeeCategory(category, facts)
  );
}

function canSeeCategory(
  category: NotificationCategory,
  facts: NotificationFacts
): boolean {
  switch (category) {
    case "refund_updates":
      return facts.hasPurchase;
    case "open_refund_requests":
      return facts.isPlatformAdmin;
    case "seat_claims":
      return facts.isTeamAdmin;
    case "enrollments":
      return facts.isInstructor;
    case "discussion_questions":
      return facts.isInstructor;
    case "discussion_replies":
      return true;
  }
}
