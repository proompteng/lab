# Consolidated SIP shadow rollout

The 73-symbol Consolidated SIP shadow is parked: the producer is declared at **zero replicas** and the archive
settings are provisioned but not attached. Keep IEX primary while qualifying SIP. The shadow does not authorize
a Bayn feed cutover, the ETF strategy upgrade, or trading. Activate only through
[reviewed GitOps and Kargo](../release-automation.md). Do not patch replicas, ConfigMaps, or Flink jobs in the cluster.

## Capture and archive contract

The [Bayn universe manifest](../../services/bayn/src/market-data/sip/universe.ts) defines `torghut-core-equity-sip-v1`.
Hash its sorted uppercase `all73` as a comma-separated string with no whitespace or trailing newline:

```sh
sip_symbols="$(bun -e 'import { sipUniverse } from "./services/bayn/src/market-data/sip/universe"; console.log(sipUniverse.all73.join(","))')"
printf '%s' "$sip_symbols" | sha256sum
```

The digest must be `89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b`. The
[SIP forwarder ConfigMap](../../argocd/applications/torghut/ws/sip-configmap.yaml) and
[archive shadow ConfigMap](../../argocd/applications/torghut/market-data-archive/sip-shadow-configmap.yaml) pin
that same roster and digest. Use one SIP replica and one upstream socket for all 219 bar, quote, and trade
subscriptions. Leave dynamic symbol sources, observation feeds, per-channel symbol overrides, backfills, and trade
updates off during qualification. Never add SIP as an observation feed on the IEX forwarder. The local paid
declaration allows 400 symbol/channel subscriptions; `ALPACA_MAX_SYMBOL_CHANNELS=219` can cap it to this roster but
does not grant entitlement. See the [forwarder contract](../../services/dorvud/README.md#consolidated-sip-shadow-forwarder)
and [archive contract](../../services/dorvud/technical-analysis-flink/README.md#parallel-consolidated-sip-shadow-archive)
for the implementation details.

## Preflight

1. Verify the Kubernetes context and identity using the [Galactic access runbook](../runbooks/galactic-kubernetes-access.md).
   Confirm Kafka has synced the reviewed change, and confirm the exact generated `kargo/torghut` revision and
   [Stage](../../argocd/applications/kargo/stages.yaml) Freight. Both WS Deployments must render to the same promoted
   digest containing [#16384](https://github.com/proompteng/lab/pull/16384); the archive digest must contain
   [#16389](https://github.com/proompteng/lab/pull/16389). Confirm the SIP Deployment has zero Pods and the archive
   is still on IEX with no SIP shadow settings in its pod template.
2. Check that all four topics are Ready with three partitions, replication factor three, and all replicas in sync.
   Bars retain 35 days; quotes, trades, and compacted status retain seven days. The
   [Kafka broker](../../argocd/applications/kafka/strimzi-kafka-cluster.yaml) uses SCRAM authentication on port 9092
   but has no authorizer: neither delayed SIP nor SIP has topic ACLs. The forwarder and archive both authenticate as
   `torghut-ws`, not `torghut-ta`; `bayn-market-data` retains its existing access and is not configured to consume SIP
   by this change. If broker authorization is enabled later, review the producer topic Write/Describe and consumer
   topic Read/Describe plus group Read grants separately. Do not enable authorization just for this lane.
3. Record IEX publication and archive progress, the last successful archive checkpoint, Kafka and ClickHouse disk
   headroom, replication, and lag. Assess the shared-services budget against the
   [capacity gates](sip-and-universe-expansion-plan.md#capacity-proof-before-adoption). This lane adds no running work
   while parked, but full SIP tick capture can stress shared Kafka, Flink, and ClickHouse after activation.
4. Have the owner confirm paid Consolidated SIP market-data WebSocket access for the account behind
   `torghut/torghut-alpaca`, and confirm a free `/v2/sip` connection that cannot evict any live stream. The local
   `algo_trader_plus` setting does not confer provider access. If either check fails or only another account is
   entitled, stop; do not copy or swap secrets, disconnect IEX, or buy an entitlement as part of this procedure.

### Prove the exact mounted credential can subscribe

With approved access to that Secret, run this once from a trusted shell with Bun and `kubectl` after the owner checks
above. It sends the credentials only to Alpaca, prints neither credential nor raw frames, and closes the socket
before activation. Neither a REST response nor an Alpaca test/delayed-SIP socket proves this entitlement.

```bash
(
  set +x
  set -euo pipefail
  k=(kubectl --context galactic-tailscale -n torghut)
  sip_symbols="$("${k[@]}" get configmap torghut-ws-sip-config -o jsonpath='{.data.SYMBOLS}')"
  "${k[@]}" get secret torghut-alpaca -o json | SIP_SYMBOLS="$sip_symbols" bun -e '
    const { data } = await Bun.stdin.json().catch(() => { throw new Error("Could not read Alpaca Secret JSON") })
    const csv = Bun.env.SIP_SYMBOLS ?? ""
    const symbols = csv.split(",")
    const hash = new Bun.CryptoHasher("sha256").update(csv).digest("hex")
    if (symbols.length !== 73 || hash !== "89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b") {
      throw new Error("Unexpected SIP roster")
    }
    if (!data?.APCA_API_KEY_ID || !data?.APCA_API_SECRET_KEY) throw new Error("Missing Alpaca credentials")
    const channels = ["bars", "quotes", "trades"]
    const socket = new WebSocket("wss://stream.data.alpaca.markets/v2/sip")
    const fail = (reason) => { console.error(reason); process.exit(1) }
    const timeout = setTimeout(() => fail("SIP subscription or close timed out"), 15000)
    let acknowledged = false
    socket.onopen = () => socket.send(JSON.stringify({
      action: "auth",
      key: Buffer.from(data.APCA_API_KEY_ID, "base64").toString(),
      secret: Buffer.from(data.APCA_API_SECRET_KEY, "base64").toString(),
    }))
    socket.onmessage = ({ data: frame }) => {
      let messages
      try { messages = JSON.parse(frame) } catch { fail("Invalid SIP frame") }
      if (!Array.isArray(messages)) fail("Invalid SIP frame")
      for (const event of messages) {
        if (!event || typeof event !== "object") fail("Invalid SIP frame")
        if (event.T === "error") fail(`Alpaca SIP error ${Number(event.code)}`)
        if (event.T === "success" && event.msg === "authenticated") {
          socket.send(JSON.stringify({ action: "subscribe", bars: symbols, quotes: symbols, trades: symbols }))
        }
        if (event.T === "subscription") {
          if (!channels.every((channel) =>
            Array.isArray(event[channel]) && [...event[channel]].sort().join(",") === csv
          )) fail("Incomplete SIP subscription")
          acknowledged = true
          socket.close()
        }
      }
    }
    socket.onerror = () => fail("SIP WebSocket connection failed")
    socket.onclose = () => {
      clearTimeout(timeout)
      if (!acknowledged) fail("SIP WebSocket closed without a subscription acknowledgement")
      console.log("SIP acknowledged all 219 subscriptions; socket closed")
    }
  '
)
```

Retain the result, not the Secret or frames. Alpaca codes 405, 406, and 409 mean symbol limit, connection limit,
and insufficient subscription respectively. They stop the SIP forwarder's reconnect loop. On any preflight failure,
leave replicas at zero and resolve it with the owner. If the Secret changes between this check and rollout, repeat
the check before activation.

## Activate capture, then archiving

1. In a reviewed change, set `replicas: 1` in
   [the SIP Deployment](../../argocd/applications/torghut/ws/sip-deployment.yaml). After promotion, verify the
   rollout during a supervised market-data window:
   `kubectl --context galactic-tailscale -n torghut rollout status deployment/torghut-ws-sip --timeout=3m`.
   Check the SIP Pod logs for complete channel acknowledgement and no entitlement or Kafka delivery errors.
   Verify that bars, quotes, and trades advance on their SIP topics with `feed=sip`,
   `delay_class=real_time_consolidated`, universe `torghut-core-equity-sip-v1`, and the expected hash. Compare
   IEX progress to the preflight baseline before touching the archive. Status is a separate topic, not an archive input.
2. In a separate reviewed change, add the following to the `flink-main-container` `envFrom` list in
   [market-data-archive/flinkdeployment.yaml](../../argocd/applications/torghut/market-data-archive/flinkdeployment.yaml):

   ```yaml
   - configMapRef:
       name: market-data-archive-sip-shadow-config
   ```

   This attaches the [six settings](../../argocd/applications/torghut/market-data-archive/sip-shadow-configmap.yaml)
   together. There is no `ARCHIVE_SIP_SHADOW_ENABLED` flag: setting it to `false` would not neutralize those keys.
   Keep `ARCHIVE_CORE_FEED=iex`, all existing routes, group, offset reset, sinks, and savepoint mode. Attaching the
   ConfigMap changes the Flink pod template and triggers a stateful upgrade. Verify restoration, `RUNNING`, and
   a new successful checkpoint; do not bypass state checks. Newly added partitions without an offset start at
   `latest`, so do not expect the producer smoke records to be backfilled. Finish the upgrade before the first
   measured session opens.

3. After the upgrade, verify Kafka lag drains and new ClickHouse rows advance for SIP and IEX in
   `signal.intraday_bars_1m_v2`, `signal.intraday_quotes_v1`, and `signal.intraday_trades_v1`. With an approved
   read-only identity, check recent rows for each feed's `source_topic`, `universe_id`, `universe_symbol_hash`,
   and `delay_class`; match sample `source_partition` and `source_offset` values to Kafka. Compare archive rejects,
   checkpoints and ClickHouse replication/space to baseline. Readiness alone does not prove ingestion.

## Parity and Phase 2: QQQ + SMH + XLK

### Verify five consecutive completed trading sessions

Run the [SIP-vs-IEX verifier](../../services/bayn/tools/verify-sip-vs-iex-shadow.ts) from a pinned checkout with Bun
1.4.2 and locked dependencies. It makes read-only, parameterized ClickHouse HTTP GETs and obtains RTH bounds from
Alpaca's `GET /v2/calendar`. Inject credentials through the existing secret path; never put them in arguments,
reports, or shell traces.

| Variable                                               | Purpose                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `BAYN_CLICKHOUSE_URL`                                  | Approved native ClickHouse HTTP(S) endpoint without URL credentials, query, or fragment               |
| `BAYN_CLICKHOUSE_USERNAME`, `BAYN_CLICKHOUSE_PASSWORD` | Read-only credentials with SELECT on `signal.intraday_bars_1m_v2` and `signal.intraday_quotes_v1`     |
| `BAYN_ALPACA_KEY_ID`, `BAYN_ALPACA_SECRET_KEY`         | Calendar-capable Alpaca credentials                                                                   |
| `BAYN_ALPACA_BASE_URL`                                 | `https://paper-api.alpaca.markets` (default) or `https://api.alpaca.markets`, matching the credential |

Confirm both lanes captured from before open, have drained through close, and had no backfill or route change in
the window. Use **five consecutive exchange trading dates**, including scheduled early closes and skipping holidays
and weekends. After each close and archive drain, set `SESSION` to that date (`YYYY-MM-DD`) and retain the JSON:

```bash
(
  umask 077
  set -o noclobber
  bun services/bayn/tools/verify-sip-vs-iex-shadow.ts \
    --session "${SESSION:?set the session date}" --format json > "sip-shadow-$SESSION.json"
)
```

The CLI exits zero for PASS, nonzero with a scorecard for a gate FAIL, and nonzero without a scorecard for a
configuration, session, read, or data-contract failure. Use `--format markdown` for a human-readable scorecard.
Retain the five dates, JSON reports, verifier and deployed revisions, and source/lag/reject evidence. Live reads
are not frozen snapshots: late revisions can change a rerun. Write reruns to new paths and do not count them as
new sessions or skip a failed date. Resolve failures and qualify a new consecutive window.

### Exact gate per session

Every check in `bayn.sip-shadow-parity-report.v1` must pass on all five dates:

- The distinct RTH SIP roster observed across bars and quotes, sorted and hashed, matches the canonical digest.
  Every SIP row in the window must carry the canonical universe ID and hash.
- **QQQ, SMH, XLK, and SPY** each have at least **99.5%** unique final SIP minute bars: 389 of 390 regular minutes
  or 209 of 210 early-close minutes.
- There are **zero crossed SIP quotes** in the archive. Verify Flink rejects separately: the archive alone does
  not show upstream drops.
- Pooled SIP quote p95 ingest latency is **strictly below 2,000 ms**. Raw bar latency is reported but not gated:
  the bar timestamp labels the minute start, before publication is possible.
- Median eligible SIP spread is **at most 2.0 bp each** for QQQ, SMH, and XLK. Missing eligible quotes for any
  of these symbols fails the gate.

The verifier uses event time in `[open, close)`. The latest ingest timestamp wins a bar's minute, then partition
and offset break ties. Close divergence uses matched symbol/minute pairs, with IEX close as the denominator.
Spreads are `10,000 × (ask − bid) / midpoint` rounded to nine decimal places in bps. Quotes need two positive
prices and sizes; crossed quotes are excluded from spreads while locked quotes count as zero. Staleness counts
received quotes ingested **more than five seconds** after their event time, not quote gaps. Pooled percentiles
weight observations; medians average the middle pair for even counts, and p75/p95 use nearest rank.

IEX covers 22 symbols and does not include XLK. Both feeds use the full 73-symbol coverage denominator, but
missing IEX observations are not zero spreads or zero divergence. Use the common-symbol pool for spread
compression: it is quote-weighted, not time-matched, and does not establish available prices or fill improvement.
Escalate missing or inconsistent IEX evidence rather than treating it as compression.

Run on a host sized for full-session quote samples. Live mode fails rather than truncates when a read exceeds
500,000 bars, 30,000,000 quotes, or 20 minutes. Do not use a reader that silently caps results or combine
percentiles from sampled or split reads.

### Deterministic offline replay

`--fixture` reads a local UTF-8 JSON file of at most 64 MiB without network or credentials:

```sh
bun services/bayn/tools/verify-sip-vs-iex-shadow.ts \
  --session 2026-11-27 --fixture /path/to/shadow-fixture.json --format json
```

Use `{ "session": { "date": "...", "openAt": "...", "closeAt": "..." }, "bars": [], "quotes": [] }` with provider
UTC RTH bounds and rows matching the two deduplicated SELECT projections in the verifier. Timestamps are UTC
strings (up to nine fractional digits), bar offsets are decimal strings, and prices, sizes, flags, partitions,
and versions are JSON numbers. Empty arrays cannot pass. Fixture replay is not live qualification evidence.

### Phase 2 decision

Five passes and the capacity evidence unlock review of **QQQ + SMH + XLK** for Phase 2, not a feed switch or order
permission. Require a separate reviewed, same-feed Bayn replay and policy activation with SPY as benchmark, fresh
SIP quotes and native reconciliation, account, strategy, and risk gates. Any future primary cutover must verify
the live decision and pricing path with canonical SIP provenance and keep IEX available for rollback.

## Rollback

Keep IEX primary if any evidence is missing or fails. If SIP capture affects shared workloads, restore the SIP
producer to zero replicas and detach the shadow ConfigMap (if attached) through reviewed GitOps. Verify IEX progress
and archive restoration from the appropriate savepoint. Retain SIP rows and Kafka records under existing retention
and never replay them as IEX.
