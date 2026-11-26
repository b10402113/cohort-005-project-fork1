import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createFakeTransport } from "~/lib/notification-transport.server";
import { createEnrollment } from "./enrollments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

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
  it("enrolls a Student on a course at the injected time", async () => {
    const fake = createFakeTransport();
    const result = await createEnrollment(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fake
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
    expect(findEnrollment(base.user.id, base.course.id)).toBeDefined();
  });

  it("refuses a second Enrollment on the same course", async () => {
    const fake = createFakeTransport();
    await createEnrollment(db, base.user.id, base.course.id, NOW, fake);

    expect(
      await createEnrollment(db, base.user.id, base.course.id, NOW, fake)
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "User is already enrolled in this course",
    });
  });

  it("refuses a course that does not exist", async () => {
    const fake = createFakeTransport();
    expect(
      await createEnrollment(db, base.user.id, 9999, NOW, fake)
    ).toMatchObject({
      ok: false,
      status: 404,
      error: "Course not found",
    });
  });
});

describe("notifying the Instructor of a new Enrollment", () => {
  it("tells an opted-in Instructor who enrolled and on which course", async () => {
    const fake = createFakeTransport({ enrollments: true });

    const result = await createEnrollment(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fake
    );
    if (!result.ok) throw new Error(result.error);

    expect(fake.calls.triggered).toEqual([
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

  it("sends nothing while the Instructor has Enrollments turned off", async () => {
    const fake = createFakeTransport();

    await createEnrollment(db, base.user.id, base.course.id, NOW, fake);

    expect(fake.calls.triggered).toEqual([]);
  });

  it("resumes delivery once the Instructor opts in", async () => {
    const fake = createFakeTransport();
    const ben = addLearner("Ben");

    await createEnrollment(db, ben.id, base.course.id, NOW, fake);
    expect(fake.calls.triggered).toEqual([]);

    await fake.updatePreferences(base.instructor.id, { enrollments: true });

    const cara = addLearner("Cara");
    await createEnrollment(db, cara.id, base.course.id, NOW, fake);

    expect(fake.calls.triggered).toHaveLength(1);
    expect(fake.calls.triggered[0]).toMatchObject({
      type: "new_enrollment",
      recipientIds: [base.instructor.id],
      idempotencyKey: expect.stringMatching(/^enrollment:\d+$/),
    });
  });

  it("does not notify the Instructor about their own Enrollment", async () => {
    const fake = createFakeTransport({ enrollments: true });

    await createEnrollment(db, base.instructor.id, base.course.id, NOW, fake);

    expect(fake.calls.triggered).toEqual([]);
  });

  it("notifies again when a Lapsed Student re-enrolls, with a new key", async () => {
    const fake = createFakeTransport({ enrollments: true });

    const first = await createEnrollment(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fake
    );
    if (!first.ok) throw new Error(first.error);

    db.delete(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.userId, base.user.id),
          eq(schema.enrollments.courseId, base.course.id)
        )
      )
      .run();

    const second = await createEnrollment(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fake
    );
    if (!second.ok) throw new Error(second.error);

    expect(fake.calls.triggered.map((event) => event.idempotencyKey)).toEqual([
      `enrollment:${first.enrollment.id}`,
      `enrollment:${second.enrollment.id}`,
    ]);
  });

  it("still creates the Enrollment when the transport throws", async () => {
    const fake = createFakeTransport({ enrollments: true });
    fake.trigger = async () => {
      throw new Error("vendor is down");
    };

    const result = await createEnrollment(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fake
    );

    expect(result.ok).toBe(true);
    expect(findEnrollment(base.user.id, base.course.id)).toBeDefined();
  });
});
