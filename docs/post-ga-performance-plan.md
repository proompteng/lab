# Temporal Bun SDK Post-GA Performance Plan

## Goals

- Sustain 128+ workflow load suite without ScheduleToClose failures or poll latency spikes.
- Reduce worker cold-start and replay time by 30%.
- Provide actionable metrics (poll latency, sticky ratio, replay duration) in production dashboards.

## Current Constraints

- Fixed poller counts (`config.workerWorkflowConcurrency`) saturate Arc-class runners.
- Sticky cache snapshots only live in memory per worker.
- Replay CLI defaults to Temporal CLI shelling, serial history decode.
- Transport/TLS handshake per worker start.

## Workstreams

### 1. Adaptive Worker Runtime

- **Dynamic pollers**: sample `temporal_worker_poll_latency_ms` histograms; adjust `workflowPollerCount`/`activityConcurrency` every 30s.
- **Queue-depth telemetry**: emit `temporal_worker_queue_depth` gauge from scheduler.
- **Sticky cache persistence**: write determinism snapshots to shared cache (LRU + TTL) and hydrate on worker start.
- **Heartbeat tuning**: adapt `heartbeatIntervalMs` per activity type using retry counters.

### 2. Replay & History Pipeline

- Prefer WorkflowService transport; maintain CLI fallback.
- Stream decode history pages using protobuf reader; ingest without storing full array.
- Support gzipped histories (`.json.gz`).
- Emit `temporal_replay_history_fetch_ms` and `temporal_replay_decode_ms` histograms.

### 3. Client & Transport

- Memoize Connect transports per address/TLS fingerprint, share across workers.
- Pre-warm TLS by initiating connections asynchronously during worker boot.
- Add jitter to poll loops to avoid thundering herd when multiple workers start simultaneously.

### 4. Observability & Rollout

- Default production config to OTLP exporter (Opt-in via `TEMPORAL_METRICS_EXPORTER=otlp`).
- Publish Grafana dashboard JSON referencing poll latency, sticky ratio, heartbeat retries, replay durations.
- Record worker-load suite artifacts (metrics report) as CI artifact and trend in automation.

## Milestones

1. **Sprint 1**: Adaptive pollers + transport pooling (targets worker cold-start & poll latency).
2. **Sprint 2**: Sticky cache persistence + replay streaming (targets determinism/replay speed).
3. **Sprint 3**: Observability rollout + dashboards + CLI gzip support.

## Metrics & Success Criteria

- Poll p95 < 5s at 128 workflow load (Arc runner).
- Sticky hit ratio > 70% under worker-load.
- Replay CLI end-to-end runtime < 5s for 1 MB histories.
- TLS handshake per worker reduced by >50% (measure via connection logs).

## Risks

- Adaptive pollers require careful coordination to avoid oscillation.
- Sticky cache persistence needs eviction policy to prevent memory bloat.
- Transport pooling must respect per-worker TLS identities if custom certs differ.

## Next Steps

1. Create tracking issue (TBS-008) referencing this plan.
2. Implement adaptive pollers behind `TEMPORAL_DYNAMIC_CONCURRENCY` flag.
3. Prototype shared sticky cache storage (in-memory map + optional Redis).
4. Update replay CLI to use service-first approach and measure using new histograms.
5. Roll out OTLP exporter configuration and dashboards.
