# Temporal Bun SDK Release Runbook

Automation now drives every step via `.github/workflows/temporal-bun-sdk.yml`. Use
this runbook as a quick reference for triggering and validating releases.

> **Status:** TBS-009 (Release Automation) closed on 2025-11-17 via the trusted
> publishing workflow; this document captures the final process.

## Prerequisites

- npm trust publishing is enabled for `proompteng/lab → temporal-bun-sdk.yml`
  (Trusted Publisher entry in the npm org). No automation token is required.
- Maintainer access to run the Temporal Bun SDK workflow manually on `main`.
- Desired npm dist-tag (`latest`, `beta`, etc.) for the publish run.
- Buf CLI installed (`buf` on `PATH`) if you plan to run the proto regeneration
  script locally.

## Release Steps

1. **Prepare mode**
   - Trigger the workflow with `release_mode=prepare` (optionally set
     `npm_tag`). This runs release-please to open/update the automated release
     PR (`release-please--branches--main--components--temporal-bun-sdk`).
   - The job runs Oxfmt + build + unit + load suites against the release PR
     branch so we can verify artifacts before merging. Review the PR and merge
     after CI is green.
2. **Publish mode**
   - Re-run the workflow with `release_mode=publish` (set `dry_run=true` for a
     rehearsal) **from the `main` branch only**; the workflow refuses to run on
     other refs. The job reads the merged `package.json` version on `main`, reruns
     the validations, then executes `npm publish --provenance --access public
--tag <dist>`.
   - Keep the workflow logs + artifacts linked to the tracking issue/PR as proof
     of the dry-run and the final publish.

## Support & Incident Response

- Direct any security or incident reports to `security@proompteng.ai`.

## Post-Release Checklist

- Confirm the npm release metadata (version, dist-tag, provenance) matches the
  workflow output.
- Close the tracking issue (e.g., #1788) and note the publish link.
- Schedule any follow-up docs/DevRel announcements if required.
- If upstream Temporal protos changed, trigger the "Temporal Bun SDK Proto
  Regen" workflow (or confirm the scheduled run already merged) so generated
  sources stay current.
