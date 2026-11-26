import { describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createFakeTransport } from "~/lib/notification-transport.server";
import { syncUserNotifications } from "./notification-users.server";

describe("syncUserNotifications", () => {
  it("syncs the person's identity through the injected transport", async () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const transport = createFakeTransport();

    await syncUserNotifications(db, base.user.id, transport);

    expect(transport.calls.synced).toEqual([
      {
        id: base.user.id,
        name: "Test User",
        email: "test@example.com",
        avatarUrl: null,
      },
    ]);
  });

  it("does nothing when the user does not exist", async () => {
    const db = createTestDb();
    const transport = createFakeTransport();

    await syncUserNotifications(db, 9999, transport);

    expect(transport.calls.synced).toEqual([]);
  });

  it("never fails the caller when the transport throws", async () => {
    const db = createTestDb();
    const base = seedBaseData(db);
    const transport = createFakeTransport();
    transport.syncUser = async () => {
      throw new Error("vendor down");
    };

    await expect(
      syncUserNotifications(db, base.user.id, transport)
    ).resolves.toBeUndefined();
  });
});
