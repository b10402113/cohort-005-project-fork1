import { describe, expect, it } from "vitest";
import {
  createFakeTransport,
  defaultPreferencesFor,
  defaultTransport,
  notificationFeedEnabled,
  guardedTransport,
  hasSecretKey,
  knockTransport,
  noopTransport,
  signNotificationUserToken,
  type KnockClient,
  type NotificationEvent,
  type SyncableUser,
} from "./notification-transport.server";
import { DEFAULT_PREFERENCES } from "./notification-types";

const USER: SyncableUser = {
  id: 7,
  name: "Emma Wilson",
  email: "emma@example.com",
  avatarUrl: "https://example.com/emma.png",
};

const EVENT: NotificationEvent = {
  type: "discussion_reply",
  category: "discussion_replies",
  recipientIds: [12],
  actor: {
    id: 7,
    name: "Emma Wilson",
    email: "emma@example.com",
    avatarUrl: "https://example.com/emma.png",
  },
  data: {
    snippet: "You need a discriminated union here.",
    lessonTitle: "Type narrowing",
    url: "/courses/intro/lessons/3#comment-9",
  },
  idempotencyKey: "comment-reply:9",
};

type TriggerCall = {
  key: string;
  params: {
    recipients: string[];
    actor: {
      id: string;
      name: string;
      email: string;
      avatar: string | null;
    } | null;
    data: Record<string, string | number | boolean | null>;
  };
  options?: { idempotencyKey?: string };
};

function makeKnockClient(
  overrides: {
    categories?: Record<string, boolean | object> | null;
    messages?: { id: string }[];
  } = {}
) {
  const calls = {
    triggered: [] as TriggerCall[],
    updated: [] as { id: string; body: Record<string, unknown> }[],
    preferences: [] as {
      id: string;
      setId: string;
      body: {
        __persistence_strategy__?: string;
        categories?: Record<string, boolean | object>;
      };
    }[],
    listed: [] as Record<string, unknown>[],
    archived: [] as string[],
  };

  const client: KnockClient = {
    workflows: {
      async trigger(key, params, options) {
        calls.triggered.push({ key, params, options });
        return {};
      },
    },
    users: {
      async update(id, body) {
        calls.updated.push({ id, body });
        return {};
      },
      async getPreferences() {
        return { categories: overrides.categories ?? null };
      },
      async setPreferences(id, setId, body) {
        calls.preferences.push({ id, setId, body });
        return {};
      },
    },
    messages: {
      async list(params) {
        calls.listed.push(params);
        return { entries: overrides.messages ?? [] };
      },
      async archive(id) {
        calls.archived.push(id);
        return {};
      },
    },
  };

  return { client, calls };
}

describe("knockTransport.trigger", () => {
  it("triggers the Cadence workflow with recipients, actor, data and idempotency key", async () => {
    const { client, calls } = makeKnockClient();
    const transport = knockTransport(client, "feed-channel");

    await transport.trigger(EVENT);

    expect(calls.triggered).toHaveLength(1);
    const [call] = calls.triggered;
    expect(call.key).toBe("discussion-reply");
    expect(call.params.recipients).toEqual(["12"]);
    expect(call.params.actor).toEqual({
      id: "7",
      name: "Emma Wilson",
      email: "emma@example.com",
      avatar: "https://example.com/emma.png",
    });
    expect(call.params.data).toMatchObject({
      kind: "discussion_reply",
      snippet: "You need a discriminated union here.",
    });
    expect(call.options?.idempotencyKey).toBe("comment-reply:9");
  });
});

describe("knockTransport.syncUser", () => {
  it("writes identity and the default preferences when the user has none", async () => {
    const { client, calls } = makeKnockClient({ categories: null });
    const transport = knockTransport(client, "feed-channel");

    await transport.syncUser(USER);

    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].id).toBe("7");
    expect(calls.updated[0].body).toMatchObject({
      name: "Emma Wilson",
      email: "emma@example.com",
      avatar: "https://example.com/emma.png",
    });
    expect(calls.updated[0].body).not.toHaveProperty("role");

    expect(calls.preferences).toHaveLength(1);
    expect(calls.preferences[0].body).toMatchObject({
      __persistence_strategy__: "merge",
      categories: {
        refund_updates: true,
        open_refund_requests: true,
        seat_claims: true,
        enrollments: false,
        discussion_questions: true,
        discussion_replies: true,
      },
    });
  });

  it("leaves the user's existing preferences alone", async () => {
    const { client, calls } = makeKnockClient({
      categories: { refund_updates: false },
    });
    const transport = knockTransport(client, "feed-channel");

    await transport.syncUser(USER);

    expect(calls.updated).toHaveLength(1);
    expect(calls.preferences).toHaveLength(0);
  });
});

describe("knockTransport.updatePreferences", () => {
  it("merges one category into the existing set", async () => {
    const { client, calls } = makeKnockClient({
      categories: { refund_updates: true, seat_claims: false },
    });
    const transport = knockTransport(client, "feed-channel");

    await transport.updatePreferences(7, { seat_claims: true });

    expect(calls.preferences).toHaveLength(1);
    expect(calls.preferences[0].body).toMatchObject({
      __persistence_strategy__: "merge",
      categories: { refund_updates: true, seat_claims: true },
    });
  });
});

describe("knockTransport.archiveForComment", () => {
  it("archives every message whose trigger data names the comment", async () => {
    const { client, calls } = makeKnockClient({
      messages: [{ id: "msg-1" }, { id: "msg-2" }],
    });
    const transport = knockTransport(client, "feed-channel");

    await transport.archiveForComment(9);

    expect(calls.listed).toHaveLength(1);
    expect(calls.listed[0]).toMatchObject({
      channel_id: "feed-channel",
      trigger_data: JSON.stringify({ commentId: 9 }),
    });
    expect(calls.archived).toEqual(["msg-1", "msg-2"]);
  });

  it("does not call the vendor when there is nothing to archive", async () => {
    const { client, calls } = makeKnockClient({ messages: [] });
    const transport = knockTransport(client, "feed-channel");

    await transport.archiveForComment(9);

    expect(calls.archived).toEqual([]);
  });
});

describe("defaultPreferencesFor", () => {
  it("returns the defaults when the vendor has no categories", () => {
    expect(defaultPreferencesFor(null)).toMatchObject({ enrollments: false });
    expect(defaultPreferencesFor({})).toMatchObject({ enrollments: false });
  });

  it("returns null when the user already has preferences", () => {
    expect(defaultPreferencesFor({ refund_updates: true })).toBeNull();
  });
});

describe("guardedTransport", () => {
  it("swallows a throwing trigger and logs it", async () => {
    const logs: string[] = [];
    const transport = guardedTransport(
      {
        async trigger() {
          throw new Error("vendor down");
        },
        async syncUser() {},
        async getPreferences() {
          return { ...DEFAULT_PREFERENCES };
        },
        async updatePreferences() {},
        async archiveForComment() {},

      },
      (message) => logs.push(message)
    );

    await expect(transport.trigger(EVENT)).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("discussion_reply");
  });

  it("swallows a throwing sync and logs it", async () => {
    const logs: string[] = [];
    const transport = guardedTransport(
      {
        async trigger() {},
        async syncUser() {
          throw new Error("vendor down");
        },
        async getPreferences() {
          return { ...DEFAULT_PREFERENCES };
        },
        async updatePreferences() {},

        async archiveForComment() {},
      },
      (message) => logs.push(message)
    );

    await expect(transport.syncUser(USER)).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
  });
});

describe("no-op fallback", () => {
  it("logs and resolves every call", async () => {
    const logs: string[] = [];
    const transport = noopTransport((message) => logs.push(message));

    await transport.trigger(EVENT);
    await transport.syncUser(USER);
    await transport.updatePreferences(7, { seat_claims: false });
    await transport.archiveForComment(9);

    expect(logs).toHaveLength(4);
  });

  it("is chosen when neither secret key name is set", async () => {
    expect(hasSecretKey({})).toBe(false);
    expect(hasSecretKey({ KNOCK_API_KEY: "" })).toBe(false);
    expect(hasSecretKey({ KNOCK_API_KEY: "sk_test" })).toBe(true);
    expect(hasSecretKey({ KNOCK_SECRET_API_KEY: "sk_test" })).toBe(true);

    const logs: string[] = [];
    const transport = defaultTransport({}, (message) => logs.push(message));
    await transport.trigger(EVENT);
    expect(logs).toHaveLength(1);
  });
});

describe("notificationFeedEnabled", () => {
  it("needs the secret key, the public key and the feed channel", () => {
    const full = {
      KNOCK_API_KEY: "sk_test",
      KNOCK_PUBLIC_API_KEY: "pk_test",
      KNOCK_FEED_CHANNEL_ID: "channel",
    };
    expect(notificationFeedEnabled(full)).toBe(true);
    expect(notificationFeedEnabled({ ...full, KNOCK_API_KEY: undefined })).toBe(
      false
    );
    expect(
      notificationFeedEnabled({ ...full, KNOCK_PUBLIC_API_KEY: undefined })
    ).toBe(false);
    expect(
      notificationFeedEnabled({ ...full, KNOCK_FEED_CHANNEL_ID: undefined })
    ).toBe(false);
  });
});

describe("createFakeTransport", () => {
  it("records every call for services and routes to assert", async () => {
    const fake = createFakeTransport();

    await fake.trigger(EVENT);
    await fake.syncUser(USER);
    await fake.updatePreferences(7, { seat_claims: true });
    await fake.archiveForComment(9);

    expect(fake.calls.triggered).toEqual([EVENT]);
    expect(fake.calls.synced).toEqual([USER]);
    expect(fake.calls.preferences).toEqual([
      { userId: 7, changes: { seat_claims: true } },
    ]);
    expect(fake.calls.archived).toEqual([9]);
  });
});

describe("signNotificationUserToken", () => {
  it("signs a token whose subject is the Cadence user id", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const token = await signNotificationUserToken(42, {
      KNOCK_SIGNING_KEY: privateKey,
    });

    expect(token).toBeTruthy();
    const payload = JSON.parse(
      Buffer.from((token as string).split(".")[1], "base64url").toString()
    );
    expect(payload.sub).toBe("42");
  });

  it("returns null without a signing key", async () => {
    await expect(signNotificationUserToken(42, {})).resolves.toBeNull();
  });
});
