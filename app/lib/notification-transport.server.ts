import Knock, { signUserToken } from "@knocklabs/node";
import {
  DEFAULT_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type Channel,
  type NotificationCategory,
  type NotificationType,
} from "~/lib/notification-types";

// ─── Notification transport (server) ───
// The one seam every Notification hangs off. Cadence services call this with
// Cadence names only; the Knock adapter is the only place that knows the
// vendor. A trigger or sync that throws is caught and logged, so a vendor
// outage never fails the domain write. See docs/research/knock-in-app-feed.md.

export type { Channel, NotificationCategory, NotificationType };

// The Cadence notification type maps to a vendor workflow key only inside the
// adapter. Workflow keys have dashes; Cadence names use underscores.
const WORKFLOW_KEY: Record<NotificationType, string> = {
  refund_approved: "refund-approved",
  refund_declined: "refund-declined",
  refund_raised: "refund-raised",
  refund_confirmation: "refund-confirmation",
  seat_claimed: "seat-claimed",
  new_enrollment: "new-enrollment",
  discussion_question: "discussion-question",
  discussion_reply: "discussion-reply",
};

// Vite doesn't put non-VITE_ vars on process.env, so load .env ourselves. A
// missing .env must not crash local dev or tests.
try {
  process.loadEnvFile(".env");
} catch {}

export type SyncableUser = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
};

export type NotificationActor = SyncableUser;

export type NotificationEventData = Record<
  string,
  string | number | boolean | null
>;

/** The trigger data a Cadence workflow carries, plus the feed-rendering kind. */
export type NotificationEvent = {
  /** The Cadence notification type; the adapter maps it to a workflow key. */
  type: NotificationType;
  category: NotificationCategory;
  recipientIds: number[];
  actor: NotificationActor | null;
  data: NotificationEventData;
  /** One per domain event, so a future retry layer can't duplicate. */
  idempotencyKey: string;
};

export type PreferenceChanges = Partial<Record<NotificationCategory, boolean>>;

export interface NotificationTransport {
  trigger(event: NotificationEvent): Promise<void>;
  syncUser(user: SyncableUser): Promise<void>;
  /** The person's full preference set, with defaults filling any gap. */
  getPreferences(
    userId: number
  ): Promise<Record<NotificationCategory, boolean>>;
  updatePreferences(userId: number, changes: PreferenceChanges): Promise<void>;
  archiveForComment(commentId: number): Promise<void>;
}

export type Log = (message: string) => void;

const logToConsole: Log = (message) => console.error(message);

// ─── Key handling ───

type Env = Record<string, string | undefined>;

/** Accept either the PRD's name or the SDK's default name for the secret key. */
export function secretKey(env: Env): string | undefined {
  return env.KNOCK_SECRET_API_KEY ?? env.KNOCK_API_KEY;
}

export function hasSecretKey(env: Env): boolean {
  const key = secretKey(env);
  return typeof key === "string" && key.length > 0;
}

// ─── Defaults ───

/**
 * The default preference set Cadence writes on sync: every category on except
 * Enrollments. Returns null when the person already has preferences, so sync
 * never overwrites a choice they made.
 */
export function defaultPreferencesFor(
  categories: Record<string, boolean | object> | null | undefined
): Record<NotificationCategory, boolean> | null {
  if (categories && Object.keys(categories).length > 0) return null;
  return { ...DEFAULT_PREFERENCES };
}

function categoryPatch(
  changes: PreferenceChanges
): Partial<Record<NotificationCategory, boolean>> {
  const patch: Partial<Record<NotificationCategory, boolean>> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const value = changes[category];
    if (value !== undefined) patch[category] = value;
  }
  return patch;
}

/**
 * Fills the person's stored categories over the defaults, so a category they
 * never wrote still reads its default. Ignores any non-boolean values the
 * vendor holds (Knock nests per-channel objects).
 */
function preferencesWithDefaults(
  categories: Record<string, boolean | object> | null | undefined
): Record<NotificationCategory, boolean> {
  const preferences: Record<NotificationCategory, boolean> = {
    ...DEFAULT_PREFERENCES,
  };
  for (const category of NOTIFICATION_CATEGORIES) {
    const value = categories?.[category];
    if (typeof value === "boolean") preferences[category] = value;
  }
  return preferences;
}

// ─── Knock adapter ───

type VendorTriggerParams = {
  recipients: string[];
  actor: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  } | null;
  data: NotificationEventData;
};

type VendorPreferenceSet = {
  categories?: Record<string, boolean | object> | null;
};

type VendorMessage = { id: string };

/**
 * The slice of the Knock Node SDK this adapter uses. Narrowed so tests can hand
 * in a fake without the real client or the network.
 */
export interface KnockClient {
  workflows: {
    trigger(
      key: string,
      params: VendorTriggerParams,
      options?: { idempotencyKey?: string }
    ): Promise<unknown>;
  };
  users: {
    update(userId: string, body: Record<string, unknown>): Promise<unknown>;
    getPreferences(userId: string, setId: string): Promise<VendorPreferenceSet>;
    setPreferences(
      userId: string,
      setId: string,
      body: {
        __persistence_strategy__?: "merge" | "replace";
        categories?: Record<string, boolean | object>;
      }
    ): Promise<unknown>;
  };
  messages: {
    list(
      params: Record<string, unknown>
    ): Promise<{ entries: VendorMessage[] }>;
    archive(messageId: string): Promise<unknown>;
  };
}

const PREFERENCE_SET_ID = "default";

function knockUserId(cadenceUserId: number): string {
  return String(cadenceUserId);
}

export function knockTransport(
  client: KnockClient,
  feedChannelId: string
): NotificationTransport {
  return {
    async trigger(event) {
      await client.workflows.trigger(
        WORKFLOW_KEY[event.type],
        {
          recipients: event.recipientIds.map(knockUserId),
          actor: event.actor
            ? {
                id: knockUserId(event.actor.id),
                name: event.actor.name,
                email: event.actor.email,
                avatar: event.actor.avatarUrl,
              }
            : null,
          data: { kind: event.type, ...event.data },
        },
        { idempotencyKey: event.idempotencyKey }
      );
    },

    async syncUser(user) {
      await client.users.update(knockUserId(user.id), {
        name: user.name,
        email: user.email,
        avatar: user.avatarUrl,
      });

      const existing = await client.users.getPreferences(
        knockUserId(user.id),
        PREFERENCE_SET_ID
      );
      const defaults = defaultPreferencesFor(existing.categories);
      if (!defaults) return;

      await client.users.setPreferences(
        knockUserId(user.id),
        PREFERENCE_SET_ID,
        { __persistence_strategy__: "merge", categories: defaults }
      );
    },

    async getPreferences(userId) {
      const existing = await client.users.getPreferences(
        knockUserId(userId),
        PREFERENCE_SET_ID
      );
      return preferencesWithDefaults(existing.categories);
    },

    async updatePreferences(userId, changes) {
      const existing = await client.users.getPreferences(
        knockUserId(userId),
        PREFERENCE_SET_ID
      );

      // Merge, never replace: setPreferences replaces the whole set, so the
      // current categories ride along with the change.
      const categories: Record<string, boolean | object> = {
        ...(existing.categories ?? {}),
        ...categoryPatch(changes),
      };

      await client.users.setPreferences(
        knockUserId(userId),
        PREFERENCE_SET_ID,
        {
          __persistence_strategy__: "merge",
          categories,
        }
      );
    },

    async archiveForComment(commentId) {
      // List the messages whose trigger data names this comment, then archive
      // them. Trigger-data filtering is the documented path.
      const result = await client.messages.list({
        channel_id: feedChannelId,
        trigger_data: JSON.stringify({ commentId }),
      });

      for (const message of result.entries) {
        await client.messages.archive(message.id);
      }
    },
  };
}

// ─── Swallowing wrapper ───

/**
 * Wraps a transport so a throwing trigger or sync is caught and logged instead
 * of failing the domain write. No retries in v1.
 */
export function guardedTransport(
  inner: NotificationTransport,
  log: Log = logToConsole
): NotificationTransport {
  async function guard(
    action: string,
    run: () => Promise<void>
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`[notifications] ${action} failed: ${reason}`);
    }
  }

  return {
    trigger(event) {
      return guard(`trigger ${event.type}`, () => inner.trigger(event));
    },
    syncUser(user) {
      return guard(`sync user ${user.id}`, () => inner.syncUser(user));
    },
    getPreferences(userId) {
      return inner.getPreferences(userId);
    },
    updatePreferences(userId, changes) {
      return guard(`update preferences for user ${userId}`, () =>
        inner.updatePreferences(userId, changes)
      );
    },
    archiveForComment(commentId) {
      return guard(`archive comment ${commentId}`, () =>
        inner.archiveForComment(commentId)
      );
    },
  };
}

// ─── No-op adapter ───

/** Used when no secret key is present: logs each call and does nothing. */
export function noopTransport(log: Log = logToConsole): NotificationTransport {
  return {
    async trigger(event) {
      log(
        `[notifications] no-op trigger ${event.type} for ${event.recipientIds.join(", ")}`
      );
    },
    async syncUser(user) {
      log(`[notifications] no-op sync user ${user.id}`);
    },
    async getPreferences() {
      return { ...DEFAULT_PREFERENCES };
    },
    async updatePreferences(userId) {
      log(`[notifications] no-op update preferences for user ${userId}`);
    },
    async archiveForComment(commentId) {
      log(`[notifications] no-op archive comment ${commentId}`);
    },
  };
}

// ─── In-memory fake ───

export type RecordedPreferences = {
  userId: number;
  changes: PreferenceChanges;
};

export type FakeTransport = NotificationTransport & {
  calls: {
    triggered: NotificationEvent[];
    synced: SyncableUser[];
    preferences: RecordedPreferences[];
    archived: number[];
  };
};

/**
 * Records every call, so services and routes can assert what Cadence sent.
 * Keeps a per-user preference store so a read after a write sees the merge.
 * `seed` is the starting category set every user begins with.
 */
export function createFakeTransport(
  seed: PreferenceChanges = {}
): FakeTransport {
  const calls: FakeTransport["calls"] = {
    triggered: [],
    synced: [],
    preferences: [],
    archived: [],
  };

  const stored = new Map<number, PreferenceChanges>();

  return {
    calls,
    async trigger(event) {
      calls.triggered.push(event);
    },
    async syncUser(user) {
      calls.synced.push(user);
    },
    async getPreferences(userId) {
      return {
        ...DEFAULT_PREFERENCES,
        ...seed,
        ...(stored.get(userId) ?? {}),
      };
    },
    async updatePreferences(userId, changes) {
      calls.preferences.push({ userId, changes });
      stored.set(userId, { ...(stored.get(userId) ?? {}), ...changes });
    },
    async archiveForComment(commentId) {
      calls.archived.push(commentId);
    },
  };
}

/**
 * Wraps a transport for the preference read, falling back to the defaults when
 * the vendor can't be reached. Lets the settings card render sensibly without
 * a vendor key.
 */
export function readableTransport(
  inner: NotificationTransport,
  fallback: Record<NotificationCategory, boolean> = DEFAULT_PREFERENCES
): NotificationTransport {
  return {
    trigger(event) {
      return inner.trigger(event);
    },
    syncUser(user) {
      return inner.syncUser(user);
    },
    async getPreferences(userId) {
      try {
        return await inner.getPreferences(userId);
      } catch {
        return { ...fallback };
      }
    },
    updatePreferences(userId, changes) {
      return inner.updatePreferences(userId, changes);
    },
    archiveForComment(commentId) {
      return inner.archiveForComment(commentId);
    },
  };
}

// ─── Factory ───

let cached: NotificationTransport | undefined;

function buildKnockClient(apiKey: string): KnockClient {
  // The SDK surface the adapter uses is narrowed by KnockClient; the vendor
  // client's full types are wider, so adapt it at this one boundary.
  return new Knock({ apiKey }) as unknown as KnockClient;
}

/**
 * The transport app code uses. With a secret key it is the Knock adapter,
 * otherwise a logging no-op. A throwing trigger or sync is swallowed.
 */
export function defaultTransport(
  env: Env = process.env,
  log: Log = logToConsole
): NotificationTransport {
  const key = secretKey(env);
  if (!key) return guardedTransport(noopTransport(log), log);
  const feedChannelId = env.KNOCK_FEED_CHANNEL_ID ?? "";
  return guardedTransport(
    knockTransport(buildKnockClient(key), feedChannelId),
    log
  );
}

/** The cached transport, built once per process. */
export function getNotificationTransport(): NotificationTransport {
  if (!cached) cached = defaultTransport();
  return cached;
}

let cachedRaw: NotificationTransport | undefined;

/**
 * The transport without the swallowing wrapper, for the one place that must
 * see a failure: a preference save the Notifications card reverts on. Still a
 * no-op without a secret key, so local work needs no vendor.
 */
export function getRawNotificationTransport(
  env: Env = process.env,
  log: Log = logToConsole
): NotificationTransport {
  if (cachedRaw) return cachedRaw;
  const key = secretKey(env);
  cachedRaw = key
    ? knockTransport(
        buildKnockClient(key),
        env.KNOCK_FEED_CHANNEL_ID ?? ""
      )
    : noopTransport(log);
  return cachedRaw;
}

// ─── Per-user signed token ───

/**
 * Mints a signed user token (RS256, sub = Cadence user id) so the browser can
 * read that person's feed. One person's token cannot read another's feed.
 * Returns null without a signing key, so the feed falls back to its empty state.
 */
export async function signNotificationUserToken(
  userId: number,
  env: Env = process.env
): Promise<string | null> {
  const signingKey = env.KNOCK_SIGNING_KEY;
  if (!signingKey) return null;
  return signUserToken(String(userId), {
    signingKey,
    expiresInSeconds: 60 * 60,
  });
}

/** The public config the browser adapter needs; empty strings hide the feed. */
export function notificationClientConfig(env: Env = process.env) {
  return {
    publicApiKey: env.KNOCK_PUBLIC_API_KEY ?? "",
    feedChannelId: env.KNOCK_FEED_CHANNEL_ID ?? "",
  };
}

/**
 * Whether the feed can be shown at all. Without the secret key there is nothing
 * to read (the transport is the no-op), so the feed falls back to its empty
 * state rather than reaching for the vendor.
 */
export function notificationFeedEnabled(env: Env = process.env): boolean {
  const config = notificationClientConfig(env);
  return (
    hasSecretKey(env) &&
    config.publicApiKey.length > 0 &&
    config.feedChannelId.length > 0
  );
}
