import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import type { NotificationCategory } from "~/lib/notification-types";

// ─── Notifications card ───
// One switch per visible category, no channel column. Each flip saves on its
// own through the merge-style preference update, optimistically: the switch
// moves at once, and reverts with a toast if the save fails. See GLOSSARY.md.

export const NOTIFICATION_CATEGORY_LABELS: Record<
  NotificationCategory,
  string
> = {
  refund_updates: "Refund Request updates",
  open_refund_requests: "Open Refund Requests",
  seat_claims: "Seat claims",
  enrollments: "Enrollments",
  discussion_questions: "Discussion Questions",
  discussion_replies: "Discussion Replies",
};

export type NotificationPreferenceSwitch = {
  category: NotificationCategory;
  enabled: boolean;
};

type SaveResponse = { ok: boolean; error?: string };

function PreferenceRow({ row }: { row: NotificationPreferenceSwitch }) {
  const [checked, setChecked] = useState(row.enabled);
  const fetcher = useFetcher<SaveResponse>();
  const previous = useRef(row.enabled);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data.ok) return;
    setChecked(previous.current);
    toast.error("Could not save your notification preference. Please try again.");
  }, [fetcher.state, fetcher.data]);

  function toggle(next: boolean) {
    previous.current = checked;
    setChecked(next);
    fetcher.submit(
      {
        intent: "save-notification-preference",
        category: row.category,
        enabled: next ? "true" : "false",
      },
      { method: "post" }
    );
  }

  const label = NOTIFICATION_CATEGORY_LABELS[row.category];

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <Label
        htmlFor={`notification-${row.category}`}
        className="cursor-pointer font-normal"
      >
        {label}
      </Label>
      <Switch
        id={`notification-${row.category}`}
        checked={checked}
        onCheckedChange={toggle}
        aria-label={label}
      />
    </div>
  );
}

export function NotificationPreferencesCard({
  rows,
}: {
  rows: NotificationPreferenceSwitch[];
}) {
  return (
    <Card className="mt-8 max-w-md">
      <CardHeader>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose which Notifications you get in Cadence. Changes save as you
          flip them.
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map((row) => (
          <PreferenceRow key={row.category} row={row} />
        ))}
      </CardContent>
    </Card>
  );
}
