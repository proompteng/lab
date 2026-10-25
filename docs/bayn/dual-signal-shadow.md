# OHLCV and image shadow decisions

The opt-in `bayn-dual-signal` CLI compares two concurrent decisions over **identical source market data**. It never
changes Jev production decisions, position sizing, broker mutations, account grants, strategy hashes or risk limits.

1. Input is a private, hashed `bayn.jev-evaluation-request.v1` evidence artifact, validated before dispatch.
2. Jev 1.13.0 evaluates the original numerical request, containing candidate OHLCV, benchmark and trade economics.
3. A deterministic 640×360 PNG is rendered solely from the candidate one-minute OHLCV bars, then GPT-6 Luna
   classifies `upward`, `unclear`, or `adverse` using OpenAI `POST /v1/decisions`.
4. Separate responses, types, probability distributions, latency, provider token usage, estimated token costs and
   hashes are recorded in a new **private** report, with explicit partial failures. Both calls have bounded deadlines.

The chart does **not** provide independent market evidence. The report explicitly records
`independentEvidence: false` and `tradingAuthority: NONE`. Agreement cannot count as two independent confirmations.
Enabling this for trades would require a separate walk-forward net-P&L, latency, calibration, drawdown and expense
validation, with a reviewed change to trading authority and deterministic decision evidence.

## Invocation

The CLI ships in the standard Bayn image, but the trading runtime does not invoke it automatically. When an
approved research environment has provider credentials and outbound access:

```sh
# Load these values from your private secret manager, never commit them.
# BAYN_JEV_API_KEY
# BAYN_OPENAI_API_KEY
# BAYN_PUBLIC_INFORMATION_PROXY
bayn-dual-signal --request /private/jev-evaluation-request.json --output /private/dual-signal-report.json
```

It rejects an existing report path before dispatch, retains an exclusive final write with file mode `0600`, and
prints only status/hash metadata. A path created concurrently still cannot be overwritten. Reports use
`bayn.dual-signal-shadow-report.v2`: alongside the source-data hashes, they bind the fixed visual endpoint and
SHA-256 of the complete serialized visual request, including model, prompt, choices and image. Historical v1
reports do not provide that full-request binding and are not upgraded in place.

Verified rejected Jev receipts retain their response hash, HTTP status and token usage for cost estimation,
but never count as a usable decision. Missing, malformed or unbound metering remains unknown, not free.
Transport/JSON failures retain a redacted internal cause and expose only a bounded diagnostic tag in the report.
The CLI retains partial reports and exits unsuccessfully for either incomplete decisions or missing metering.
The output estimates pico-USD from October 22, 2026 list assumptions:
Jev $0.042/1M input, OpenAI $0.10/1M ordinary input, $0.01/1M cached reads, $0.125/1M default 30-minute cache
writes, with no charged output. These are **not invoice-reconciled costs** and do not post to TigerBeetle.

## Security/rollout gate

The Bayn Squid CONNECT allowlist includes `api.openai.com` on HTTPS port 443. Kubernetes still restricts
application traffic to the existing `bayn-egress-proxy` Service (port 3128), and the proxy blocks private
destinations. Bayn opts into the validated `ClusterSecretStore/onepassword-infra`. The GitOps-managed
`ExternalSecret/bayn-openai-auth` maps the **future** 1Password item `infra/bayn-openai` field `api-key`
(`remoteRef.key: bayn-openai/api-key`) to Kubernetes `Secret/bayn-openai-auth` key `api-key`.

**Dark by default:** No API key, example value, or Kubernetes Secret is created by this change. Until the
1Password item/field is populated, the ExternalSecret may legitimately report `SecretSyncedError`/`Ready=False`;
that is a credential-absent state, not a functioning OpenAI connection. It is assigned sync wave `3` (after
the research worker) and deliberately opts out of Argo's child health aggregation and sync-wave wait while the
remote value is absent. Do not mistake Argo `Healthy` for a synced OpenAI credential. Remove those two
health-override annotations when activating the external Secret, so later sync failures become release blockers.
The research worker references
`BAYN_OPENAI_API_KEY` using `secretKeyRef.optional: true`, so it remains healthy without the Secret.
Only the research worker receives this reference; execution and public status workloads receive none. No
automatic dual-signal dispatch or trading authority is enabled by having a key in a Secret.

To activate a **manual shadow research run** later:

1. Add a real scoped OpenAI project API key to the `infra` vault item `bayn-openai`, field `api-key`.
   Never add a dummy provider key or plaintext credential to Git.
2. Check `kubectl -n bayn get externalsecret bayn-openai-auth` reports `Ready=True`, and the target
   Kubernetes Secret has the named key (do not print its value).
3. Roll out the Bayn research worker so its **environment** receives the new Secret value; a running pod
   does not dynamically reload environment-based secret references.
4. Run `bayn-dual-signal` explicitly with a sealed private request and a fresh output path. Verify successful
   real provider usage, latency, report hash, and the `tradingAuthority: NONE` invariant before any scheduling.

The store uses the existing `infra` 1Password service-account identity; this opt-in does not mint a new
service account or isolate access to only the OpenAI item. Keep `ExternalSecret` write permissions restricted
to trusted GitOps operators. Revoking or rotating a key requires verification and a research-worker restart.
