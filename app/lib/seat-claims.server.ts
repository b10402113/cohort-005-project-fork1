import { and, eq, isNull } from "drizzle-orm";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teamMembers,
  users,
  TeamMemberRole,
} from "~/db/schema";
import { getSeatAvailability } from "~/lib/refunds.server";
import {
  insertEnrollment,
  notifyNewEnrollment,
  type Db,
} from "~/lib/enrollments.server";
import {
  getNotificationTransport,
  guardedTransport,
  type NotificationTransport,
  type SyncableUser,
} from "~/lib/notification-transport.server";

// ─── Seat claims ───
// Claiming a Seat on a Team Licence: claim the Seat and create the Student's
// Enrollment in the same step. The redeem-a-Seat route calls this and keeps
// its own access checks.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Enrollment = typeof enrollments.$inferSelect;
type Seat = typeof coupons.$inferSelect;

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

/** How many of a Team Licence's Seats are still unclaimed after this claim. */
function seatsLeftOnLicence(db: Db, purchaseId: number): number {
  return db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNull(coupons.redeemedAt))
    )
    .all().length;
}

/**
 * The Team Admin who owns the Team Licence at trigger time. Resolved from the
 * coupon's team, never synced as a role.
 */
function licenceTeamAdminIds(db: Db, teamId: number): number[] {
  return db
    .select({ id: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .all()
    .map((row) => row.id);
}

function getActor(db: Db, userId: number): SyncableUser | null {
  const user = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return user ?? null;
}

function courseTitle(db: Db, courseId: number): string | null {
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  return course?.title ?? null;
}

/**
 * After the claim commits: tell the licence's Team Admin a Seat was claimed,
 * naming the claimant, course and Seats left. Never about the admin's own
 * claim, and one per claim. Then the course's Instructor hears about the new
 * Enrollment. A vendor failure is swallowed, and neither Notification is
 * allowed to block the other.
 */
async function notifySeatClaimed(
  db: Db,
  seat: Seat,
  enrollment: Enrollment,
  claimantId: number,
  transport: NotificationTransport
): Promise<void> {
  const adminIds = licenceTeamAdminIds(db, seat.teamId).filter(
    (id) => id !== claimantId
  );
  const title = courseTitle(db, seat.courseId);

  if (adminIds.length > 0 && title) {
    await guardedTransport(transport).trigger({
      type: "seat_claimed",
      category: "seat_claims",
      recipientIds: adminIds,
      actor: getActor(db, claimantId),
      data: {
        courseTitle: title,
        seatsLeft: seatsLeftOnLicence(db, seat.purchaseId),
        url: "/team",
      },
      idempotencyKey: `seat-claimed:${seat.id}`,
    });
  }

  await notifyNewEnrollment(db, enrollment, transport);
}

/**
 * Claims the Seat with this code for this Student and creates their Enrollment.
 * Refuses an unknown, already-claimed, on-hold or refunded Seat, a Student who
 * already has an Enrollment on the course, and a claim from outside the
 * purchaser's country.
 *
 * After the claim commits, fires #4 for the licence's Team Admin and #5 for the
 * course's Instructor.
 */
export async function claimSeat(
  db: Db,
  code: string,
  userId: number,
  userCountry: string,
  now: Date,
  transport: NotificationTransport = getNotificationTransport()
): Promise<SeatClaimResult> {
  const outcome = db.transaction(
    (
      tx
    ):
      | { ok: true; seat: Seat; enrollment: Enrollment }
      | SeatClaimFailure => {
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

      const enrollment = insertEnrollment(tx, userId, coupon.courseId, now);
      if (!enrollment.ok) return fail(enrollment.error);

      tx.update(coupons)
        .set({ redeemedByUserId: userId, redeemedAt: now.toISOString() })
        .where(eq(coupons.id, coupon.id))
        .run();

      return {
        ok: true,
        seat: coupon,
        enrollment: enrollment.enrollment,
      };
    }
  );

  if (!outcome.ok) return outcome;

  await notifySeatClaimed(
    db,
    outcome.seat,
    outcome.enrollment,
    userId,
    transport
  );

  return { ok: true, enrollment: outcome.enrollment };
}
