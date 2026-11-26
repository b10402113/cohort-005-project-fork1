import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Bell,
  Check,
  GraduationCap,
  MessageSquare,
  Receipt,
  Settings,
  UsersRound,
} from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import type { NotificationViewModel } from "~/lib/notification-feed";
import type { NotificationCategory } from "~/lib/notification-types";
import {
  createNotificationClient,
  type NotificationClient,
  type NotificationClientConfig,
  type NotificationCounts,
} from "~/lib/notification-client";

// ─── Notification Feed ───
// The bell in the sidebar header and the popover it opens: one chronological,
// infinitely scrolling list of the signed-in person's Notifications. Badge
// counts unseen, opening the popover marks them seen. See GLOSSARY.md.

const categoryIcon: Record<NotificationCategory, React.ReactNode> = {
  discussion_questions: <MessageSquare className="size-2.5" />,
  discussion_replies: <MessageSquare className="size-2.5" />,
  refund_updates: <Receipt className="size-2.5" />,
  open_refund_requests: <Receipt className="size-2.5" />,
  seat_claims: <UsersRound className="size-2.5" />,
  enrollments: <GraduationCap className="size-2.5" />,
};

const EMPTY_COUNTS: NotificationCounts = { unseen: 0, unread: 0 };

function CadenceAvatar() {
  return (
    <span className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
      C
    </span>
  );
}

function NotificationRow({
  item,
  onOpen,
  onRead,
}: {
  item: NotificationViewModel;
  onOpen: (item: NotificationViewModel) => void;
  onRead: (id: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent">
      <span className="relative shrink-0">
        {item.isSystem ? (
          <CadenceAvatar />
        ) : (
          <UserAvatar
            name={item.title}
            avatarUrl={item.avatarUrl}
            className={cn("size-9", item.read && "opacity-60")}
          />
        )}
        <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-popover text-muted-foreground ring-1 ring-border">
          {categoryIcon[item.category]}
        </span>
      </span>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="min-w-0 flex-1 text-left"
      >
        <span
          className={cn(
            "block truncate text-sm",
            !item.read && "font-semibold"
          )}
        >
          {item.title}
        </span>
        {item.snippet && (
          <span className="block truncate text-xs text-muted-foreground">
            {item.snippet}
          </span>
        )}
        <span
          className="block text-xs text-muted-foreground"
          suppressHydrationWarning
        >
          {formatRelativeTime(item.createdAt)}
        </span>
      </button>
      {!item.read && (
        <button
          type="button"
          onClick={() => onRead(item.id)}
          aria-label="Mark as read"
          title="Mark as read"
          className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-primary"
        >
          <Check className="size-4" />
        </button>
      )}
    </li>
  );
}

export function NotificationFeed({
  config,
}: {
  config: NotificationClientConfig | null;
}) {
  const [client, setClient] = useState<NotificationClient | null>();
  const [items, setItems] = useState<NotificationViewModel[]>([]);
  const [counts, setCounts] = useState<NotificationCounts>(EMPTY_COUNTS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Swap the client whenever the signed-in person (or their token) changes.
  // Switching users reloads the page, so this mounts fresh with a new token.
  useEffect(() => {
    let active = true;
    if (!config) {
      setClient(null);
      setItems([]);
      setCounts(EMPTY_COUNTS);
      return;
    }

    let teardown: (() => void) | undefined;
    createNotificationClient(config).then((created) => {
      if (!active) {
        return;
      }
      setClient(created);
      if (!created) return;

      teardown = created.subscribe(() => {
        created.counts().then((next) => {
          if (active) setCounts(next);
        });
      });
    });

    return () => {
      active = false;
      teardown?.();
    };
  }, [
    config?.userId,
    config?.userToken,
    config?.feedChannelId,
    config?.publicApiKey,
  ]);

  // First load: newest page, then the store's counts.
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.list().then(async (page) => {
      if (!active) return;
      setItems(page.items);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      const next = await client.counts();
      if (active) setCounts(next);
    });
    return () => {
      active = false;
    };
  }, [client]);

  // Infinite scroll inside the popover, over the vendor cursor.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !client || !open || !hasMore || loadingMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setLoadingMore(true);
      client
        .list(cursor ?? undefined)
        .then((page) => {
          setItems((existing) => {
            const seen = new Set(existing.map((item) => item.id));
            return [
              ...existing,
              ...page.items.filter((item) => !seen.has(item.id)),
            ];
          });
          setCursor(page.cursor);
          setHasMore(page.hasMore);
        })
        .finally(() => setLoadingMore(false));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [client, cursor, hasMore, loadingMore, open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && client) {
      client
        .markSeen()
        .then(() => setCounts((current) => ({ ...current, unseen: 0 })));
    }
  }

  function readOne(id: string) {
    if (!client) return;
    setItems((existing) =>
      existing.map((item) => (item.id === id ? { ...item, read: true } : item))
    );
    setCounts((current) => ({
      ...current,
      unread: Math.max(0, current.unread - 1),
    }));
    client.markRead(id);
  }

  function markAllRead() {
    if (!client) return;
    setItems((existing) => existing.map((item) => ({ ...item, read: true })));
    setCounts((current) => ({ ...current, unread: 0 }));
    client.markAllRead();
  }

  function openItem(item: NotificationViewModel) {
    readOne(item.id);
    if (!item.href) return;
    // A Notification with nowhere to go only marks read and leaves the popover.
    setOpen(false);
    navigate(item.href);
  }

  const badge = counts.unseen > 9 ? "9+" : String(counts.unseen);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={
          counts.unseen > 0
            ? `Notifications, ${counts.unseen} unseen`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {counts.unseen > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Notifications"
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            className="fixed left-56 top-2 z-50 ml-2 flex max-h-[calc(100vh-1rem)] w-[26rem] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Bell className="size-4" />
              <span className="font-semibold">Notifications</span>
              <button
                type="button"
                onClick={markAllRead}
                disabled={counts.unread === 0}
                className="ml-auto text-xs font-medium text-primary hover:underline disabled:opacity-40 disabled:hover:no-underline"
              >
                Mark all as read
              </button>
              <Link
                to="/settings"
                aria-label="Notification settings"
                title="Notification settings"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Settings className="size-4" />
              </Link>
            </div>

            <div className="flex-1 overflow-y-auto">
              {items.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  You're all caught up.
                </p>
              ) : (
                <ul>
                  {items.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      onOpen={openItem}
                      onRead={readOne}
                    />
                  ))}
                </ul>
              )}
              <div
                ref={sentinel}
                className="p-3 text-center text-xs text-muted-foreground"
              >
                {loadingMore
                  ? "Loading…"
                  : !hasMore && items.length > 0 && "That's everything."}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
