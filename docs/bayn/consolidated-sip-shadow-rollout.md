# Consolidated SIP shadow rollout

Wave 11C parks the 73-symbol SIP producer at **zero replicas** and provisions, but does not attach, the archive
settings. IEX remains primary. This change does not authorize activation, a Bayn feed cutover, or trading.
Activate in the order below through [reviewed GitOps and Kargo](../release-automation.md). Do not patch replicas,
ConfigMaps, or Flink jobs in the cluster.

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
and insufficient subscription respectively. On any failure, leave replicas at zero and resolve it with the owner.
If the Secret changes between this check and rollout, repeat the check before activation.

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

Use the [SIP-vs-IEX verifier and qualification guide](https://github.com/proompteng/lab/pull/16399) once that change
is merged. Run from a pinned checkout containing the verifier and locked dependencies. Load existing read-only
`BAYN_CLICKHOUSE_URL`, `BAYN_CLICKHOUSE_USERNAME`, `BAYN_CLICKHOUSE_PASSWORD` and calendar-capable
`BAYN_ALPACA_KEY_ID` / `BAYN_ALPACA_SECRET_KEY` without printing them. Use the matching `BAYN_ALPACA_BASE_URL`
if not using the paper default.

After close and archive drain, run this for each of **five consecutive completed exchange sessions**. Set
`SESSION` to the actual date (`YYYY-MM-DD`); use the provider calendar, including early closes.

```bash
bun services/bayn/tools/verify-sip-vs-iex-shadow.ts --session "${SESSION:?set the session date}" --format json
```

Retain each JSON report, CLI revision, deployed revisions, and lag/reject evidence. Every session must PASS:
canonical 73-symbol identity, at least 99.5% final-minute bar coverage for QQQ/SMH/XLK/SPY, zero archived crosses,
pooled SIP quote ingest p95 below 2 seconds, and median SIP spread no more than 2 bp for QQQ/SMH/XLK individually.
Verify upstream rejects separately; archived quotes alone cannot show upstream drops. IEX lacks XLK, so compare
like-for-like spread compression on the common symbol pool, not against synthetic IEX XLK observations.

Five passes and the capacity evidence unlock review of **QQQ + SMH + XLK** for Phase 2, not a feed switch or order
permission. Require a separate reviewed, same-feed Bayn replay and policy activation, with SPY as benchmark, fresh
SIP quotes and native reconciliation, account, strategy and risk gates. Keep IEX primary if any evidence is missing
or fails. If capture affects shared workloads, restore replicas to zero and detach the shadow ConfigMap (if attached)
through reviewed GitOps. Verify IEX progress and archive restoration from the appropriate savepoint; retain SIP rows
and Kafka records under existing retention and never replay them as IEX.
