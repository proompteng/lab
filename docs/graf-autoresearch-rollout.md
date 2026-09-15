# Graf AutoResearch rollout notes

## Summary

- Graf's AutoResearch prompt builder is now driven by `AUTO_RESEARCH_*` environment variables so the same endpoint can target any knowledge base, and the baked-in defaults are vendor-neutral out of the box.
- This rollout generalizes the stream/stage metadata, neutralizes the sample payloads, and adds documentation that explains how to retarget Graf without touching Kotlin.

## Environment variables you can override

- `AUTO_RESEARCH_KB_NAME` (default `Graf AutoResearch Knowledge Base`) — label plucked into the prompt header/role statement.
- `AUTO_RESEARCH_STAGE` (default `auto-research`) — stage label applied to `codex.stage`, the workflow prefix (sanitized to DNS-1123 before hitting Argo), and telemetry dashboards; GraphResource now prefixes every `Argo` workflow with this value.
- `AUTO_RESEARCH_STREAM_ID` (default `auto-research`) — inserted into every prompt instruction and `codex-graf` payload for consistent stream tagging.
- `AUTO_RESEARCH_OPERATOR_GUIDANCE` — fallback guidance appended when callers omit `user_prompt`.
- `AUTO_RESEARCH_DEFAULT_GOALS` — newline-separated numbered goals that replace the `GOALS` section inside the prompt.

Changing any of these values without redeploying Graf has no effect, so update the Graf Knative service environment (e.g., `kn service update` or the shared deployment script `bun packages/scripts/src/graf/deploy-service.ts`) and then trigger a rollout so the new configuration takes effect. Coordinate with the Graf deploy owners before flipping `AUTO_RESEARCH_STAGE`/`AUTO_RESEARCH_STREAM_ID` values, or dashboards that filter on those labels may misreport.

## Documentation & ops links

- General knowledge-base guidance, explanation of the new env vars, and the NVIDIA appendix now live in `docs/nvidia-company-research.md` (it replaces the old `docs/nvidia-supply-chain-graph-design.md` content and keeps the NVIDIA example in an appendix).
- Update any downstream bookmarks or runbooks that referenced the old doc path.

## Post-merge checklist

1. Confirm the Graf Knative `env`/Secret contains the desired `AUTO_RESEARCH_*` values.
2. Redeploy Graf (e.g., `bun packages/scripts/src/graf/deploy-service.ts`) so the service reads the new values at startup.
3. Validate that `/v1/autoresearch` responses still return `202 Accepted` and that telemetry dashboards pick up the configured `codex.stage`/`streamId` labels.
