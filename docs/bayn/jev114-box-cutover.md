# Jev 1.14 and Box cutover

The model and chart-localization upgrade uses the existing same-account native protocol cutover. Preserve the account, broker credentials, monetary limits, accounting and trading history.

## Settle v39 before replacing its protocol

Migration 186 restricts only the exact clear v39 PAPER identity after proving terminal cycles and intents, flat ledger and broker inventory, settled orders, complete accounting, fresh exact reconciliation covering the last mutation, and no unexpired inference claims. Operator holds and other identities are unchanged. The original v39 runtime performs native settlement and creates clear OBSERVE only after a later exact reconciliation.

The reviewed GitOps change removes the sealed v39 mandate, its identity annotation and all three runtime activation inputs together. This prevents reactivation while preserving the existing authority generations and financial records. Configuration removal alone does not change durable authority.

Verify the Kargo-selected image and native clear OBSERVE state before shipping the new source protocol. After the upgraded image and Box inference are verified, restore a reviewed mandate bound to that exact strategy and verified build, using the same account and limits. Native activation owns the authority transition.

A compatible v39 image can recover before the new protocol migration. Never restore a retired mandate by itself after a successor protocol is admitted. Follow the current protocol's guarded settlement and native activation path.

## Admit Box inference

Migration 187 requires the settled clear OBSERVE boundary again. It admits protocol v40, pinned Jev 1.14, the exact
Box question-policy hash and handoff v5. A new request has one CHART dispatch; BASE_START claims and skips are retired.
The terminal, handoff, receipt and expense guards preserve old paid evidence while rejecting mixed model/stage graphs.
The expense source queue expects two resolved stages for v40 and retains the original count for historical requests.

CHART contains presence Nouls and Boxes over one deterministic PNG. Localization selects original candle IDs, never
model prices. Regions use the renderer's projection and explicit coordinate reporting margin. Degenerate regions
cannot identify a source. The final Jev call evaluates the resulting funded proposals with the existing thresholds,
fees, risk limits and original ten-second deadline. Independent symbols can commit and continue without waiting for a
slower chart. Historical codecs are financial readers; the client refuses new v13 dispatches.

Run `node dist/jev-evaluation-command.js --verify-box` inside the verified execution-worker image. It uses that
worker's existing TypeSafe credential and proxy and makes real image/Box and downstream Jev calls over explicitly
identified deterministic acceptance fixtures. Its JSON receipt includes source/PNG/request/response hashes, raw
answers, derived proposals, provider usage, elapsed time and embedded build metadata. PASS requires all cases to
complete and at least one funded downstream judgment. It acquires no capital authority and issues no broker order.
This proves the deployed inference path; native controller progress, exact reconciliation and restored same-account
PAPER authority are separate required live readbacks. It does not establish trading profitability.
