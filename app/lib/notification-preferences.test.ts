import { describe, expect, it } from "vitest";
import { NOTIFICATION_CATEGORIES } from "./notification-types";
import {
  visibleNotificationCategories,
  type NotificationFacts,
} from "./notification-preferences";

const NO_CIRCUMSTANCES: NotificationFacts = {
  hasPurchase: false,
  isTeamAdmin: false,
  isInstructor: false,
  isPlatformAdmin: false,
};

function facts(overrides: Partial<NotificationFacts>): NotificationFacts {
  return { ...NO_CIRCUMSTANCES, ...overrides };
}

describe("visibleNotificationCategories", () => {
  it("shows only Discussion Replies to a Student with no Purchase", () => {
    expect(visibleNotificationCategories(NO_CIRCUMSTANCES)).toEqual([
      "discussion_replies",
    ]);
  });

  it("shows Refund Request updates to anyone with a Purchase", () => {
    expect(
      visibleNotificationCategories(facts({ hasPurchase: true }))
    ).toEqual(["refund_updates", "discussion_replies"]);
  });

  it("shows Seat claims to a Team Admin", () => {
    expect(
      visibleNotificationCategories(facts({ isTeamAdmin: true }))
    ).toEqual(["seat_claims", "discussion_replies"]);
  });

  it("shows Enrollments and Discussion Questions to an Instructor", () => {
    expect(
      visibleNotificationCategories(facts({ isInstructor: true }))
    ).toEqual([
      "enrollments",
      "discussion_questions",
      "discussion_replies",
    ]);
  });

  it("shows Open Refund Requests to a Platform Admin", () => {
    expect(
      visibleNotificationCategories(facts({ isPlatformAdmin: true }))
    ).toEqual(["open_refund_requests", "discussion_replies"]);
  });

  it("shows every category, in a stable order, to someone with all of them", () => {
    const all = facts({
      hasPurchase: true,
      isTeamAdmin: true,
      isInstructor: true,
      isPlatformAdmin: true,
    });

    expect(visibleNotificationCategories(all)).toEqual(NOTIFICATION_CATEGORIES);
  });

  it("keeps its order stable as circumstances are added one at a time", () => {
    const grew = [
      visibleNotificationCategories(facts({ isInstructor: true })),
      visibleNotificationCategories(
        facts({ isInstructor: true, isPlatformAdmin: true })
      ),
      visibleNotificationCategories(
        facts({ isInstructor: true, isPlatformAdmin: true, hasPurchase: true })
      ),
    ];

    for (const categories of grew) {
      const positions = categories.map((category) =>
        NOTIFICATION_CATEGORIES.indexOf(category)
      );
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    }
  });
});
