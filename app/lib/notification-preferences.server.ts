import { and, eq } from "drizzle-orm";
import {
  purchases,
  teamMembers,
  users,
  TeamMemberRole,
  UserRole,
} from "~/db/schema";
import type { Db } from "~/lib/refunds.server";
import {
  type NotificationFacts,
  visibleNotificationCategories,
} from "~/lib/notification-preferences";
import type { NotificationCategory } from "~/lib/notification-types";
import {
  getNotificationTransport,
  getRawNotificationTransport,
  readableTransport,
  type NotificationTransport,
} from "~/lib/notification-transport.server";

// ─── Preferences (server) ───
// Reading and writing a person's category preferences through the notification
// port, so no route ever names the vendor. A save flips exactly one category
// and merges it in, so one switch can never reset another. See GLOSSARY.md.

/**
 * Works out the circumstances that decide which switches a person sees, from
 * the database: a Purchase, an admin Team Licence membership, Instructor, and
 * Platform Admin. Passed to the pure visibility function.
 */
export function computeNotificationFacts(
  db: Db,
  userId: number
): NotificationFacts {
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  const purchase = db
    .select({ id: purchases.id })
    .from(purchases)
    .where(eq(purchases.userId, userId))
    .get();

  const teamAdminMembership = db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  return {
    hasPurchase: purchase !== undefined,
    isTeamAdmin: teamAdminMembership !== undefined,
    isInstructor: user?.role === UserRole.Instructor,
    isPlatformAdmin: user?.role === UserRole.Admin,
  };
}

/**
 * The preference rows the Notifications card renders: the visible categories
 * paired with their current values, in the catalogue's stable order.
 */
export async function loadNotificationPreferences(
  db: Db,
  userId: number,
  transport: NotificationTransport = getNotificationTransport()
): Promise<NotificationPreferenceRow[]> {
  const visible = visibleNotificationCategories(
    computeNotificationFacts(db, userId)
  );
  const values = await readNotificationPreferences(userId, transport);
  return visible.map((category) => ({
    category,
    enabled: values[category],
  }));
}

export type NotificationPreferenceRow = {
  category: NotificationCategory;
  enabled: boolean;
};

/**
 * The person's full preference set, read through the port. Falls back to the
 * defaults when there is no vendor key or the vendor can't be reached, so the
 * Notifications card still renders sensibly.
 */
export async function readNotificationPreferences(
  userId: number,
  transport: NotificationTransport = getNotificationTransport()
): Promise<Record<NotificationCategory, boolean>> {
  return readableTransport(transport).getPreferences(userId);
}

/**
 * Saves one category flip. Calls `updatePreferences` with only that category,
 * so the vendor merges it into the existing set. Throws on failure so the
 * caller can revert the switch and show a toast, which is why it uses the
 * unguarded transport.
 */
export async function saveNotificationPreference(
  userId: number,
  category: NotificationCategory,
  enabled: boolean,
  transport: NotificationTransport = getRawNotificationTransport()
): Promise<void> {
  await transport.updatePreferences(userId, { [category]: enabled });
}
