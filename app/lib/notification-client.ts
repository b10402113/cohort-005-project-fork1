import type KnockClient from "@knocklabs/client";
import type { Feed, FeedItem, Recipient } from "@knocklabs/client";
import {
  pageHasMore,
  toNotificationViewModel,
  type NotificationData,
  type NotificationViewModel,
} from "~/lib/notification-feed";

// ─── Notification client (browser) ───
// The only module the feed components call. It knows Knock; the components only
// see Cadence view models. The vendor SDK is imported lazily so server
// rendering never loads it. See docs/research/knock-in-app-feed.md.

const PAGE_SIZE = 50;

export type NotificationPage = {
  items: NotificationViewModel[];
  cursor: string | null;
  hasMore: boolean;
};

export type NotificationCounts = {
  unseen: number;
  unread: number;
};

/** What changed in the feed, delivered to the component from the socket. */
export type NotificationChange = {
  items: NotificationViewModel[];
  counts: NotificationCounts;
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
  subscribe(onChange: (change: NotificationChange) => void): () => void;
  /** Drops the feed and closes its connection. Safe to call more than once. */
  dispose(): void;
}

export type NotificationClientConfig = {
  publicApiKey: string;
  feedChannelId: string;
  userId: number;
  userToken: string;
};

// Every store mutation the socket (or our own status changes) can emit. Each
// one hands the component a fresh snapshot, so the list and badge stay in step.
const CHANGE_EVENTS = [
  "items.received.realtime",
  "items.received.page",
  "items.all_seen",
  "items.all_read",
  "items.seen",
  "items.read",
  "items.unread",
  "items.unseen",
  "items.archived",
  "items.unarchived",
  "items.all_archived",
] as const;

function isNotificationData(value: unknown): value is NotificationData {
  return typeof value === "object" && value !== null && "kind" in value;
}

function toData(item: FeedItem): NotificationData | null {
  const data = item.data as unknown;
  return isNotificationData(data) ? data : null;
}

function actorFrom(recipient: Recipient | undefined) {
  if (!recipient || !("name" in recipient)) return null;
  return {
    name: recipient.name ?? "Someone",
    avatarUrl: recipient.avatar ?? null,
  };
}

function toViewModel(item: FeedItem): NotificationViewModel | null {
  const data = toData(item);
  if (!data) return null;
  return toNotificationViewModel({
    id: item.id,
    insertedAt: item.inserted_at,
    read: item.read_at !== null,
    actor: actorFrom(item.actors[0]),
    data,
  });
}

function toViewModels(items: FeedItem[]): NotificationViewModel[] {
  const views: NotificationViewModel[] = [];
  for (const item of items) {
    const view = toViewModel(item);
    if (view) views.push(view);
  }
  return views;
}

function toPage(items: FeedItem[], after: string | null): NotificationPage {
  return {
    items: toViewModels(items),
    cursor: after,
    // A short page ends history even if the vendor still reports a cursor.
    hasMore: pageHasMore(after, items.length, PAGE_SIZE),
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
    page_size: PAGE_SIZE,
  });

  // One socket connection for this person; the store keeps it fresh.
  feed.listenForUpdates();

  function findItem(id: string): FeedItem | undefined {
    return feed.getState().items.find((item) => item.id === id);
  }

  function snapshot(): NotificationChange {
    const { items, metadata } = feed.getState();
    return {
      items: toViewModels(items),
      counts: {
        unseen: metadata.unseen_count,
        unread: metadata.unread_count,
      },
    };
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    // Dispose unbinds the broadcaster and removes the feed; logout drops the
    // socket and HTTP client so switching users leaves nothing open.
    feed.dispose();
    knock.logout();
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
      const handler = () => onChange(snapshot());
      for (const event of CHANGE_EVENTS) {
        feed.on(event, handler);
      }
      return () => {
        for (const event of CHANGE_EVENTS) {
          feed.off(event, handler);
        }
        dispose();
      };
    },

    dispose,
  };
}
