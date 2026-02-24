# proompteng.ai Live Presence Counter Plan

## Objective

- Ship a live `online now` counter on `https://proompteng.ai`.
- Prioritize current presence, not cumulative historical visits.
- Keep the implementation anonymous and lightweight on the existing stack (`apps/landing` + `packages/backend/convex`).

## Scope

- In scope:
  - Public counter for people currently on the site.
  - Near real-time updates via Convex subscriptions.
  - Session heartbeat and expiry-based presence logic.
  - Basic bot filtering.
- Out of scope:
  - Full analytics funnels/attribution.
  - User identity or PII collection.
  - Cumulative visit totals as a primary metric.

## Presence Definition

- `online now` = unique active sessions seen in the last TTL window.
- Proposed defaults:
  - Heartbeat every 15 seconds while tab is visible.
  - Session expires after 45 seconds without heartbeat.
- Counter decreases automatically when users close the tab or go inactive past TTL.

## Proposed Architecture

### 1. Presence Tracker (Client)

- Add `apps/landing/src/components/live-presence-tracker.tsx`.
- On load:
  - Create/restore anonymous visitor cookie (`pv_id`).
  - Create page session ID (`ps_id`).
  - Send `join` ping to `apps/landing/src/app/api/presence/route.ts`.
- While page is visible:
  - Send heartbeat every `PRESENCE_HEARTBEAT_SECONDS`.
- On `visibilitychange` hidden and `pagehide`:
  - Send `leave` best-effort beacon.

### 2. Presence Endpoint (Server)

- Implement `POST /api/presence` in `apps/landing/src/app/api/presence/route.ts`.
- Validate and normalize:
  - event type: `join | heartbeat | leave`
  - site/path/session identifiers
  - user-agent heuristics for obvious bots
- Forward accepted events to Convex mutation.

### 3. Convex Data Model

- Extend `packages/backend/convex/schema.ts` with `liveSessions` table:
  - `site`: string
  - `sessionId`: string
  - `visitorIdHash`: string
  - `path`: string
  - `lastSeenAt`: number
  - `expiresAt`: number
  - `updatedAt`: number
- Indexes:
  - `bySession`: `['sessionId']`
  - `bySiteExpires`: `['site', 'expiresAt']`
- Add `packages/backend/convex/presence.ts` with:
  - `upsertPresence` mutation (`join`/`heartbeat` refreshes expiry).
  - `markLeft` mutation (`leave` expires session immediately).
  - `getOnlineNow` query (counts sessions where `expiresAt > now`).

### 4. Live UI Counter

- Add `apps/landing/src/components/live-online-counter.tsx`:
  - Uses `useQuery(api.presence.getOnlineNow, { site: 'proompteng.ai' })`.
  - Displays `N online now`.
  - Includes loading/fallback state.
- Mount in hero/metrics area from `apps/landing/src/components/desktop-hero.tsx`.

## Rollout Plan

1. Phase 1: Convex presence foundation
   - Add schema and `presence.ts`.
   - Run `bun run --filter @proompteng/backend codegen`.
   - Validate with local mutation/query checks.
2. Phase 2: API route + tracker
   - Add `/api/presence`.
   - Add client tracker with join/heartbeat/leave.
   - Validate TTL-based decrement behavior manually.
3. Phase 3: UI integration
   - Add `live-online-counter` component.
   - Place in landing hero and confirm live updates across multiple devices/tabs.
4. Phase 4: Hardening
   - Add edge rate limiting if abuse appears.
   - Tune heartbeat/TTL windows for stability and cost.

## Feature Flags and Config

- `NEXT_PUBLIC_ENABLE_LIVE_PRESENCE_COUNTER=true|false`
- `PRESENCE_HEARTBEAT_SECONDS=15`
- `PRESENCE_TTL_SECONDS=45`

Default: deploy with flag off, enable after production verification.

## Validation Plan

- Local/manual:
  - Open 2-3 browsers/devices and verify counter rises within seconds.
  - Close a browser and confirm counter drops after TTL.
  - Keep one tab hidden and confirm presence pauses/expires.
  - Verify obvious bot user agents are rejected.
- Automated:
  - Unit tests for `/api/presence` validation and bot filtering.
  - Convex tests for session upsert, expiry, and online count query.
- Post-deploy:
  - Monitor route error rate and Convex mutation latency.
  - Confirm no visible performance regression on landing page.

## Risks and Mitigations

- Overcount from multiple tabs:
  - Mitigation: count by session (or unique visitor if preferred) and document behavior.
- Undercount due to aggressive throttling/background tabs:
  - Mitigation: use conservative TTL and visibility-aware heartbeat.
- Bot inflation:
  - Mitigation: UA heuristics + optional edge rate limits.
- Privacy concerns:
  - Mitigation: anonymous IDs only, no PII.

## Success Criteria

- Counter reflects current online presence with <5 second perceived lag.
- Counter decays correctly when sessions expire.
- Landing page performance remains stable.
