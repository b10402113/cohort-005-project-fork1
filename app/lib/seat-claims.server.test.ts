import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, TeamMemberRole } from "~/db/schema";
import { createFakeTransport } from "~/lib/notification-transport.server";
import { claimSeat } from "./seat-claims.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
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

function createLicence(
  buyerId: number,
  seatCount: number,
  country: string | null = null
) {
  const team = db.insert(schema.teams).values({}).returning().get();
  return createLicenceForTeam(team, buyerId, seatCount, country);
}

function createLicenceForTeam(
  team: typeof schema.teams.$inferSelect,
  buyerId: number,
  seatCount: number,
  country: string | null = null
) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: buyerId,
      courseId: base.course.id,
      amountPaid: 1000 * seatCount,
      country,
    })
    .returning()
    .get();

  const seats = Array.from({ length: seatCount }, (_, index) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${index}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );

  return { team, purchase, seats };
}

function addTeamAdmin(teamId: number, name: string) {
  const user = addLearner(name);
  db.insert(schema.teamMembers)
    .values({ teamId, userId: user.id, role: TeamMemberRole.Admin })
    .run();
  return user;
}

function getSeat(seatId: number) {
  return db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
}

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

describe("claiming a Seat", () => {
  it("claims an available Seat and creates the Enrollment", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 2);

    const result = await claimSeat(db, seats[0].code, base.user.id, "", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
    });
    expect(getSeat(seats[0].id)).toMatchObject({
      redeemedByUserId: base.user.id,
      redeemedAt: NOW.toISOString(),
    });
    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("refuses an unknown coupon", async () => {
    expect(
      await claimSeat(db, "not-a-seat", base.user.id, "", NOW)
    ).toMatchObject({
      ok: false,
      error: "Coupon not found",
    });
  });

  it("refuses a Seat that has already been claimed", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.update(schema.coupons)
      .set({
        redeemedByUserId: addLearner("Ben").id,
        redeemedAt: NOW.toISOString(),
      })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();

    expect(
      await claimSeat(db, seats[0].code, base.user.id, "", NOW)
    ).toMatchObject({
      ok: false,
      error: "Coupon has already been redeemed",
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request", async () => {
    const teamAdmin = addLearner("Priya");
    const { purchase, seats } = createLicence(teamAdmin.id, 1);
    db.insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        status: RefundStatus.Open,
        reason: "Changed my mind.",
        requestedAt: NOW.toISOString(),
      })
      .run();

    expect(
      await claimSeat(db, seats[0].code, base.user.id, "", NOW)
    ).toMatchObject({
      ok: false,
      error: SEAT_ON_HOLD,
    });
    expect(getSeat(seats[0].id)?.redeemedByUserId).toBeNull();
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses a refunded Seat", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.update(schema.coupons)
      .set({ refundedAt: NOW.toISOString() })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();

    expect(
      await claimSeat(db, seats[0].code, base.user.id, "", NOW)
    ).toMatchObject({
      ok: false,
      error: SEAT_REFUNDED,
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses someone already enrolled in the course", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect(
      await claimSeat(db, seats[0].code, base.user.id, "", NOW)
    ).toMatchObject({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(getSeat(seats[0].id)?.redeemedByUserId).toBeNull();
  });

  it("refuses a claim from a different country than the purchaser", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1, "US");

    expect(
      await claimSeat(db, seats[0].code, base.user.id, "IN", NOW)
    ).toMatchObject({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("ignores the country check when the purchase has no country", async () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1, null);

    expect((await claimSeat(db, seats[0].code, base.user.id, "IN", NOW)).ok).toBe(
      true
    );
  });
});

function teamLicence(seatCount: number) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const admin = addTeamAdmin(team.id, "Priya");
  const { purchase, seats } = createLicenceForTeam(
    team,
    admin.id,
    seatCount
  );
  return { team, admin, purchase, seats };
}

function triggeredOfType(
  fake: ReturnType<typeof createFakeTransport>,
  type: string
) {
  return fake.calls.triggered.filter((event) => event.type === type);
}

describe("notifying on a Seat claim", () => {
  it("tells the licence's Team Admin who claimed and how many Seats remain", async () => {
    const fake = createFakeTransport();
    const { admin, seats } = teamLicence(3);

    const result = await claimSeat(
      db,
      seats[0].code,
      base.user.id,
      "",
      NOW,
      fake
    );
    if (!result.ok) throw new Error(result.error);

    expect(triggeredOfType(fake, "seat_claimed")).toEqual([
      {
        type: "seat_claimed",
        category: "seat_claims",
        recipientIds: [admin.id],
        actor: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        data: {
          courseTitle: "Test Course",
          seatsLeft: 2,
          url: "/team",
        },
        idempotencyKey: `seat-claimed:${seats[0].id}`,
      },
    ]);
  });

  it("also fires the Instructor's Enrollment Notification when they opt in", async () => {
    const fake = createFakeTransport({ enrollments: true });
    const { seats } = teamLicence(2);

    const result = await claimSeat(
      db,
      seats[0].code,
      base.user.id,
      "",
      NOW,
      fake
    );
    if (!result.ok) throw new Error(result.error);

    expect(triggeredOfType(fake, "new_enrollment")).toEqual([
      {
        type: "new_enrollment",
        category: "enrollments",
        recipientIds: [base.instructor.id],
        actor: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        data: {
          courseTitle: "Test Course",
          url: `/instructor/${base.course.id}/students`,
        },
        idempotencyKey: `enrollment:${result.enrollment.id}`,
      },
    ]);
  });

  it("sends no Enrollment Notification when the Instructor has opted out", async () => {
    const fake = createFakeTransport();
    const { seats } = teamLicence(2);

    await claimSeat(db, seats[0].code, base.user.id, "", NOW, fake);

    expect(triggeredOfType(fake, "new_enrollment")).toEqual([]);
    expect(triggeredOfType(fake, "seat_claimed")).toHaveLength(1);
  });

  it("sends exactly one Seat Claimed Notification per claim, including the last Seat", async () => {
    const fake = createFakeTransport();
    const { seats } = teamLicence(2);
    const ben = addLearner("Ben");

    await claimSeat(db, seats[0].code, base.user.id, "", NOW, fake);
    await claimSeat(db, seats[1].code, ben.id, "", NOW, fake);

    expect(
      triggeredOfType(fake, "seat_claimed").map((event) => event.idempotencyKey)
    ).toEqual([
      `seat-claimed:${seats[0].id}`,
      `seat-claimed:${seats[1].id}`,
    ]);
  });

  it("still claims the Seat when the transport throws", async () => {
    const fake = createFakeTransport();
    fake.trigger = async () => {
      throw new Error("vendor is down");
    };
    const { seats } = teamLicence(1);

    const result = await claimSeat(
      db,
      seats[0].code,
      base.user.id,
      "",
      NOW,
      fake
    );

    expect(result.ok).toBe(true);
    expect(getSeat(seats[0].id)?.redeemedByUserId).toBe(base.user.id);
    expect(isEnrolled(base.user.id)).toBe(true);
  });
});
