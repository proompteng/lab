import { describe, expect, it } from 'vitest'

import {
  buildGateChecks,
  buildMetricSnapshot,
  diffMetricSnapshots,
  summarizeBenchmarkResult,
  type BenchmarkResultSummary,
  type MetricSnapshot,
  type RunSummary,
} from './benchmark-flamingo-vllm'

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-07-03T10:00:00.000Z',
    promptTokens: 0,
    generationTokens: 0,
    prefixCacheQueries: 0,
    prefixCacheHits: 0,
    promptTokensCached: 0,
    requestSuccess: 0,
    requestErrors: 0,
    requestAborts: 0,
    kvCacheUsagePerc: 0,
    numRequestsRunning: 0,
    numRequestsWaiting: 0,
    preemptions: 0,
    specAcceptedTokens: 0,
    specDrafts: 0,
    ...overrides,
  }
}

function benchmarkSummary(overrides: Partial<BenchmarkResultSummary> = {}): BenchmarkResultSummary {
  return {
    completed: 4,
    failed: 0,
    totalInputTokens: 16384,
    totalOutputTokens: 2048,
    requestThroughput: 4,
    outputThroughput: 300,
    totalTokenThroughput: 2400,
    meanTtftMs: 220,
    medianTtftMs: 210,
    p99TtftMs: 250,
    meanTpotMs: 6,
    medianTpotMs: 5.8,
    p99TpotMs: 8,
    ...overrides,
  }
}

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    startedAt: '2026-07-03T10:00:00.000Z',
    candidateId: 'candidate',
    profile: 'smoke',
    contextTargets: [],
    model: 'qwen36-flamingo',
    tokenizer: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
    baseUrl: 'http://flamingo.ide-newton.ts.net/v1',
    serverUrl: 'http://flamingo.ide-newton.ts.net',
    serverUrls: {
      baseUrl: 'http://flamingo.ide-newton.ts.net/v1',
      serverUrl: 'http://flamingo.ide-newton.ts.net',
    },
    kubernetes: {
      context: 'galactic-tailscale',
      namespace: 'flamingo',
      deployment: 'flamingo',
    },
    deploymentArgs: [
      '--model',
      'unsloth/Qwen3.6-35B-A3B-NVFP4',
      '--served-model-name',
      'qwen36-flamingo',
      '--max-model-len',
      '262144',
      '--gpu-memory-utilization',
      '0.85',
      '--kv-cache-dtype',
      'fp8',
      '--enable-prefix-caching',
    ],
    models: { data: [{ id: 'qwen36-flamingo', max_model_len: 262144 }] },
    metricsBeforeSummary: snapshot(),
    metricsAfterSummary: snapshot({ capturedAt: '2026-07-03T10:01:00.000Z' }),
    measuredMetricDelta: {
      elapsedMs: 60_000,
      promptTokens: 1024,
      generationTokens: 256,
      promptTokensPerSecond: 17,
      generationTokensPerSecond: 4,
      prefixCacheQueries: 0,
      prefixCacheHits: 0,
      promptTokensCached: 0,
      requestSuccess: 4,
      requestErrors: 0,
      requestAborts: 0,
      peakKvCacheUsagePerc: 0.5,
      numRequestsRunning: 1,
      numRequestsWaiting: 0,
      preemptions: 0,
      specAcceptedTokens: 0,
      specDrafts: 0,
    },
    warmups: [],
    smokes: [
      {
        label: 'exact-no-thinking',
        ok: true,
        elapsedMs: 80,
        response: { choices: [{ message: { content: 'qwen36-ready' } }] },
      },
      {
        label: 'medium-thinking',
        ok: true,
        elapsedMs: 3900,
        response: { choices: [{ message: { content: 'qwen36-thinking-ready' } }] },
      },
      {
        label: 'tool-call',
        ok: true,
        elapsedMs: 280,
        response: {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'lookup_status',
                      arguments: '{"id":"FLAMINGO-262K"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    benchmarks: [
      {
        label: 'short-coding-loop-smoke',
        command: ['vllm', 'bench', 'serve'],
        result: {
          command: ['vllm', 'bench', 'serve'],
          code: 0,
          stdout: '',
          stderr: '',
          elapsedMs: 1000,
        },
        resultJson: {},
        resultSummary: benchmarkSummary(),
      },
    ],
    notes: [],
    ...overrides,
  }
}

describe('buildMetricSnapshot', () => {
  it('captures vLLM production counters used by Flamingo gates', () => {
    const metrics = [
      'vllm:prompt_tokens_total 100',
      'vllm:generation_tokens_total 40',
      'vllm:prefix_cache_queries_total 5',
      'vllm:prefix_cache_hits_total 3',
      'vllm:prompt_tokens_cached_total 1024',
      'vllm:request_success_total{finished_reason="stop"} 7',
      'vllm:request_success_total{finished_reason="error"} 1',
      'vllm:request_success_total{finished_reason="abort"} 2',
      'vllm:kv_cache_usage_perc 0.42',
      'vllm:num_requests_running 2',
      'vllm:num_requests_waiting 1',
      'vllm:num_preemptions_total 4',
      'vllm:spec_decode_num_accepted_tokens_total 30',
      'vllm:spec_decode_num_drafts_total 20',
    ].join('\n')

    expect(buildMetricSnapshot(metrics)).toMatchObject({
      promptTokens: 100,
      generationTokens: 40,
      prefixCacheQueries: 5,
      prefixCacheHits: 3,
      promptTokensCached: 1024,
      requestErrors: 1,
      requestAborts: 2,
      kvCacheUsagePerc: 0.42,
      numRequestsRunning: 2,
      numRequestsWaiting: 1,
      preemptions: 4,
      specAcceptedTokens: 30,
      specDrafts: 20,
    })
  })
})

describe('diffMetricSnapshots', () => {
  it('computes real MTP acceptance length from accepted and draft counters', () => {
    const before = snapshot({ capturedAt: '2026-07-03T10:00:00.000Z', specAcceptedTokens: 10, specDrafts: 5 })
    const after = snapshot({
      capturedAt: '2026-07-03T10:00:10.000Z',
      promptTokens: 1000,
      generationTokens: 250,
      prefixCacheQueries: 4,
      prefixCacheHits: 3,
      specAcceptedTokens: 34,
      specDrafts: 17,
    })

    expect(diffMetricSnapshots(before, after)).toMatchObject({
      promptTokens: 1000,
      generationTokens: 250,
      promptTokensPerSecond: 100,
      generationTokensPerSecond: 25,
      prefixCacheHitRate: 0.75,
      specAcceptedTokens: 24,
      specDrafts: 12,
      speculativeAcceptanceLength: 3,
    })
  })
})

describe('summarizeBenchmarkResult', () => {
  it('accepts vLLM snake_case and previous camelCase benchmark result fields', () => {
    expect(
      summarizeBenchmarkResult({
        completed: 4,
        failed: 0,
        total_input_tokens: 16,
        totalOutputTokens: 8,
        output_throughput: 123,
        p99TtftMs: 456,
        mean_tpot_ms: 7.5,
      }),
    ).toMatchObject({
      completed: 4,
      failed: 0,
      totalInputTokens: 16,
      totalOutputTokens: 8,
      outputThroughput: 123,
      p99TtftMs: 456,
      meanTpotMs: 7.5,
    })
  })
})

describe('buildGateChecks', () => {
  it('passes the known-good smoke shape without a baseline', () => {
    const gates = buildGateChecks(runSummary())
    expect(gates.filter((gate) => !gate.ok)).toEqual([])
  })

  it('blocks known-bad single-GPU scheduler flags', () => {
    const gates = buildGateChecks(runSummary({ deploymentArgs: ['--enable-dbo', '--max-num-partial-prefills', '2'] }))
    expect(gates).toContainEqual(
      expect.objectContaining({
        name: 'known-bad single-GPU flag absent: --enable-dbo',
        ok: false,
      }),
    )
    expect(gates).toContainEqual(
      expect.objectContaining({
        name: 'known-bad single-GPU flag absent: --max-num-partial-prefills',
        ok: false,
      }),
    )
  })

  it('enforces the throughput, TTFT, and TPOT promotion gates against a baseline result', () => {
    const current = runSummary({
      candidateId: 'batch-088-24-24576',
      benchmarks: [
        {
          label: 'short-coding-loop-smoke',
          command: ['vllm', 'bench', 'serve'],
          result: { command: [], code: 0, stdout: '', stderr: '', elapsedMs: 1000 },
          resultSummary: benchmarkSummary({
            outputThroughput: 260,
            p99TtftMs: 300,
            meanTpotMs: 7,
          }),
        },
      ],
    })
    const baseline = runSummary({
      candidateId: 'baseline',
      benchmarks: [
        {
          label: 'short-coding-loop-smoke',
          command: ['vllm', 'bench', 'serve'],
          result: { command: [], code: 0, stdout: '', stderr: '', elapsedMs: 1000 },
          resultSummary: benchmarkSummary({
            outputThroughput: 250,
            p99TtftMs: 250,
            meanTpotMs: 6,
          }),
        },
      ],
    })

    const failed = buildGateChecks(current, baseline).filter((gate) => !gate.ok)

    expect(failed).toContainEqual(expect.objectContaining({ name: '1.2x output throughput against baseline' }))
    expect(failed).toContainEqual(expect.objectContaining({ name: 'p99 TTFT regression within 10%' }))
    expect(failed).toContainEqual(expect.objectContaining({ name: 'mean TPOT regression within 5%' }))
  })

  it('requires real speculative counters when profile mtp-al is selected', () => {
    const gates = buildGateChecks(
      runSummary({
        profile: 'mtp-al',
        speculativeDecode: {
          requestedCandidates: [1, 2, 3, 4],
          metricDelta: {
            specAcceptedTokens: 0,
            specDrafts: 0,
          },
          mtpAcceptanceCells: [],
          note: 'test',
        },
      }),
    )

    expect(gates).toContainEqual(
      expect.objectContaining({
        name: 'deployed MTP speculative config is present',
        ok: false,
      }),
    )
    expect(gates).toContainEqual(
      expect.objectContaining({
        name: 'real speculative acceptance length exists',
        ok: false,
      }),
    )
  })
})
