import { describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { DEFAULT_PREFERENCES } from "~/lib/notification-types";
import { createFakeTransport } from "~/lib/notification-transport.server";
import {
  computeNotificationFacts,
  loadNotificationPreferences,
  readNotificationPreferences,
  saveNotificationPreference,
} from "./notification-preferences.server";

describe("readNotificationPreferences", () => {
  it("returns the defaults when the person has no stored preferences", async () => {
    const fake = createFakeTransport();

    await expect(readNotificationPreferences(7, fake)).resolves.toEqual(
      DEFAULT_PREFERENCES
    );
  });
});

describe("saveNotificationPreference", () => {
  it("records exactly one category change", async () => {
    const fake = createFakeTransport();

    await saveNotificationPreference(7, "enrollments", true, fake);

    expect(fake.calls.preferences).toEqual([
      { userId: 7, changes: { enrollments: true } },
    ]);
  });

  it("switches only the flipped category and leaves the others intact", async () => {
    const fake = createFakeTransport({ discussion_replies: false });

    await saveNotificationPreference(7, "enrollments", true, fake);

    await expect(readNotificationPreferences(7, fake)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      discussion_replies: false,
      enrollments: true,
    });
  });

  it("turns a category off without disturbing the rest", async () => {
    const fake = createFakeTransport();

    await saveNotificationPreference(7, "seat_claims", false, fake);

    await expect(readNotificationPreferences(7, fake)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      seat_claims: false,
    });
  });

  it("propagates a save failure so the switch can revert", async () => {
    const fake = createFakeTransport();
    fake.updatePreferences = async () => {
      throw new Error("vendor down");
    };

    await expect(
      saveNotificationPreference(7, "enrollments", true, fake)
    ).rejects.toThrow("vendor down");
  });
});

describe("computeNotificationFacts", () => {
  it("reports a plain Student with no Purchase as having no circumstances", () => {
    const db = createTestDb();
    const base = seedBaseData(db);

    expect(computeNotificationFacts(db, base.user.id)).toEqual({
      hasPurchase: false,
      isTeamAdmin: false,
      isInstructor: false,
      isPlatformAdmin: false,
    });
  });

  it("reports an Instructor as an Instructor", () => {
    const db = createTestDb();
    const base = seedBaseData(db);

    expect(computeNotificationFacts(db, base.instructor.id).isInstructor).toBe(
      true
    );
  });

  it("reports a Platform Admin as a Platform Admin", () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const admin = db
      .insert(schema.users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();

    expect(computeNotificationFacts(db, admin.id).isPlatformAdmin).toBe(true);
  });

  it("reports someone with a Purchase as having one", () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    db.insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
      })
      .run();

    expect(computeNotificationFacts(db, base.user.id).hasPurchase).toBe(true);
  });

  it("reports a Team Admin only when they hold an admin Team Licence membership", () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: base.user.id,
        role: schema.TeamMemberRole.Member,
      })
      .run();

    expect(computeNotificationFacts(db, base.user.id).isTeamAdmin).toBe(false);

    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: base.instructor.id,
        role: schema.TeamMemberRole.Admin,
      })
      .run();

    expect(computeNotificationFacts(db, base.instructor.id).isTeamAdmin).toBe(
      true
    );
  });
});

describe("loadNotificationPreferences", () => {
  it("returns only the visible switches with their current values", async () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const fake = createFakeTransport();

    await expect(
      loadNotificationPreferences(db, base.instructor.id, fake)
    ).resolves.toEqual([
      { category: "enrollments", enabled: false },
      { category: "discussion_questions", enabled: true },
      { category: "discussion_replies", enabled: true },
    ]);
  });

  it("shows a switch that appears later at its default, with nothing written", async () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const fake = createFakeTransport();

    db.insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
      })
      .run();

    const rows = await loadNotificationPreferences(db, base.user.id, fake);

    expect(rows).toContainEqual({ category: "refund_updates", enabled: true });
    expect(fake.calls.preferences).toEqual([]);
  });
});
