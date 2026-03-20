# Incident Report: Huly Account Migration Stall Broke Auth and Forced Swarm User Rebuild

- **Date**: 19 Mar 2026 (UTC)
- **Detected by**: live cluster triage after repeated reports that Huly loaded the shell but did not work
- **Reported by**: gregkonush
- **Services Affected**: `huly/account`, `huly/transactor`, `huly/workspace`, swarm Huly integrations in `agents`
- **Severity**: High (Huly looked healthy from Kubernetes/Argo while account auth and workspace entry were functionally broken)

## Impact Summary

- The Huly front-end shell at `https://huly.proompteng.ai` loaded, but real account-backed flows were broken.
- The account service was stuck retrying Cockroach migration `account_db_v2_social_id_pk_change`.
- The global account store was effectively empty during the incident:
  - `global_account.account = 0`
  - `global_account.person = 0`
  - `global_account.workspace = 0`
  - `global_account.social_id = 0`
- `transactor` account lookups returned `500` or hung, and workspace handshakes degraded into `UND_ERR_HEADERS_TIMEOUT`.
- Swarm Huly identities were no longer trustworthy, so all six swarm users had to be recreated and their tokens rotated.

## User-Facing Symptom

The product looked half-alive. The login shell loaded, Argo reported `huly` healthy, and all Huly pods were `Running`. In practice, users could not complete normal authenticated workspace flows reliably, and swarm agents could not depend on Huly access for tracker, chat, or docs.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-19 22:xx | Triage confirmed Huly was functionally down despite `argocd/huly` reporting healthy workloads. |
| 2026-03-19 22:xx | Live logs showed `account_db_v2_social_id_pk_change` failing repeatedly with Cockroach error `primary key dropped without subsequent addition of new primary key in same transaction`. |
| 2026-03-19 22:xx | Verified `global_account` tables were empty and downstream `transactor`/`workspace` failures were fallout, not independent root causes. |
| 2026-03-19 23:xx | Deployed readiness probes that fail on broken account/transactor/workspace behavior instead of only pod liveness. |
| 2026-03-19 23:xx | Added a Cockroach repair job, but the first GitOps version still used `DROP CONSTRAINT` / `ADD CONSTRAINT` and failed with the same Cockroach limitation. |
| 2026-03-19 23:xx | Live repair used Cockroach-safe DDL: `ALTER PRIMARY KEY USING COLUMNS (_id)`, then marked the stuck migration row applied. |
| 2026-03-19 23:xx | Restarted `account`, `transactor`, and `workspace`; all recovered to `1/1 Ready`. |
| 2026-03-19 23:47 | Merged the final GitOps reconciliation so Argo converged back to `Synced Healthy`. |
| 2026-03-19 23:xx | Recreated six swarm Huly users through the UI, extracted fresh workspace tokens, rotated sealed secrets, and validated tracker/chat/docs access plus API read/write access for each identity. |

## Root Cause

The incident was caused by a Cockroach-incompatible Huly account migration combined with weak readiness checks.

Primary causes:

1. **The account service could not finish startup on Cockroach**
   - Migration `account_db_v2_social_id_pk_change` tried to drop the existing primary key before adding the replacement.
   - Cockroach rejected that sequence with:
     - `unimplemented: primary key dropped without subsequent addition of new primary key in same transaction`
   - Because the migration never completed, account startup kept looping and the Huly auth path never became healthy.

2. **Readiness checks were too shallow**
   - Pods reported `Running` and earlier probes did not verify successful account lookup, account handshake, or workspace entry.
   - This let Argo and Kubernetes present a false green even while user flows were broken.

3. **The deployed config still advertised dead storage assumptions**
   - Huly manifests still referenced `MONGO_URL=mongodb://mongodb:27017` even though no Mongo service existed in-cluster.
   - That was not the immediate failure that blocked recovery, but it increased ambiguity during triage and proved the deployed config had drifted away from the live storage story.

## Evidence

- Account migration failure in live logs:
  - `account_db_v2_social_id_pk_change`
  - `primary key dropped without subsequent addition of new primary key in same transaction`
- Empty account store during incident:
  - `SELECT count(*)` on `global_account.account`, `person`, `workspace`, and `social_id` all returned `0`
- Downstream failures:
  - `transactor` returned `500`
  - `workspace` handshake retries ended with `UND_ERR_HEADERS_TIMEOUT`
- After repair:
  - `global_account._account_applied_migrations` showed `account_db_v2_social_id_pk_change` as applied
  - `global_account.account = 6`
  - `global_account.person = 6`
  - `global_account.workspace = 1`
  - `global_account.social_id = 12`
- Final live state:
  - `argocd/huly` = `Synced Healthy`
  - `account`, `transactor`, and `workspace` all `1/1 Running`

## Contributing Factors

- The first repair job encoded the same Cockroach-incompatible DDL pattern as the failing runtime path, which delayed clean GitOps recovery.
- The transactor readiness probe originally relied on a placeholder workspace lookup that produced false failures instead of validating the real local health + account reachability path.
- Swarm account credentials were tightly coupled to a dead workspace state, so once the account store was gone the only safe recovery path was full account recreation and token rotation.

## What Was Not the Root Cause

- The Huly front-end ingress was not the primary issue.
- Core Huly pods were not crashlooping because of generic Kubernetes instability.
- Swarm automation was not the original cause of the outage; it was a downstream consumer of the broken auth plane.

## Corrective Actions Taken

1. Added readiness probes that validate:
   - local account readiness
   - transactor reachability plus account handshake
   - workspace handshake behavior
2. Added a dedicated account migration repair job to the Huly GitOps app.
3. Corrected the repair job to use Cockroach-safe DDL:
   - `ALTER TABLE defaultdb.global_account.social_id ALTER PRIMARY KEY USING COLUMNS (_id);`
4. Marked the stuck migration row applied after the repair.
5. Restarted `account`, `transactor`, and `workspace` after the migration path was repaired.
6. Recreated all six swarm Huly users through the live UI.
7. Extracted fresh workspace tokens and actor IDs for each swarm identity.
8. Rotated `huly-api-jangar` and `huly-api-torghut` sealed secrets.
9. Validated all six users through:
   - browser login
   - tracker/chat/docs navigation
   - Huly API helper account-info
   - channel read access
   - channel write access

## Preventive Actions

1. Keep the repair job and readiness checks in GitOps so future Huly rollouts fail closed instead of pretending healthy.
2. Remove or replace dead storage config such as the current Mongo reference unless a real Mongo dependency is restored.
3. Treat account migration compatibility as a first-class acceptance gate for Cockroach-backed Huly deployments.
4. Keep swarm Huly credentials recoverable through a documented UI-driven rebuild and reseal workflow.
5. Maintain dedicated per-worker actor validation so broken token/account mappings fail loudly.

## Lessons Learned

- `Running` is not a service-health guarantee when the auth path depends on real account data and live downstream RPCs.
- For Cockroach migrations, “syntactically valid SQL” is not enough; DDL semantics must match Cockroach’s transaction constraints.
- Dedicated swarm identities are worth preserving, but rebuilding them has to be treated as a controlled recovery workflow with browser and API validation, not an improvised secret edit.

## References

- [docs/runbooks/huly-swarm-recovery-and-account-rebuild.md](../runbooks/huly-swarm-recovery-and-account-rebuild.md)
- [argocd/applications/huly/cockroach/cockroach-account-migration-repair-job.yaml](../../argocd/applications/huly/cockroach/cockroach-account-migration-repair-job.yaml)
- [argocd/applications/huly/config/healthcheck-scripts-configmap.yaml](../../argocd/applications/huly/config/healthcheck-scripts-configmap.yaml)
