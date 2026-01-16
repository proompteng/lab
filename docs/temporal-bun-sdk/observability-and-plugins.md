# Temporal Bun SDK - Observability and Plugins

## Goal
Deliver a unified observability pipeline and extensibility model that is more
capable than the TypeScript SDK, without relying on sandboxed workflows.

## Non-Goals
- Embedding a full OTEL collector.
- Replacing external APM systems.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. Unified metrics/logging/tracing for worker, activities, workflows, and
   (future) Nexus operations.
3. Workflow-safe telemetry sinks with replay gating.
4. Plugin system for worker bootstrap, scheduling, and config.
5. Tuner for dynamic concurrency (resource-based or custom).
6. Exporters: in-memory, file, OTLP, Prometheus.

## API Sketch
```ts
const { worker } = await createWorker({
  workflowsPath,
  activities,
  plugins: [metricsPlugin(), tracingPlugin()],
  tuner: resourceBasedTuner({ targetCpu: 0.7, targetMem: 0.6 }),
})

const { log, metrics } = workflowTelemetry()
log.info('inside workflow', { runId: info.runId })
metrics.counter('workflow.step').inc(1)
```

## Implementation Notes
- Implement workflow telemetry as a sink-like layer with deterministic buffers.
- Integrate with Effect services for logger, metrics, tracer.
- Provide a plugin lifecycle: preConfig -> postConfig -> runtime.

## Acceptance Criteria
- Tracing spans correlate client -> worker -> activity.
- Plugins can add interceptors and mutate config safely.
- Tuner adjusts concurrency without starvation or oscillation.
