# Test & Load Harness

## Replay script (concept)
- Use a simple producer to replay recorded Alpaca JSON lines into Kafka for trades/quotes/bars.
- Example (kcat):
```bash
kcat -b $KAFKA_BOOTSTRAP \
  -X security.protocol=SASL_SSL \
  -X sasl.mechanisms=SCRAM-SHA-512 \
  -X sasl.username=$USER -X sasl.password=$PASS \
  -t torghut.nvda.trades.v1 -K: -l samples/nvda-trades.jsonl
```
Where `nvda-trades.jsonl` contains `<key>:<value>` JSON lines keyed by symbol.

## Lag measurement
- Consumer benchmark:
```bash
kcat -b $KAFKA_BOOTSTRAP -t torghut.nvda.ta.signals.v1 \
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
