# Jev 1.14 and Box cutover

The model and chart-localization upgrade uses the existing same-account native protocol cutover. Preserve the account, broker credentials, monetary limits, accounting and trading history.

## Settle v39 before replacing its protocol

Migration 186 restricts only the exact clear v39 PAPER identity after proving terminal cycles and intents, flat ledger and broker inventory, settled orders, complete accounting, fresh exact reconciliation covering the last mutation, and no unexpired inference claims. Operator holds and other identities are unchanged. The original v39 runtime performs native settlement and creates clear OBSERVE only after a later exact reconciliation.

The reviewed GitOps change removes the sealed v39 mandate, its identity annotation and all three runtime activation inputs together. This prevents reactivation while preserving the existing authority generations and financial records. Configuration removal alone does not change durable authority.

Verify the Kargo-selected image and native clear OBSERVE state before shipping the new source protocol. After the upgraded image and Box inference are verified, restore a reviewed mandate bound to that exact strategy and verified build, using the same account and limits. Native activation owns the authority transition.

A compatible v39 image can recover before the new protocol migration. Never restore a retired mandate by itself after a successor protocol is admitted. Follow the current protocol's guarded settlement and native activation path.
