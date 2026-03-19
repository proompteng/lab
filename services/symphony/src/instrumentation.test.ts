import { afterEach, describe, expect, test } from 'bun:test'

import { metrics, trace } from '@proompteng/otel/api'

import {
  __private,
  finishSymphonySpan,
  recordPollTick,
  startSymphonySpan,
  updateRuntimeGauges,
} from './instrumentation'

class FakeCounter {
  readonly calls: Array<{ value: number; attributes?: Record<string, unknown> }> = []

  add(value: number, attributes?: Record<string, unknown>) {
    this.calls.push({ value, attributes })
  }
}

class FakeHistogram {
  readonly calls: Array<{ value: number; attributes?: Record<string, unknown> }> = []

  record(value: number, attributes?: Record<string, unknown>) {
    this.calls.push({ value, attributes })
  }
}

class FakeGauge {
  readonly calls: Array<{ value: number; attributes?: Record<string, unknown> }> = []

  set(value: number, attributes?: Record<string, unknown>) {
    this.calls.push({ value, attributes })
  }
}

class FakeMeter {
  readonly counters = new Map<string, FakeCounter>()
  readonly histograms = new Map<string, FakeHistogram>()
  readonly gauges = new Map<string, FakeGauge>()

  createCounter(name: string) {
    const counter = new FakeCounter()
    this.counters.set(name, counter)
    return counter
  }

  createHistogram(name: string) {
    const histogram = new FakeHistogram()
    this.histograms.set(name, histogram)
    return histogram
  }

  createGauge(name: string) {
    const gauge = new FakeGauge()
    this.gauges.set(name, gauge)
    return gauge
  }
}

class FakeSpan {
  ended = false
  status: { code?: number; message?: string } | undefined

  constructor(
    readonly name: string,
    readonly options?: Record<string, unknown>,
  ) {}

  setStatus(status: { code?: number; message?: string }) {
    this.status = status
  }

  recordException(_error: Error) {}

  end() {
    this.ended = true
  }
}

class FakeTracer {
  readonly spans: FakeSpan[] = []

  startSpan(name: string, options?: Record<string, unknown>) {
    const span = new FakeSpan(name, options)
    this.spans.push(span)
    return span
  }
}

afterEach(() => {
  __private.resetTelemetryStateForTests()
})

describe('instrumentation bindings', () => {
  test('rebinds counters, gauges, and spans to the active global providers', () => {
    const meter = new FakeMeter()
    const tracer = new FakeTracer()

    metrics.setGlobalMeterProvider({
      getMeter() {
        return meter
      },
    })
    trace.setGlobalTracerProvider({
      getTracer() {
        return tracer as unknown as ReturnType<typeof trace.getTracer>
      },
    })

    __private.rebindTelemetryBindingsForTests()

    recordPollTick('success', 42)
    updateRuntimeGauges({
      runningIssues: 3,
      retryQueueSize: 1,
      leaderState: true,
    })

    const span = startSymphonySpan('symphony.test', { foo: 'bar' })
    finishSymphonySpan(span)

    expect(meter.counters.get('symphony_poll_ticks_total')?.calls).toEqual([
      {
        value: 1,
        attributes: {
          instance: 'symphony',
          result: 'success',
        },
      },
    ])
    expect(meter.histograms.get('symphony_poll_duration_ms')?.calls).toEqual([
      {
        value: 42,
        attributes: {
          instance: 'symphony',
          result: 'success',
        },
      },
    ])
    expect(meter.gauges.get('symphony_running_issues')?.calls.at(-1)).toEqual({
      value: 3,
      attributes: {
        instance: 'symphony',
      },
    })
    expect(meter.gauges.get('symphony_retry_queue_size')?.calls.at(-1)).toEqual({
      value: 1,
      attributes: {
        instance: 'symphony',
      },
    })
    expect(meter.gauges.get('symphony_leader_state')?.calls.at(-1)).toEqual({
      value: 1,
      attributes: {
        instance: 'symphony',
      },
    })
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]?.name).toBe('symphony.test')
    expect(tracer.spans[0]?.options).toMatchObject({
      attributes: {
        foo: 'bar',
        instance: 'symphony',
        'service.name': 'symphony',
      },
    })
    expect(tracer.spans[0]?.ended).toBe(true)
  })
})
