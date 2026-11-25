import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, enrollments } from "~/db/schema";

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

/**
 * Enrolls a Student on a course. Refuses a second Enrollment on the same
 * course and a course that does not exist.
 */
export function createEnrollment(
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
