import { readFile } from 'node:fs/promises'

export type MetricRecordType = 'counter' | 'histogram'

export interface MetricLogEntry {
  readonly timestamp: string
  readonly type: MetricRecordType
  readonly name: string
  readonly value: number
  readonly description?: string
}

export interface HistogramStats {
  readonly samples: number
  readonly min: number
  readonly max: number
  readonly average: number
  readonly p50: number
  readonly p90: number
  readonly p95: number
  readonly p99: number
}

export interface WorkerMetricsAggregate {
  readonly counters: Record<string, number>
  readonly histograms: Record<string, HistogramStats>
}

export interface WorkerLoadMetricsSummary {
  readonly stickyCacheHits: number
  readonly stickyCacheMisses: number
  readonly stickyHitRatio: number
  readonly workflowPollLatency?: HistogramStats
  readonly activityPollLatency?: HistogramStats
  readonly workflowPollsPerSecond: number
  readonly workflowThroughputPerSecond: number
}

const WORKFLOW_POLL_METRIC = 'temporal_worker_poll_latency_ms'
const ACTIVITY_POLL_METRIC = 'temporal_worker_activity_poll_latency_ms'
const STICKY_HIT_METRIC = 'temporal_worker_sticky_cache_hits_total'
const STICKY_MISS_METRIC = 'temporal_worker_sticky_cache_misses_total'

export const readMetricsFromFile = async (metricsPath: string): Promise<WorkerMetricsAggregate> => {
  const counters: Record<string, number> = {}
  const histogramValues = new Map<string, number[]>()
  let contents: string
  try {
    contents = await readFile(metricsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { counters: {}, histograms: {} }
    }
    throw error
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const entry = JSON.parse(trimmed) as Partial<MetricLogEntry>
      if (!entry.name || typeof entry.value !== 'number' || (entry.type !== 'counter' && entry.type !== 'histogram')) {
        continue
      }
      if (entry.type === 'counter') {
        counters[entry.name] = (counters[entry.name] ?? 0) + entry.value
      } else {
        const values = histogramValues.get(entry.name) ?? []
        values.push(entry.value)
        histogramValues.set(entry.name, values)
      }
    } catch {
      // Ignore malformed lines; the exporter writes JSONL sequentially.
    }
  }

  const histograms: Record<string, HistogramStats> = {}
  for (const [name, values] of histogramValues) {
    histograms[name] = buildHistogram(values)
  }

  return { counters, histograms }
}

export const summarizeLoadMetrics = (
  aggregate: WorkerMetricsAggregate,
  options: { readonly durationMs: number; readonly completedWorkflows: number },
): WorkerLoadMetricsSummary => {
  const durationSeconds = Math.max(options.durationMs / 1_000, 1)
  const workflowPollLatency = aggregate.histograms[WORKFLOW_POLL_METRIC]
  const activityPollLatency = aggregate.histograms[ACTIVITY_POLL_METRIC]
  const stickyHits = aggregate.counters[STICKY_HIT_METRIC] ?? 0
  const stickyMisses = aggregate.counters[STICKY_MISS_METRIC] ?? 0
  const stickyTotal = stickyHits + stickyMisses
  const stickyHitRatio = stickyTotal === 0 ? 0 : stickyHits / stickyTotal
  const workflowPolls = workflowPollLatency?.samples ?? 0

  return {
    stickyCacheHits: stickyHits,
    stickyCacheMisses: stickyMisses,
    stickyHitRatio,
    workflowPollLatency,
    activityPollLatency,
    workflowPollsPerSecond: workflowPolls / durationSeconds,
    workflowThroughputPerSecond: options.completedWorkflows / durationSeconds,
  }
}

const buildHistogram = (values: number[]): HistogramStats => {
  if (values.length === 0) {
    return {
      samples: 0,
      min: 0,
      max: 0,
      average: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const samples = sorted.length
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  return {
    samples,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average: sum / samples,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  }
}

const percentile = (values: number[], percentileRank: number): number => {
  if (values.length === 0) {
    return 0
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(percentileRank * values.length) - 1))
  return values[index]
}
