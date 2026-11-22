# Knock as a managed in-app notification feed (primary-source research)

Scope: integrating Knock (https://knock.app) as a fully-managed in-app notification feed into a
server-rendered React app (React Router 8 + TypeScript). Every claim below was read from the cited
URL; anything I could not confirm from a primary source is called out as **undocumented** rather
than guessed.

Sources are official docs at `docs.knock.app` unless noted. The published OpenAPI document
(https://docs.knock.app/openapi.json) and the official SDK source in
https://github.com/knocklabs/javascript were used where the prose docs are thin; those citations
are labelled.

---

## TL;DR — the 5 facts that most constrain the design

1. **You need a backend.** Identifying users (`PUT /v1/users/{user_id}`), triggering workflows
   (`POST /v1/workflows/{key}/trigger`) and signing user tokens all require your **secret key**
   (`sk_*`) or the private signing key. The secret key must never reach the browser.
   (https://docs.knock.app/api-reference/overview, https://docs.knock.app/in-app-ui/security-and-authentication)
2. **The client feed needs a public key + a server-signed JWT user token for production.** Without
   "enhanced security mode" you can ship with only the public key (`pk_*`), but a public key can act
   as any user — docs say enable enhanced security before going live.
   (https://docs.knock.app/in-app-ui/security-and-authentication)
3. **The feed is a client-side, websocket-driven component.** `@knocklabs/react` renders a managed
   feed and receives new messages over Knock's websocket automatically. In an SSR React Router app
   you must mount the providers on the client (the package is `"use client"`), not server-render the
   feed HTML.
   (https://docs.knock.app/in-app-ui/react/feed, https://docs.knock.app/in-app-ui/api-overview,
   https://github.com/knocklabs/javascript/blob/main/packages/react/src/index.ts)
4. **Unread/unseen counts and real-time updates come for free** through the feed store
   (`metadata.unread_count`, `metadata.unseen_count`) and the socket; no extra work beyond mounting
   `KnockProvider` + `KnockFeedProvider` (or the headless hooks).
   (https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notification-store,
   https://docs.knock.app/in-app-ui/api-overview)
5. **Idempotency only exists on the workflow trigger endpoint** — `POST /v1/workflows/{key}/trigger`,
   via an `Idempotency-Key` header, 24-hour window, up to 255 chars. Sending it anywhere else "has no
   effect".
   (https://docs.knock.app/api-reference/overview/idempotent-requests)

---

## 1. Identity / users

**Endpoint.** Identify (create-or-update) one user with `PUT /v1/users/{user_id}`; the user id is the
path parameter and the body carries the properties.
Source: https://docs.knock.app/api-reference/users/update

**Auth header.** All API requests use `Authorization: Bearer <api key>` (secret key server-side).
Source: https://docs.knock.app/api-reference/overview

**Idempotent / upsert.** Yes — identification is an upsert and a merge. The endpoint description says:
"Create or update a user... When you identify an existing user, the system merges the properties you
specify with what is currently set on the user, updating only the fields included in your requests."
The identifying-recipients guide states all identification methods use an upsert approach and merge
existing data. Deep-merge applies to custom properties; existing properties cannot be removed, only
overwritten with `null`.
Sources: https://docs.knock.app/api-reference/users/update,
https://docs.knock.app/managing-recipients/identifying-recipients,
https://docs.knock.app/concepts/users

**Properties you can sync.** Reserved properties: `name`, `email`, `avatar`, `locale`,
`phone_number`, `timezone`, `created_at` (you must set it yourself; Knock leaves it `null`
otherwise). You may also store arbitrary custom key/value properties, and `preferences` and
`channel_data` (keyed by channel id). Custom property payloads are capped at 256 kB (a 422 is returned
if an update would exceed it).
Sources: https://docs.knock.app/managing-recipients/identifying-recipients,
https://docs.knock.app/api-reference/users/update

**User id constraints.** Max 256 characters, cannot contain `/` or `#`, and cannot be changed once set.
Source: https://docs.knock.app/concepts/users

**Repeat calls.** Safe to call repeatedly; each call upserts/merges (see above). Bulk alternative:
`POST /v1/users/bulk/identify`, up to 1,000 users per request, returns a `BulkOperation` (async).
Source: https://docs.knock.app/api-reference/users/bulk/identify

**If you never identify but trigger for that user id.**
- Inline identification means you don't have to pre-identify: a trigger can carry full recipient
  objects and Knock "guarantees that recipients are identified before executing any other action"
  (lazy creation). Passing bare id strings only works for users already identified.
  Source: https://docs.knock.app/managing-recipients/identifying-recipients
- An *actor* that has not been identified produces a specific `actor_missing` error: "You called a
  workflow with an actor that has not yet been identified in Knock."
  Source: https://docs.knock.app/api-reference/overview/error-codes
- Client-side, mounting `KnockProvider` with a `user` object performs inline identification
  automatically (upsert), so the user is created just by rendering the provider.
  Sources: https://docs.knock.app/managing-recipients/identifying-recipients,
  https://docs.knock.app/getting-started/quick-start/nextjs
- Reading the feed for a never-identified user returns an empty feed (not an error): "If the user has
  not yet been identified within Knock, an empty feed will be returned."
  Source: https://docs.knock.app/api-reference/users/feeds/list_items

**Not documented:** the exact behavior/error code when a *recipient* (not actor) id is passed as a
bare string but was never identified, and whether the workflow run silently produces zero messages
versus erroring. The error-code list contains `actor_missing` but no recipient equivalent; the
identification guide implies lazy creation is the intended path. Treat as **undocumented** — verify in
a sandbox before relying on it.

---

## 2. User tokens for the client

**Why.** In "enhanced security mode", clients send the public key **and** a signed user token;
Knock rejects public-key requests that omit a valid token. Enhanced security is **off by default**.
Source: https://docs.knock.app/in-app-ui/security-and-authentication

**How the token is signed.** A JWT signed with your environment's **private signing key** using the
**RS256** algorithm. Required claim: `sub` (the user id). Recommended: `iat` and `exp`. The signing
key is generated in the dashboard under **Platform → API keys** (shown once); it's available as
base-64-encoded PEM (single line, env-var friendly) or PEM. Convention: store it in
`KNOCK_SIGNING_KEY` (the SDK reads this by default).
Source: https://docs.knock.app/in-app-ui/security-and-authentication

**Expiry.** The helper defaults to 3600 seconds and accepts `expiresInSeconds`. Docs advise matching
your session-token lifetime, or short-lived tokens refreshed from the backend; the JS/React clients
expose an `onUserTokenExpiring` callback and you can re-call `authenticate` with a fresh token.
Source: https://docs.knock.app/in-app-ui/security-and-authentication

**Official Node helper.** `@knocklabs/node` exports `signUserToken`, plus `buildUserTokenGrant` and
`Grants` for scoping. It uses `jose` under the hood (CJS projects may need a `jose` v5 override).
Basic usage: `const token = await signUserToken('user-1')`; advanced options include
`expiresInSeconds`, `shouldGenerateJti`, and `grants`.
Sources: https://github.com/knocklabs/knock-node (README § "JWT Token Signing"),
https://docs.knock.app/in-app-ui/security-and-authentication

**What the client requires.** React: `<KnockProvider apiKey={pk} user={{ id }} userToken={jwt}>`.
The client sends the token as the `X-Knock-User-Token` header alongside `Authorization: Bearer <pk>`
(confirmed in SDK source). Missing-token errors are `missing_user_token` /
`missing_jwt_signing_key` / `invalid_user_token`.
Sources: https://docs.knock.app/in-app-ui/security-and-authentication,
https://github.com/knocklabs/javascript/blob/main/packages/client/src/api.ts,
https://docs.knock.app/api-reference/overview/error-codes

**Optional grants.** Tokens can carry UCAN-style `grants` to limit token access (`user/read`,
`user/feed_read`, `user/feed_write`, …), and `explicit_grants: true` to deny everything not granted.
Source: https://docs.knock.app/in-app-ui/security-and-authentication

---

## 3. Feed

**Package + version.** `@knocklabs/react` — npm shows **0.15.1** published ~16 days before this
research; the repo's `packages/react/package.json` currently reads **0.15.2** (unreleased/main). It
pulls in `@knocklabs/client` and `@knocklabs/react-core`. Peer deps: React 17/18/19, react-dom; with
optional peers `next` and `@tanstack/react-router`. Install: `npm install @knocklabs/react` (and
`@knocklabs/node` on the server). The package is marked `"use client"`.
Sources: https://www.npmjs.com/package/@knocklabs/react,
https://github.com/knocklabs/javascript/blob/main/packages/react/package.json,
https://github.com/knocklabs/javascript/blob/main/packages/react/src/index.ts,
https://docs.knock.app/getting-started/quick-start/nextjs

Legacy package `@knocklabs/react-notification-feed` exists; docs point to a migration guide.
Source: https://docs.knock.app/in-app-ui/react/overview

**Providers and props.**
- `KnockProvider` — required `apiKey` (public key); `user` object (`{ id }`); optional `userToken`,
  `host`, `logLevel`, `identificationStrategy` (default `inline`, or `skip`), and `enabled` (default
  `true`; `false` idles the client — no identify, no requests, no websocket — useful to gate on an
  async-loaded token).
  Source: https://docs.knock.app/in-app-ui/react/sdk/components/knock-provider
- `KnockFeedProvider` — required `feedId` (the in-app channel id); optional `colorMode`,
  `defaultFeedOptions` (filters), children.
  Source: https://docs.knock.app/in-app-ui/react/sdk/components/knock-feed-provider

```jsx
import { KnockProvider, KnockFeedProvider, NotificationIconButton, NotificationFeedPopover } from "@knocklabs/react";
import "@knocklabs/react/dist/index.css"; // required CSS unless you restyle
```

Pre-built UI: `NotificationFeed`, `NotificationFeedPopover`, `NotificationIconButton`,
`NotificationFeedContainer`, `NotificationCell`, `UnseenBadge`.
Source: https://docs.knock.app/in-app-ui/react/feed

**Hooks.**
- `useNotifications(knockClient, feedId, options?)` → a `Feed` client (fetch, mark read/seen,
  paginate, listen).
- `useNotificationStore(feedClient, selector?)` → `{ items, metadata, pageInfo, loading,
  networkStatus }`, where `metadata` = `{ total_count, unread_count, unseen_count }`.
- `useKnockClient()`, `useKnockFeed()` (context form), `useAuthenticatedKnockClient()`.
Sources: https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notifications,
https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notification-store,
https://docs.knock.app/in-app-ui/react/headless (index), https://docs.knock.app/in-app-ui/api-overview

**Badge count.** `metadata.unread_count` or `metadata.unseen_count`. Default badge counts **unseen**;
the icon button accepts `badgeCountType="unread"`. Seen vs read are tracked separately (`seen_at`
vs `read_at`); unseen drives default badges.
Sources: https://docs.knock.app/in-app-ui/react/feed, https://docs.knock.app/in-app-ui/feeds/overview,
https://docs.knock.app/send-notifications/message-statuses

**Message list + pagination.** `feedClient.fetch(options)` and
`feedClient.fetchNextPage(options)`; server-side cursor pagination uses `after` / `before` /
`page_size` (default 50, max 50). The store exposes `pageInfo` (`after`, `before`, `page_size`).
`useNotifications` also accepts feed options such as `{ mode: "rich" }` (default is `compact`).
Sources: https://docs.knock.app/in-app-ui/javascript/sdk/feed-client,
https://docs.knock.app/api-reference/users/feeds/list_items,
https://docs.knock.app/api-reference/overview (Pagination), https://docs.knock.app/in-app-ui/react/headless

**Mark read / all read.** Client `Feed` methods: `markAsRead(itemOrItems)`,
`markAllAsRead()`, `markAsSeen`, `markAllAsSeen`, `markAsArchived`, `markAsInteracted`,
`markAsUnread`, etc. All optimistic, and update store metadata. Server equivalents:
`POST /v1/messages/batch/read` with `{ message_ids: [...] }`, or per-message
`PUT /v1/messages/{id}/read`. The pre-built popover marks all items **seen** on open by default; you
can override `onOpen` to mark as read instead.
Sources: https://docs.knock.app/in-app-ui/javascript/sdk/feed-client,
https://docs.knock.app/api-reference/messages, https://docs.knock.app/in-app-ui/react/feed

**Real-time.** Yes, without extra work in the pre-built path. Knock runs a managed websocket; the
client SDK auto-connects, reconnects, and re-fetches on `new-message` events (which carry badge-count
metadata). The headless path must call `feedClient.listenForUpdates()` explicitly. Realtime also
benefits from `defaultFeedOptions` filters (they apply to realtime updates and badge counts too).
Sources: https://docs.knock.app/in-app-ui/api-overview,
https://docs.knock.app/in-app-ui/feeds/socket-behavior,
https://docs.knock.app/in-app-ui/javascript/sdk/feed-client,
https://docs.knock.app/in-app-ui/feeds/filtering-in-app-feeds

**What enables realtime.** An authenticated Knock client (public key [+ user token]) plus the
websocket to Knock's managed service; no server config beyond having an in-app channel. Optional knobs:
`__experimentalCrossBrowserUpdates` (BroadcastChannel) and `auto_manage_socket_connection`.
Source: https://docs.knock.app/in-app-ui/react/feed

---

## 4. Triggering

**Model.** You send notifications by **triggering a workflow**; a workflow's channel steps (e.g. an
in-app feed step) produce the per-recipient messages that appear in the feed. There is no separate
"create in-app message" call in the documented flow — the feed is a view of messages produced by
workflow runs (and broadcasts).
Sources: https://docs.knock.app/send-notifications/triggering-workflows,
https://docs.knock.app/concepts/messages, https://docs.knock.app/in-app-ui/feeds/overview

**Primary endpoint.** `POST /v1/workflows/{key}/trigger`. Body: `key` (path), `recipients` (≤1,000),
`data`, optional `actor`, `tenant`, `cancellation_key`, `settings` (`sandbox_mode`, `skip_delay`).
Returns `{ workflow_run_id }`; runs execute asynchronously. Trigger data has a 10 MB limit.
Sources: https://docs.knock.app/api-reference/workflows/trigger,
https://docs.knock.app/send-notifications/triggering-workflows/api

**A legacy `notify` endpoint also exists.** The published OpenAPI doc includes `POST /v1/notify` with
a body of `{ name, actor, recipients, data?, cancellation_key? }` returning `{ result_id }`, described
as "Triggers a workflow with the given key, actor, recipients, and optional data." It is **not
idempotent** in the spec (`x-idempotent` absent) and is rated at tier 3. The docs' prose only
documents `/v1/workflows/{key}/trigger`, so prefer that; treat `/v1/notify` as legacy/undocumented
in prose.
Sources: https://docs.knock.app/openapi.json (`/v1/notify`),
https://docs.knock.app/send-notifications/triggering-workflows/api

**Idempotency key.** Set an `Idempotency-Key` header on the request. It is a unique string **up to
255 characters**. Retrying with the same key **within 24 hours** returns the same response as the
original. Keys should be random UUIDs or meaningful composites (e.g. `order-placed:user-123:order-456`
or a job-queue job id). **Scope:** only `POST /workflows/:key/trigger` honors it today; on any other
endpoint the header has no effect.
Source: https://docs.knock.app/api-reference/overview/idempotent-requests

**Duplicate / mismatched keys.** Idempotent requests are expected to be identical; Knock returns an
**error** when the incoming parameters don't match the original request for that key. Only `2xx`
responses are cached — 4xx/5xx are not stored, so a retry after a failure re-executes. On a cache hit
the response carries `original-x-request-id` and `idempotent-replayed: true`.
Source: https://docs.knock.app/api-reference/overview/idempotent-requests

**Not documented:** what the idempotency response looks like for a *partial* mismatch (error code /
status), and whether the 24h window is rolling from first request. The docs state the window and the
mismatch-error behavior but not a specific error code.

---

## 5. Environments & keys

**Key types.** Two: **public** (`pk_*`) and **secret** (`sk_*`). Public keys only identify your
account and are safe in client code; secret keys can perform any API request and must stay private.
Any number of each per environment.
Sources: https://docs.knock.app/developer-tools/api-keys, https://docs.knock.app/api-reference/overview

**Isolation.** Every account starts with **production** only; enabling environments adds **development**
and lets you add more (e.g. staging). Each environment has **its own isolated data** (users, tenants,
objects, messages, logs, broadcasts) **and its own API keys**. Users must be re-identified per
environment. Content (workflows, layouts, etc.) is version-controlled and promoted.
Sources: https://docs.knock.app/version-control/environments, https://docs.knock.app/concepts/users

**Conventional env-var names** (from official docs/quick-start):
- `KNOCK_API_KEY` (secret, server) — the `@knocklabs/node` default.
- `KNOCK_PUBLIC_API_KEY` (client/public).
- `KNOCK_FEED_CHANNEL_ID` (the in-app channel id).
- `KNOCK_SIGNING_KEY` (private signing key for user tokens; SDK default lookup).
- Next.js-specific variants seen in the quick-start: `NEXT_PUBLIC_KNOCK_PUBLIC_API_KEY`,
  `NEXT_PUBLIC_KNOCK_FEED_CHANNEL_ID`, plus `KNOCK_API_KEY`.
Sources: https://github.com/knocklabs/knock-node (README usage),
https://docs.knock.app/in-app-ui/security-and-authentication,
https://docs.knock.app/in-app-ui/react/feed, https://docs.knock.app/getting-started/quick-start/nextjs

**Test / sandbox.**
- **Sandbox mode** generates and previews messages **without delivering** to downstream providers;
  sandboxed messages **don't count toward usage**. It is **not supported for the in-app channel**
  (Knock manages in-app delivery; there is no provider to suppress) — it applies to email/SMS/push/chat/
  webhook. You can force it per trigger via `settings.sandbox_mode`.
  Sources: https://docs.knock.app/integrations/overview,
  https://docs.knock.app/manage-your-account/knock-plans,
  https://docs.knock.app/send-notifications/triggering-workflows/api
- The recommended way to test in-app without polluting production is a separate **environment**
  (development) and/or **channel conditions** to gate delivery. The workflow **test runner** sends to a
  chosen test recipient and shows runs/messages.
  Sources: https://docs.knock.app/manage-your-account/knock-plans,
  https://docs.knock.app/integrations/overview, https://docs.knock.app/send-notifications/testing-workflows

**Not documented:** a dedicated "log-only stream" for in-app development beyond environments +
sandbox/conditions. There is a dashboard/API logs feature (30-day retention) but not a delivery-
suppression "test stream" for in-app specifically.

---

## 6. Limits on the free plan (Free, formerly "Developer")

From the official pricing page (https://knock.app/pricing) and plans/usage doc
(https://docs.knock.app/manage-your-account/knock-plans):

- **Messages sent: up to 10,000 / month.** A "message" = one message delivered to one user on one
  channel (in-app + email = 2 messages). Bounced/failed messages and guide views are not counted.
  Over-limit is **not hard-capped** — Knock contacts you about a billing method.
  (https://knock.app/pricing)
- **Guide recipients: up to 500 / month** (unique users seeing an in-app guide). Distinct from feeds.
  (https://knock.app/pricing)
- **Agent credits: up to 500 / month.**
  (https://knock.app/pricing)
- **Stored profiles: unlimited**; **unlimited** workflows, broadcasts, in-app guides, delivery
  channels, team members, and **unlimited in-app feeds per recipient**.
  (https://knock.app/pricing)
- **MAU / notified-recipient limit:** Free is **message-metered**, not recipient-metered. "Monthly
  notified user pricing" is an **Enterprise** option only; there is no separate Free MAU cap. There is
  **no limit on stored recipients** in Knock (FAQ: "there's no limit on the number of recipients").
  (https://knock.app/pricing, https://docs.knock.app/concepts/recipients)
- **In-app feed message retention: Unlimited** per the pricing table ("Feed retention … No limit, but
  can be configured"). This is corroborated by the data-retention doc: in-app feed notifications
  "are available indefinitely" and the Feeds API is not subject to the message-log retention policy
  (which is 30 days for non-Enterprise / 90 days for Enterprise, and applies to message logs, not
  feed items).
  (https://knock.app/pricing, https://docs.knock.app/manage-your-account/data-retention,
  https://docs.knock.app/concepts/messages)

**Caveat:** the pricing page currently labels the entry plan "Free" and the plans doc notes it was
"formerly known as our Developer plan". Numbers above are the current published ones; verify at
signup since pricing can change.

---

## 7. Broadcast

**Yes — one announcement to many users, without per-user loops.** Broadcasts are one-time,
cross-channel sends built on the workflow engine; you target either an **audience**, **all users in an
environment**, or a **CSV** upload of users. Knock fans out to each user itself.
Source: https://docs.knock.app/concepts/broadcasts

Important constraints:
- **Broadcasts are not callable via the API** (FAQ: "No, broadcasts are not callable via the API.").
  They are created/sent in the dashboard (or managed via the Knock CLI for definitions). So
  "announce to all users from app code" is not a documented API path.
  Source: https://docs.knock.app/concepts/broadcasts
- Broadcasts are **environment-specific** and not versioned/promoted; you can clone them across
  environments.
  Source: https://docs.knock.app/concepts/broadcasts
- Users **must exist in Knock**; CSV upload can upsert them (max 100 MB CSV). Broadcasts respect
  preferences and can be scheduled or tested.
  Source: https://docs.knock.app/concepts/broadcasts
- For an API-driven fan-out, the documented mechanism is triggering a workflow with up to **1,000
  recipients per call** (pass an array), or modeling the audience as object **subscriptions** so Knock
  resolves recipients. There is **no documented "trigger workflow for an audience"** API.
  Sources: https://docs.knock.app/send-notifications/triggering-workflows/api,
  https://docs.knock.app/concepts/recipients

**Not documented:** any REST endpoint to create/send a broadcast programmatically (Management API is
for definitions, not sending). If "send announcement to all users from our app" is a hard requirement,
that is a gap.

---

## Open questions / not found in docs

1. **Recipient-not-identified behavior.** Only `actor_missing` is documented. What happens when a
   bare user-id string recipient was never identified (skip vs error vs zero messages) is not
   documented — verify in a sandbox.
2. **Idempotency mismatch error code.** Docs say mismatched params return "an error" but do not name
   the code/status; window semantics (fixed vs rolling 24h) not specified.
3. **Broadcast via API.** Explicitly not supported today; no programmatic send endpoint documented.
4. **SSR specifics for React Router.** Docs cover Next.js and a `@tanstack/react-router` adapter path
   (`@knocklabs/react/tanstack`), but there is no React Router 8-specific guide. The package is
   `"use client"`, so the practical answer is client-only mounting — confirmed from package source,
   not from a doc page.
5. **`/v1/notify` semantics.** Present in the OpenAPI spec but absent from the prose docs; unclear
   whether deprecated and whether it shares idempotency behavior (spec says not idempotent).
6. **Feed "settings" endpoint** (`GET /v1/users/{user_id}/feeds/{id}/settings`) exists in the OpenAPI
   spec (returns `features.branding_required`) but has no prose docs — purpose unclear.
7. **Exact free-plan fair-use enforcement** beyond "we won't hard cap" — no documented throttle on the
   Free plan for going over 10,000 messages.
8. **Custom in-app retention configuration.** Pricing says feed retention "can be configured" with
   "no limit"; I did not find the exact setting/location documented.
