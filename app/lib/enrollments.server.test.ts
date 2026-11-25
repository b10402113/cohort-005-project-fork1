import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createEnrollment } from "./enrollments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function findEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, courseId)
      )
    )
    .get();
}

describe("creating an Enrollment", () => {
  it("enrolls a Student on a course at the injected time", () => {
    const result = createEnrollment(db, base.user.id, base.course.id, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
    expect(findEnrollment(base.user.id, base.course.id)).toBeDefined();
  });

  it("refuses a second Enrollment on the same course", () => {
    createEnrollment(db, base.user.id, base.course.id, NOW);

    expect(
      createEnrollment(db, base.user.id, base.course.id, NOW)
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "User is already enrolled in this course",
    });
  });

  it("refuses a course that does not exist", () => {
    expect(createEnrollment(db, base.user.id, 9999, NOW)).toMatchObject({
      ok: false,
      status: 404,
      error: "Course not found",
    });
  });
});
