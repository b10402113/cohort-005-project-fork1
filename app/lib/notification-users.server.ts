import { eq } from "drizzle-orm";
import { users } from "~/db/schema";
import type { Db } from "~/lib/refunds.server";
import {
  getNotificationTransport,
  guardedTransport,
  type NotificationTransport,
} from "~/lib/notification-transport.server";

// ─── User sync ───
// One call every lifecycle point makes (signup, a name change on /settings, an
// admin edit on the Users page, the seed) to put a person's identity into the
// notification vendor. Wrapped so a vendor outage never fails the domain write.

/**
 * Syncs identity and default preferences for one Cadence user. A missing user
 * or a throwing transport is swallowed — callers treat this as fire-and-forget.
 */
export async function syncUserNotifications(
  db: Db,
  userId: number,
  transport: NotificationTransport = getNotificationTransport()
): Promise<void> {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return;

  await guardedTransport(transport).syncUser({
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  });
}
