import type KnockClient from "@knocklabs/client";
import type { Feed, FeedItem, Recipient } from "@knocklabs/client";
import {
  toNotificationViewModel,
  type NotificationData,
  type NotificationViewModel,
} from "~/lib/notification-feed";

// ─── Notification client (browser) ───
// The only module the feed components call. It knows Knock; the components only
// see Cadence view models. The vendor SDK is imported lazily so server
// rendering never loads it. See docs/research/knock-in-app-feed.md.

export type NotificationPage = {
  items: NotificationViewModel[];
  cursor: string | null;
  hasMore: boolean;
};

export type NotificationCounts = {
  unseen: number;
  unread: number;
};

export interface NotificationClient {
  list(cursor?: string): Promise<NotificationPage>;
  counts(): Promise<NotificationCounts>;
  /** Bulk, by channel: covers Notifications not yet loaded. */
  markSeen(): Promise<void>;
  markRead(id: string): Promise<void>;
  /** Bulk, by channel: covers Notifications not yet loaded. */
  markAllRead(): Promise<void>;
  /** Registers a change listener; returns the teardown fn. */
  subscribe(onChange: () => void): () => void;
}

export type NotificationClientConfig = {
  publicApiKey: string;
  feedChannelId: string;
  userId: number;
  userToken: string;
};

const CHANGE_EVENTS = [
  "items.received.*",
  "items.all_seen",
  "items.all_read",
  "items.seen",
  "items.read",
] as const;

function toData(item: FeedItem): NotificationData {
  return item.data as unknown as NotificationData;
}

function actorFrom(recipient: Recipient | undefined) {
  if (!recipient || !("name" in recipient)) return null;
  return {
    name: recipient.name ?? "Someone",
    avatarUrl: recipient.avatar ?? null,
  };
}

function toPage(items: FeedItem[], after: string | null): NotificationPage {
  return {
    items: items.map((item) =>
      toNotificationViewModel({
        id: item.id,
        insertedAt: item.inserted_at,
        read: item.read_at !== null,
        actor: actorFrom(item.actors[0]),
        data: toData(item),
      })
    ),
    cursor: after,
    hasMore: after !== null,
  };
}

/**
 * Builds the browser client for one person. Resolves null when the app has no
 * vendor config, so the feed falls back to its empty state.
 */
export async function createNotificationClient(
  config: NotificationClientConfig
): Promise<NotificationClient | null> {
  if (!config.publicApiKey || !config.feedChannelId || !config.userToken) {
    return null;
  }

  const { default: Knock } = await import("@knocklabs/client");
  const knock: KnockClient = new Knock(config.publicApiKey);
  knock.authenticate({ id: String(config.userId) }, config.userToken);
  const feed: Feed = knock.feeds.initialize(config.feedChannelId, {
    page_size: 50,
  });
  feed.listenForUpdates();

  function findItem(id: string): FeedItem | undefined {
    return feed.getState().items.find((item) => item.id === id);
  }

  return {
    async list(cursor) {
      const result = await feed.fetch(cursor ? { after: cursor } : {});
      const entries = result?.data?.entries ?? [];
      const pageInfo = result?.data?.page_info ?? {
        after: null,
        before: null,
        page_size: 0,
      };
      return toPage(entries, pageInfo.after ?? null);
    },

    async counts() {
      // Read the store the list/socket already keeps fresh, rather than
      // fetching: a fetch here would emit a page event and loop our subscriber.
      const { metadata } = feed.getState();
      return { unseen: metadata.unseen_count, unread: metadata.unread_count };
    },

    async markSeen() {
      await feed.markAllAsSeen();
    },

    async markRead(id) {
      const item = findItem(id);
      if (item) await feed.markAsRead(item);
    },

    async markAllRead() {
      await feed.markAllAsRead();
    },

    subscribe(onChange) {
      for (const event of CHANGE_EVENTS) {
        feed.on(event, onChange);
      }
      return () => {
        for (const event of CHANGE_EVENTS) {
          feed.off(event, onChange);
        }
        feed.dispose();
      };
    },
  };
}
