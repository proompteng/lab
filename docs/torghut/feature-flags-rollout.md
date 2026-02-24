# Torghut Feature Flags Rollout (Flipt)

## Scope

- All Torghut runtime boolean gates are migrated to Flipt-backed flags.
- Torghut resolves flags through `POST /evaluate/v1/boolean` against the feature-flags service.

## Source Of Truth

- Runtime mapping: `services/torghut/app/config.py` (`FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD`).
- Flipt catalog: `argocd/applications/feature-flags/gitops/default/features.yaml`.
- Runtime deployment wiring: `argocd/applications/torghut/knative-service.yaml`.

## Runtime Contract

- Feature flag client toggle: `TRADING_FEATURE_FLAGS_ENABLED`.
- Flipt endpoint: `TRADING_FEATURE_FLAGS_URL` (for example `http://feature-flags.feature-flags.svc.cluster.local:8013`).
- Evaluation namespace: `TRADING_FEATURE_FLAGS_NAMESPACE` (default `default`).
- Evaluation entity id: `TRADING_FEATURE_FLAGS_ENTITY_ID` (default `torghut`).
- Request payload:

```json
{
  "namespaceKey": "default",
  "flagKey": "torghut_trading_enabled",
  "entityId": "torghut",
  "context": {}
}
```

## Flag Inventory

- Total Torghut flags: tracked by manifest parity test in `services/torghut/tests/test_config.py`.
- Trading flags: `torghut_trading_*` plus rollout controls such as `torghut_ws_crypto_enabled` and `torghut_universe_crypto_enabled`.
- LLM flags: `torghut_llm_*`.
- Canonical inventory lives in `argocd/applications/feature-flags/gitops/default/features.yaml`.

## Migration Guarantees

- `services/torghut/tests/test_config.py` enforces all boolean settings are mapped (excluding `TRADING_FEATURE_FLAGS_ENABLED` control switch).
- `services/torghut/tests/test_config.py` enforces exact parity between runtime map keys and Flipt `torghut_*` keys in `features.yaml`.

## GitOps Rollout Steps

1. Update runtime map in `services/torghut/app/config.py` when adding/removing boolean gates.
2. Update Flipt catalog in `argocd/applications/feature-flags/gitops/default/features.yaml`.
3. Run validation:

```bash
cd services/torghut
uv run pyright --project pyrightconfig.json
uv run pyright --project pyrightconfig.alpha.json
uv run pyright --project pyrightconfig.scripts.json
uv run ruff check app tests scripts migrations
uv run python -m unittest tests.test_config
uv run python -m unittest discover -s tests -p 'test_*.py'
cd /Users/gregkonush/.codex/worktrees/a115/lab
bun run lint:argocd
```

4. Merge the Torghut changes into `main`.
5. Ensure the Flipt storage branch (`feature-flags-state`) contains the same `argocd/applications/feature-flags/gitops/default/features.yaml`.
6. Roll Torghut runtime image and GitOps manifest, then sync Argo CD.

## Post-Deploy Verification

1. Check Argo app health:

```bash
kubectl -n argocd get applications.argoproj.io feature-flags torghut
```

2. Confirm Torghut env wiring:

```bash
kubectl -n torghut get ksvc torghut -o yaml | rg "TRADING_FEATURE_FLAGS_(ENABLED|URL|TIMEOUT_MS|NAMESPACE|ENTITY_ID)"
```

3. Validate Flipt evaluation for a Torghut key:

```bash
kubectl -n feature-flags port-forward svc/feature-flags 18013:8013
curl -sS -X POST http://127.0.0.1:18013/evaluate/v1/boolean \
  -H 'content-type: application/json' \
  -d '{"namespaceKey":"default","flagKey":"torghut_trading_enabled","entityId":"torghut","context":{}}'
```

4. Check Torghut logs for successful startup and absence of feature-flag schema errors.

## Rollout Evidence (2026-02-21)

- Flipt source branch updated: `feature-flags-state` commit `5bbb1e03` includes all `torghut_*` keys.
- Torghut runtime image rolled out: `registry.ide-newton.ts.net/lab/torghut@sha256:cfb6ffa5bb3f15f8031aee336d355cc280279997a289c5b5c96f0d5c48b33e76`.
- Active Knative revision: `torghut-00009`.
- Argo CD status during rollout: `feature-flags=Synced/Healthy`, `torghut=OutOfSync/Healthy` (manifest changes pending merge to `main`).
- Flipt evaluation validation:
  - Single key probe returned `enabled` for `torghut_trading_enabled`.
  - Full catalog probe returned `ok=<all torghut keys> fail=0` for all `torghut_*` keys via `/evaluate/v1/boolean`.
- Runtime env validation confirms:
  - `TRADING_FEATURE_FLAGS_ENABLED=true`
  - `TRADING_FEATURE_FLAGS_URL=http://feature-flags.feature-flags.svc.cluster.local:8013`
  - `TRADING_FEATURE_FLAGS_TIMEOUT_MS=500`
  - `TRADING_FEATURE_FLAGS_NAMESPACE=default`
  - `TRADING_FEATURE_FLAGS_ENTITY_ID=torghut`
