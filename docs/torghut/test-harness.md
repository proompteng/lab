# Test & Load Harness

> Note: Canonical production-facing design docs live in `docs/torghut/design-system/README.md` (v1). This document is supporting material and may drift from the current deployed manifests.

## Replay script (concept)

- Use a simple producer to replay recorded Alpaca JSON lines into Kafka for trades/quotes/bars.
- Example (kcat):

```bash
kcat -b $KAFKA_BOOTSTRAP \
  -X security.protocol=SASL_SSL \
  -X sasl.mechanisms=SCRAM-SHA-512 \
  -X sasl.username=$USER -X sasl.password=$PASS \
  -t torghut.trades.v1 -K: -l samples/nvda-trades.jsonl
```

Where `nvda-trades.jsonl` contains `<key>:<value>` JSON lines keyed by symbol.

## Alpaca sandbox WS checks

- Market data test feed: `wss://stream.data.sandbox.alpaca.markets/v2/iex` (use `sip` path if you have SIP entitlement). Use symbol `FAKEPACA` for local smoke if your account has no real entitlements.
- Paper trading updates: `wss://stream.trading.alpaca.markets/v2/paper` with the same key/secret as your paper account.
- Quick auth + subscribe with websocat:
  ```bash
  websocat "wss://stream.data.sandbox.alpaca.markets/v2/iex" \
    -H "Authorization: Bearer $ALPACA_KEY_ID" \
    -H "x-alpaca-secret-key: $ALPACA_SECRET_KEY" \
    -E
  # Send: {"action":"subscribe","trades":["NVDA"],"quotes":["NVDA"],"bars":["NVDA"],"updatedBars":["NVDA"]}
  ```

## Lag measurement

- Consumer benchmark:

```bash
kcat -b $KAFKA_BOOTSTRAP -t torghut.ta.signals.v1 \
  -C -o end -q -c 1000 -J \
  | jq 'now*1000 - (.event_ts | fromdateiso8601*1000)'
```

- Or a Python script that tracks p50/p95/p99 of (ingest_ts vs now) and (event_ts vs now).

## Failure drills

- Kill JM/TM pod: `kubectl delete pod -l app.kubernetes.io/component=taskmanager -n torghut` and verify recovery from checkpoint.
- Drop WS connection: `kubectl exec <forwarder-pod> -- pkill -f websocket` and confirm reconnect/status.

## Fixtures

- Store FAKEPACA and NVDA slices under `docs/torghut/fixtures/` (add when available) for reproducible tests.
- Include both trades and quotes; keep event_ts fields intact for lag measurement.

## Acceptance checks

- p99(now - event_ts) ≤ 500 ms (target)
- No duplicate seq per symbol after restart (read_committed consumer)
- Checkpoint age < 2 × interval and sink txn failures = 0 during load
