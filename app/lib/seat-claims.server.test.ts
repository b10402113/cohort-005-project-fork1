import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus } from "~/db/schema";
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

  return { purchase, seats };
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
  it("claims an available Seat and creates the Enrollment", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 2);

    const result = claimSeat(db, seats[0].code, base.user.id, "", NOW);

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

  it("refuses an unknown coupon", () => {
    expect(claimSeat(db, "not-a-seat", base.user.id, "", NOW)).toMatchObject({
      ok: false,
      error: "Coupon not found",
    });
  });

  it("refuses a Seat that has already been claimed", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.update(schema.coupons)
      .set({ redeemedByUserId: addLearner("Ben").id, redeemedAt: NOW.toISOString() })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toMatchObject({
      ok: false,
      error: "Coupon has already been redeemed",
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request", () => {
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

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toMatchObject({
      ok: false,
      error: SEAT_ON_HOLD,
    });
    expect(getSeat(seats[0].id)?.redeemedByUserId).toBeNull();
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses a refunded Seat", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.update(schema.coupons)
      .set({ refundedAt: NOW.toISOString() })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toMatchObject({
      ok: false,
      error: SEAT_REFUNDED,
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses someone already enrolled in the course", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toMatchObject({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(getSeat(seats[0].id)?.redeemedByUserId).toBeNull();
  });

  it("refuses a claim from a different country than the purchaser", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1, "US");

    expect(claimSeat(db, seats[0].code, base.user.id, "IN", NOW)).toMatchObject({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("ignores the country check when the purchase has no country", () => {
    const teamAdmin = addLearner("Priya");
    const { seats } = createLicence(teamAdmin.id, 1, null);

    expect(claimSeat(db, seats[0].code, base.user.id, "IN", NOW).ok).toBe(true);
  });
});
