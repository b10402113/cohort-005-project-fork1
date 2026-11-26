import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, enrollments, users } from "~/db/schema";
import {
  getNotificationTransport,
  guardedTransport,
  type NotificationTransport,
  type SyncableUser,
} from "~/lib/notification-transport.server";

// ─── Enrollments ───
// The one way a Student gains a place on a course. Individual Purchases and
// Claimed Seats both call this; a Team Licence grants Seats, not Enrollments,
// so buying one never reaches here.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

type Enrollment = typeof enrollments.$inferSelect;

export type EnrollmentFailure = { ok: false; status: 404 | 409; error: string };
export type EnrollmentResult =
  | { ok: true; enrollment: Enrollment }
  | EnrollmentFailure;

type EnrollmentContext = { courseTitle: string; instructorId: number };

function getEnrollmentContext(
  db: Queryable,
  courseId: number
): EnrollmentContext | undefined {
  return db
    .select({ courseTitle: courses.title, instructorId: courses.instructorId })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
}

function getActor(db: Queryable, userId: number): SyncableUser | null {
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

/**
 * Writes the Enrollment row and nothing else. Kept synchronous so a Seat claim
 * can run it inside its transaction; callers that own the write use
 * `createEnrollment`, which adds the Instructor's Notification afterwards.
 */
export function insertEnrollment(
  db: Queryable,
  userId: number,
  courseId: number,
  now: Date
): EnrollmentResult {
  const existing = db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();

  if (existing) {
    return {
      ok: false,
      status: 409,
      error: "User is already enrolled in this course",
    };
  }

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();

  if (!course) {
    return { ok: false, status: 404, error: "Course not found" };
  }

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId, enrolledAt: now.toISOString() })
    .returning()
    .get();

  return { ok: true, enrollment };
}

/**
 * Tells the course's Instructor a Student enrolled, after the write commits.
 * Enrollments are off by default, so the Instructor's current preference is
 * read through the port before anything is sent; a vendor failure is swallowed
 * so it never fails the Enrollment. Nobody is notified about their own action.
 */
export async function notifyNewEnrollment(
  db: Queryable,
  enrollment: Enrollment,
  transport: NotificationTransport
): Promise<void> {
  const context = getEnrollmentContext(db, enrollment.courseId);
  if (!context) return;
  if (context.instructorId === enrollment.userId) return;

  let enabled: boolean;
  try {
    const preferences = await transport.getPreferences(context.instructorId);
    enabled = preferences.enrollments;
  } catch {
    return;
  }
  if (!enabled) return;

  await guardedTransport(transport).trigger({
    type: "new_enrollment",
    category: "enrollments",
    recipientIds: [context.instructorId],
    actor: getActor(db, enrollment.userId),
    data: {
      courseTitle: context.courseTitle,
      url: `/instructor/${enrollment.courseId}/students`,
    },
    idempotencyKey: `enrollment:${enrollment.id}`,
  });
}

/**
 * Enrolls a Student on a course and notifies its Instructor. Refuses a second
 * Enrollment on the same course and a course that does not exist. Also the
 * path a Lapsed Student re-enrolls through, so it notifies again.
 */
export async function createEnrollment(
  db: Queryable,
  userId: number,
  courseId: number,
  now: Date,
  transport: NotificationTransport = getNotificationTransport()
): Promise<EnrollmentResult> {
  const result = insertEnrollment(db, userId, courseId, now);
  if (!result.ok) return result;

  await notifyNewEnrollment(db, result.enrollment, transport);

  return result;
}
