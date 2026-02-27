# Torghut Market-Context Ingest Runbook

## Scope

Use this runbook for alerts:

- `JangarTorghutMarketContextIngestUnauthorized`
- `JangarTorghutMarketContextIngestSuccessRateLow`
- `JangarTorghutMarketContextDispatchErrors`
- `JangarTorghutMarketContextDispatchStuck`

These failures block fundamentals/news snapshot persistence and can keep Torghut market context below the trading quality gate.

## Quick Checks

1. Confirm Jangar revision includes market-context agents codepath:

```bash
kubectl exec -n jangar deploy/jangar -c app -- sh -c 'cd /workspace/lab/services/jangar && ls src/server | rg "torghut-market-context-agents" -n'
```

2. Check Jangar runtime auth config (SA-only expected):

```bash
kubectl exec -n jangar deploy/jangar -c app -- sh -c 'env | grep JANGAR_MARKET_CONTEXT_INGEST'
```

Expected:

- `JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN=true`
- `JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES=system:serviceaccount:agents:agents-sa`
- `JANGAR_MARKET_CONTEXT_INGEST_TOKEN` unset/empty

3. Confirm market-context jobs run with explicit `agents-sa`:

```bash
kubectl get pods -n agents -o custom-columns=NAME:.metadata.name,SA:.spec.serviceAccountName \
  --no-headers | rg 'torghut-market-context-(fundamentals|news)-'
```

4. Confirm callback failures are not 401:

```bash
kubectl logs -n agents job/<latest-market-context-job> --tail=200
```

Search for callback `curl` failures and HTTP codes.

## Data Plane Verification

1. Trigger providers via Jangar (example symbol):

```bash
kubectl exec -n jangar deploy/jangar -c app -- sh -c 'curl -sS "http://127.0.0.1:8080/api/torghut/market-context/providers/news?symbol=NVDA" | jq'
kubectl exec -n jangar deploy/jangar -c app -- sh -c 'curl -sS "http://127.0.0.1:8080/api/torghut/market-context/providers/fundamentals?symbol=NVDA" | jq'
```

2. Validate snapshots are persisted:

```bash
kubectl exec -n jangar deploy/jangar -c app -- sh -c 'cd /workspace/lab/services/jangar && node -e "\
const { Client } = require(\"pg\"); \
(async () => { \
  const c = new Client({ connectionString: process.env.DATABASE_URL }); \
  await c.connect(); \
  const q = await c.query(\"select symbol,domain,as_of,updated_at,quality_score from torghut_market_context_snapshots where symbol=$1 order by updated_at desc\", [\"NVDA\"]); \
  console.log(q.rows); \
  await c.end(); \
})();"'
```

3. Validate bundle quality recovers:

```bash
kubectl exec -n torghut deploy/torghut -- sh -c 'curl -sS "http://jangar.jangar.svc.cluster.local/api/torghut/market-context/?symbol=NVDA" | jq ".qualityScore,.riskFlags"'
```

## Remediation

1. If callbacks are `401`:

- Verify Jangar allowlist prefix matches runtime service account.
- Verify AgentRun runtime service account is `agents-sa`.

2. If dispatch is stuck in `submitted`:

- Check job logs for callback failures and rerun failing AgentRuns.
- Validate ingest endpoint authorization by posting from inside an `agents-sa` pod token.

3. If Jangar revision is missing `torghut-market-context-agents`:

- Roll out a newer Jangar image/revision containing market-context agent ingest code before further debugging.

## Known Failure Modes (2026-02-27)

Use this sequence when dispatch is active but snapshots do not persist:

1. AgentRun runtime service-account key mismatch:
- Symptom: `AgentRun.spec.runtime.config.serviceAccountName` is set, but jobs still launch with default SA.
- Check: `kubectl get agentrun -n agents <name> -o json | jq '.spec.runtime.config'`
- Fix landed: runtime resolver accepts both `serviceAccount` and `serviceAccountName`.

2. TokenReview TLS verification failure in Jangar:
- Symptom in Jangar logs: `unable to verify the first certificate` during `service_account_token_review`.
- Check:
  `kubectl logs -n jangar deploy/jangar -c app --since=30m | rg "market_context_ingest_auth|unable to verify"`
- Fix landed: fallback TokenReview via direct in-cluster HTTPS (`/apis/authentication.k8s.io/v1/tokenreviews`) using mounted SA token + CA.

3. `codex-spark` provider incompatibility:
- Symptom in agent job logs:
  - `Unsupported parameter: 'reasoning.summary'`
  - `refresh_token_reused`
- Check:
  `kubectl logs -n agents job/<market-context-job> --tail=200`
- Fix landed:
  - `model_reasoning_summary = "none"` for `gpt-5.3-codex-spark`.
  - Provider bootstrap rewrites mounted auth to API-key mode before `codex exec`.

4. Fundamentals/news callback payload malformed:
- Symptom: callback `POST /api/torghut/market-context/ingest` returns `400` from job script.
- Fix landed: implementation prompts now require Python JSON serialization + `json.tool` and `jq` validation before callback, plus explicit HTTP status/body checks.

## E2E Acceptance Check

After remediation, run one fresh symbol through both providers and verify all four conditions:

1. Both AgentRuns succeeded.
2. Both jobs succeeded (`succeeded=1`, `failed=0`).
3. DB has both rows in `public.torghut_market_context_snapshots` for that symbol.
4. Torghut bundle quality recovers from missing/stale risk flags.

Example DB verification:

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -At -F $'\t' -c \
"SELECT symbol,domain,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
 FROM public.torghut_market_context_snapshots
 WHERE symbol='ADBE' AND domain IN ('news','fundamentals')
 ORDER BY domain;"
```
