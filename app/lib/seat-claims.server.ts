import { and, eq } from "drizzle-orm";
import { coupons, enrollments, purchases } from "~/db/schema";
import { getSeatAvailability } from "~/lib/refunds.server";
import { createEnrollment, type Db } from "~/lib/enrollments.server";

// ─── Seat claims ───
// Claiming a Seat on a Team Licence: claim the Seat and create the Student's
// Enrollment in the same step. The redeem-a-Seat route calls this and keeps
// its own access checks.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Enrollment = typeof enrollments.$inferSelect;

const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export type SeatClaimFailure = { ok: false; status: 400; error: string };
export type SeatClaimResult =
  | { ok: true; enrollment: Enrollment }
  | SeatClaimFailure;

function fail(error: string): SeatClaimFailure {
  return { ok: false, status: 400, error };
}

/**
 * Claims the Seat with this code for this Student and creates their Enrollment.
 * Refuses an unknown, already-claimed, on-hold or refunded Seat, a Student who
 * already has an Enrollment on the course, and a claim from outside the
 * purchaser's country.
 */
export function claimSeat(
  db: Db,
  code: string,
  userId: number,
  userCountry: string,
  now: Date
): SeatClaimResult {
  return db.transaction((tx): SeatClaimResult => {
    const coupon = tx
      .select()
      .from(coupons)
      .where(eq(coupons.code, code))
      .get();

    if (!coupon) return fail("Coupon not found");

    if (coupon.redeemedByUserId !== null) {
      return fail("Coupon has already been redeemed");
    }

    const availability = getSeatAvailability(tx, coupon);
    if (availability === "on_hold") return fail(SEAT_ON_HOLD);
    if (availability === "refunded") return fail(SEAT_REFUNDED);

    const existingEnrollment = tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, userId),
          eq(enrollments.courseId, coupon.courseId)
        )
      )
      .get();

    if (existingEnrollment) {
      return fail("You are already enrolled in this course");
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, coupon.purchaseId))
      .get();

    if (purchase?.country && purchase.country !== userCountry) {
      return fail(
        "This coupon can only be redeemed from the same country as the purchaser"
      );
    }

    const enrollment = createEnrollment(tx, userId, coupon.courseId, now);
    if (!enrollment.ok) {
      return fail(enrollment.error);
    }

    tx.update(coupons)
      .set({ redeemedByUserId: userId, redeemedAt: now.toISOString() })
      .where(eq(coupons.id, coupon.id))
      .run();

    return { ok: true, enrollment: enrollment.enrollment };
  });
}
