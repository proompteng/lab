# Torghut: Route LLM Trade Review Through Jangar (Plan)

## Context

Torghut currently implements an optional LLM "review" step for trade decisions (approve, veto, or adjust) in:

- `services/torghut/app/trading/scheduler.py` (`TradingPipeline._apply_llm_review`)
- `services/torghut/app/trading/llm/*` (request/response schema, policy, circuit breaker, prompt templates)

Today, the LLM client calls OpenAI directly via the Python SDK:

- `services/torghut/app/trading/llm/client.py` (`OpenAI().chat.completions.create(...)`)

Torghut should instead call the in-cluster Jangar completion endpoint so that:

- Model routing, auth, and policy live in one place (Jangar).
- Torghut does not require direct OpenAI credentials.
- Operations can standardize observability and error handling around a single gateway.

## Key Constraint: Jangar Chat Completions Is Stream-Only

Jangar exposes an OpenAI-like route:

- `POST /openai/v1/chat/completions`

But it currently requires streaming (`stream: true`) and does not accept OpenAI-only fields (for example `response_format`, `temperature`, `max_tokens`) as part of the request body:

- `services/jangar/src/server/chat.ts` (request schema + `stream_required`)

Therefore, Torghut cannot simply point the OpenAI Python SDK at Jangar (without expanding Jangar's request schema).

## Proposed Approach (Recommended)

Implement a Torghut LLM client that talks to Jangar using plain HTTP and parses SSE streaming responses.

### 1) Configuration

Add Jangar routing knobs to `services/torghut/app/config.py`:

- `JANGAR_BASE_URL` (example: `http://jangar.jangar.svc.cluster.local`)
- `JANGAR_API_KEY` (optional, sent as `Authorization: Bearer ...` if present)
- `LLM_PROVIDER` enum: `jangar|openai` (default `jangar` when `JANGAR_BASE_URL` is set, else `openai`)

Keep existing LLM controls:

- `LLM_ENABLED`, `LLM_MODEL`, `LLM_PROMPT_VERSION`, `LLM_FAIL_MODE`, `LLM_SHADOW_MODE`, circuit breaker settings, etc.

### 2) Client Implementation

Update `services/torghut/app/trading/llm/client.py` to support:

- `provider=openai`: current behavior via the OpenAI SDK.
- `provider=jangar`: `fetch`-style HTTP call to Jangar with SSE parsing.

Jangar request shape (minimum viable):

```json
{
  "model": "optional-model-name",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

Headers:

- `content-type: application/json`
- `authorization: Bearer ${JANGAR_API_KEY}` (only if set)

SSE parsing requirements:

- Read response body as text.
- Split events on blank lines (`\\n\\n`).
- For each `data: ...` line:
  1. If `data: [DONE]`, stop.
  2. Otherwise parse JSON.
  3. Append `choices[].delta.content` to an output buffer when present.
  4. Capture usage if present (best-effort). If Jangar does not emit usage, keep it `null`.

Return the final aggregated string; the existing `review_engine.py` continues to:

- `json.loads(...)` the content
- validate via `LLMReviewResponse` pydantic schema

### 3) Review Engine Compatibility

In `services/torghut/app/trading/llm/review_engine.py`:

- Keep the prompt construction and schema validation as-is.
- Make `temperature`/`max_tokens` optional knobs:
  - Apply them only to the OpenAI provider.
  - For Jangar, omit these fields unless/until Jangar supports them.

### 4) Tests

Add unit tests under `services/torghut/tests/`:

1. SSE parser: multiple chunks with `choices[].delta.content` assemble into one string.
2. SSE parser: handles `[DONE]` termination.
3. Error handling: non-2xx response yields an exception message that the scheduler persists into `llm_decision_reviews` as an `error` verdict.

### 5) Deployment (GitOps)

Update `argocd/applications/torghut/knative-service.yaml`:

- Set `JANGAR_BASE_URL=http://jangar.jangar.svc.cluster.local`
- Set `LLM_PROVIDER=jangar`

Do not enable LLM in production immediately. Roll out in stages:

1. `LLM_ENABLED=true`, `LLM_SHADOW_MODE=true`, `LLM_FAIL_MODE=pass_through`
2. Confirm audit rows in `llm_decision_reviews` look correct.
3. Disable shadow mode for paper trading first.
4. For live trading, default to fail-closed (`LLM_FAIL_MODE=veto`) and keep a conservative circuit breaker.

### 6) Operational Verification

Verification targets:

- Torghut health: `/healthz`
- Trading status includes LLM circuit breaker state: `/trading/status` (surfaced via `services/torghut/app/main.py`)
- Audit data: `llm_decision_reviews` rows are created for each reviewed decision with request/response JSON and verdict.

## Alternative Approach (Higher Blast Radius)

Extend Jangar's chat completion request schema to accept OpenAI-style fields:

- `temperature`, `max_tokens`, `response_format`, and optionally non-stream responses.

This would let Torghut keep using the OpenAI Python SDK pointed at Jangar, but it widens Jangar's compatibility surface and needs careful review and testing across other Jangar clients.

## Deliverables Checklist

- [ ] Torghut supports `LLM_PROVIDER=jangar` and calls Jangar over HTTP with SSE parsing.
- [ ] Jangar base URL and optional API key are configurable via env vars.
- [ ] Tests cover streaming parsing and error handling.
- [ ] Torghut Knative service manifest wires in `JANGAR_BASE_URL` and `LLM_PROVIDER`.
- [ ] Rollout defaults to shadow mode and pass-through until validated.
