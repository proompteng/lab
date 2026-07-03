#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type CommandResult = {
  command: string[]
  code: number | null
  stdout: string
  stderr: string
  elapsedMs: number
}

type ChatResult = {
  label: string
  ok: boolean
  elapsedMs: number
  status?: number
  response?: unknown
  error?: string
}

type BenchmarkRun = {
  label: string
  command: string[]
  result: CommandResult
  resultJson?: unknown
  resultSummary?: BenchmarkResultSummary
}

type BenchmarkResultSummary = {
  completed?: number
  failed?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  requestThroughput?: number
  outputThroughput?: number
  totalTokenThroughput?: number
  meanTtftMs?: number
  medianTtftMs?: number
  p99TtftMs?: number
  meanTpotMs?: number
  medianTpotMs?: number
  p99TpotMs?: number
}

type MetricSnapshot = {
  capturedAt: string
  promptTokens: number
  generationTokens: number
  prefixCacheQueries: number
  prefixCacheHits: number
  promptTokensCached: number
  requestSuccess: number
  requestErrors: number
  requestAborts: number
  kvCacheUsagePerc: number
  numRequestsRunning: number
  numRequestsWaiting: number
  specAcceptedTokens: number
  specDrafts: number
}

type MetricDelta = {
  elapsedMs: number
  promptTokens: number
  generationTokens: number
  promptTokensPerSecond: number
  generationTokensPerSecond: number
  prefixCacheQueries: number
  prefixCacheHits: number
  prefixCacheHitRate?: number
  promptTokensCached: number
  requestSuccess: number
  requestErrors: number
  requestAborts: number
  peakKvCacheUsagePerc: number
  specAcceptedTokens: number
  specDrafts: number
  speculativeAcceptanceLength?: number
}

type SpeculativeDecodeSummary = {
  requestedCandidates: number[]
  deployedConfig?: unknown
  metricDelta: Pick<MetricDelta, 'specAcceptedTokens' | 'specDrafts' | 'speculativeAcceptanceLength'>
  note: string
}

type RunSummary = {
  startedAt: string
  finishedAt?: string
  profile: string
  contextTargets: number[]
  model: string
  tokenizer: string
  baseUrl: string
  serverUrl: string
  kubernetes: {
    context: string
    namespace: string
    deployment: string
  }
  deploymentArgs?: string[]
  models?: unknown
  metricsBefore?: string
  metricsAfterWarmup?: string
  metricsAfter?: string
  metricsBeforeSummary?: MetricSnapshot
  metricsAfterWarmupSummary?: MetricSnapshot
  metricsAfterSummary?: MetricSnapshot
  warmupMetricDelta?: MetricDelta
  measuredMetricDelta?: MetricDelta
  nvidiaSmiBefore?: string
  nvidiaSmiAfter?: string
  warmups: BenchmarkRun[]
  smokes: ChatResult[]
  benchmarks: BenchmarkRun[]
  speculativeDecode?: SpeculativeDecodeSummary
  notes: string[]
}

const args = new Map<string, string>()

for (const arg of process.argv.slice(2)) {
  const [key, value = ''] = arg.split('=', 2)
  if (key.startsWith('--')) {
    args.set(key.slice(2), value || 'true')
  }
}

const profile = args.get('profile') ?? process.env.FLAMINGO_BENCH_PROFILE ?? 'smoke'
const kubeContext = args.get('context') ?? process.env.KUBE_CONTEXT ?? 'galactic-tailscale'
const namespace = args.get('namespace') ?? process.env.FLAMINGO_NAMESPACE ?? 'flamingo'
const deployment = args.get('deployment') ?? process.env.FLAMINGO_DEPLOYMENT ?? 'flamingo'
const model = args.get('model') ?? process.env.FLAMINGO_MODEL ?? 'qwen36-flamingo'
const tokenizer = args.get('tokenizer') ?? process.env.FLAMINGO_BENCH_TOKENIZER ?? 'unsloth/Qwen3.6-35B-A3B-NVFP4'
const baseUrl = (
  args.get('base-url') ??
  process.env.FLAMINGO_BASE_URL ??
  'http://flamingo.ide-newton.ts.net/v1'
).replace(/\/+$/, '')
const serverUrl = (args.get('server-url') ?? process.env.FLAMINGO_SERVER_URL ?? baseUrl.replace(/\/v1$/, '')).replace(
  /\/+$/,
  '',
)
const resultDir = resolve(args.get('result-dir') ?? process.env.FLAMINGO_BENCH_RESULT_DIR ?? '/tmp/flamingo-vllm-bench')
const timeoutMs = Number.parseInt(args.get('timeout-ms') ?? process.env.FLAMINGO_BENCH_TIMEOUT_MS ?? '1800000', 10)
const benchmarkResultMarker = '__FLAMINGO_BENCH_RESULT_JSON__'
const enableWarmup = (args.get('warmup') ?? process.env.FLAMINGO_BENCH_WARMUP ?? 'true') !== 'false'
const contextTargets = (
  args.get('long-targets') ??
  process.env.FLAMINGO_LONG_TARGETS ??
  (profile === 'full' ? '180000,220000,229000' : '')
)
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0)
const mtpCandidates = (args.get('mtp-candidates') ?? process.env.FLAMINGO_MTP_CANDIDATES ?? '1,2,3,4')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0)

async function run(command: string[], timeout = timeoutMs): Promise<CommandResult> {
  const started = Date.now()

  return await new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeout)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('close', (code) => {
      done = true
      clearTimeout(timer)
      resolvePromise({
        command,
        code,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
      })
    })
  })
}

function kubectl(args: string[]): string[] {
  return ['kubectl', '--context', kubeContext, '-n', namespace, ...args]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.FLAMINGO_API_KEY ?? 'flamingo-local'}`,
      ...init?.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`)
  }

  return text.length > 0 ? JSON.parse(text) : null
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(`${serverUrl}${path}`, {
    headers: {
      authorization: `Bearer ${process.env.FLAMINGO_API_KEY ?? 'flamingo-local'}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`)
  }

  return await response.text()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberField(record: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = firstNumber(record[field])
    if (value !== undefined) return value
  }
  return undefined
}

function parseMetric(text: string, metricName: string, requiredLabel?: string): number {
  let total = 0
  let found = false

  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue
    if (!line.startsWith(`${metricName}{`) && !line.startsWith(`${metricName} `)) continue
    if (requiredLabel && !line.includes(requiredLabel)) continue

    const value = Number.parseFloat(line.trim().split(/\s+/).at(-1) ?? '')
    if (!Number.isFinite(value)) continue
    total += value
    found = true
  }

  return found ? total : 0
}

function buildMetricSnapshot(text: string): MetricSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    promptTokens: parseMetric(text, 'vllm:prompt_tokens_total'),
    generationTokens: parseMetric(text, 'vllm:generation_tokens_total'),
    prefixCacheQueries: parseMetric(text, 'vllm:prefix_cache_queries_total'),
    prefixCacheHits: parseMetric(text, 'vllm:prefix_cache_hits_total'),
    promptTokensCached: parseMetric(text, 'vllm:prompt_tokens_cached_total'),
    requestSuccess: parseMetric(text, 'vllm:request_success_total'),
    requestErrors: parseMetric(text, 'vllm:request_success_total', 'finished_reason="error"'),
    requestAborts: parseMetric(text, 'vllm:request_success_total', 'finished_reason="abort"'),
    kvCacheUsagePerc: parseMetric(text, 'vllm:kv_cache_usage_perc'),
    numRequestsRunning: parseMetric(text, 'vllm:num_requests_running'),
    numRequestsWaiting: parseMetric(text, 'vllm:num_requests_waiting'),
    specAcceptedTokens: parseMetric(text, 'vllm:spec_decode_num_accepted_tokens_total'),
    specDrafts: parseMetric(text, 'vllm:spec_decode_num_drafts_total'),
  }
}

function diffMetricSnapshots(before: MetricSnapshot, after: MetricSnapshot): MetricDelta {
  const elapsedMs = Math.max(1, Date.parse(after.capturedAt) - Date.parse(before.capturedAt))
  const elapsedSeconds = elapsedMs / 1000
  const promptTokens = after.promptTokens - before.promptTokens
  const generationTokens = after.generationTokens - before.generationTokens
  const prefixCacheQueries = after.prefixCacheQueries - before.prefixCacheQueries
  const prefixCacheHits = after.prefixCacheHits - before.prefixCacheHits
  const specDrafts = after.specDrafts - before.specDrafts
  const specAcceptedTokens = after.specAcceptedTokens - before.specAcceptedTokens

  return {
    elapsedMs,
    promptTokens,
    generationTokens,
    promptTokensPerSecond: promptTokens / elapsedSeconds,
    generationTokensPerSecond: generationTokens / elapsedSeconds,
    prefixCacheQueries,
    prefixCacheHits,
    prefixCacheHitRate: prefixCacheQueries > 0 ? prefixCacheHits / prefixCacheQueries : undefined,
    promptTokensCached: after.promptTokensCached - before.promptTokensCached,
    requestSuccess: after.requestSuccess - before.requestSuccess,
    requestErrors: after.requestErrors - before.requestErrors,
    requestAborts: after.requestAborts - before.requestAborts,
    peakKvCacheUsagePerc: Math.max(before.kvCacheUsagePerc, after.kvCacheUsagePerc),
    specAcceptedTokens,
    specDrafts,
    speculativeAcceptanceLength: specDrafts > 0 ? 1 + specAcceptedTokens / specDrafts : undefined,
  }
}

function summarizeBenchmarkResult(resultJson: unknown): BenchmarkResultSummary | undefined {
  if (!isRecord(resultJson)) return undefined

  return {
    completed: numberField(resultJson, ['completed']),
    failed: numberField(resultJson, ['failed']),
    totalInputTokens: numberField(resultJson, ['total_input_tokens', 'totalInputTokens']),
    totalOutputTokens: numberField(resultJson, ['total_output_tokens', 'totalOutputTokens']),
    requestThroughput: numberField(resultJson, ['request_throughput', 'requestThroughput']),
    outputThroughput: numberField(resultJson, ['output_throughput', 'outputThroughput']),
    totalTokenThroughput: numberField(resultJson, ['total_token_throughput', 'totalTokenThroughput']),
    meanTtftMs: numberField(resultJson, ['mean_ttft_ms', 'meanTtftMs']),
    medianTtftMs: numberField(resultJson, ['median_ttft_ms', 'medianTtftMs']),
    p99TtftMs: numberField(resultJson, ['p99_ttft_ms', 'p99TtftMs']),
    meanTpotMs: numberField(resultJson, ['mean_tpot_ms', 'meanTpotMs']),
    medianTpotMs: numberField(resultJson, ['median_tpot_ms', 'medianTpotMs']),
    p99TpotMs: numberField(resultJson, ['p99_tpot_ms', 'p99TpotMs']),
  }
}

function readFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1]
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1)
  }
  return undefined
}

function parseJsonFlag(argv: string[], flag: string): unknown {
  const value = readFlagValue(argv, flag)
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function buildSpeculativeDecodeSummary(
  deploymentArgs: string[],
  measuredMetricDelta: MetricDelta,
): SpeculativeDecodeSummary {
  const deployedConfig = parseJsonFlag(deploymentArgs, '--speculative-config')
  const metricDelta = {
    specAcceptedTokens: measuredMetricDelta.specAcceptedTokens,
    specDrafts: measuredMetricDelta.specDrafts,
    speculativeAcceptanceLength: measuredMetricDelta.speculativeAcceptanceLength,
  }
  const note =
    deployedConfig === undefined
      ? 'No deployed --speculative-config detected; run one MTP candidate at a time and compare this acceptance-length readback.'
      : 'Measured real vLLM speculative accepted-token and draft counters for the deployed speculative configuration.'

  return {
    requestedCandidates: mtpCandidates,
    deployedConfig,
    metricDelta,
    note,
  }
}

async function chatSmoke(label: string, payload: unknown): Promise<ChatResult> {
  const started = Date.now()
  try {
    const response = await fetchJson('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return { label, ok: true, elapsedMs: Date.now() - started, response }
  } catch (error) {
    return {
      label,
      ok: false,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildLongPrompt(targetTokens: number, marker: string): string {
  const filler = 'x '.repeat(targetTokens)
  return [
    `Remember the marker ${marker}.`,
    'The following filler exists only to validate long-context recall.',
    filler,
    `Return exactly: ${marker}`,
  ].join('\n')
}

async function runBench(label: string, inputLen: number, outputLen: number, numPrompts: number, concurrency: number) {
  const podDir = `/tmp/flamingo-bench-${Date.now()}-${label}`
  const resultFile = `${label}.json`
  const benchCommand = [
    'vllm',
    'bench',
    'serve',
    '--backend',
    'openai-chat',
    '--base-url',
    'http://127.0.0.1:8000',
    '--endpoint',
    '/v1/chat/completions',
    '--model',
    model,
    '--tokenizer',
    tokenizer,
    '--trust-remote-code',
    '--dataset-name',
    'random',
    '--random-input-len',
    String(inputLen),
    '--random-output-len',
    String(outputLen),
    '--num-prompts',
    String(numPrompts),
    '--max-concurrency',
    String(concurrency),
    '--save-result',
    '--result-dir',
    podDir,
    '--result-filename',
    resultFile,
  ]
  const command = kubectl([
    'exec',
    `deploy/${deployment}`,
    '--',
    'sh',
    '-lc',
    [
      `mkdir -p ${shellQuote(podDir)}`,
      benchCommand.map(shellQuote).join(' '),
      `printf '\\n${benchmarkResultMarker}\\n'`,
      `cat ${shellQuote(`${podDir}/${resultFile}`)}`,
    ].join(' && '),
  ])
  const result = await run(command)
  let resultJson: unknown
  try {
    const markerIndex = result.stdout.lastIndexOf(benchmarkResultMarker)
    if (markerIndex >= 0) {
      resultJson = JSON.parse(result.stdout.slice(markerIndex + benchmarkResultMarker.length).trim())
    }
  } catch {
    resultJson = undefined
  }

  return { label, command, result, resultJson, resultSummary: summarizeBenchmarkResult(resultJson) }
}

async function main(): Promise<void> {
  if (profile !== 'smoke' && profile !== 'full') {
    throw new Error(`--profile must be smoke or full, got ${profile}`)
  }

  await mkdir(resultDir, { recursive: true })

  const summary: RunSummary = {
    startedAt: new Date().toISOString(),
    profile,
    contextTargets,
    model,
    tokenizer,
    baseUrl,
    serverUrl,
    kubernetes: { context: kubeContext, namespace, deployment },
    warmups: [],
    smokes: [],
    benchmarks: [],
    notes: [],
  }

  const deploymentJson = await run(kubectl(['get', 'deployment', deployment, '-o', 'json']))
  if (deploymentJson.code !== 0) {
    throw new Error(`failed to read deployment: ${deploymentJson.stderr}`)
  }
  const parsedDeployment = JSON.parse(deploymentJson.stdout) as {
    spec?: { template?: { spec?: { containers?: Array<{ name?: string; args?: string[] }> } } }
  }
  summary.deploymentArgs =
    parsedDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')?.args ?? []

  summary.models = await fetchJson('/models')
  summary.metricsBefore = await fetchText('/metrics')
  const metricsBeforeSummary = buildMetricSnapshot(summary.metricsBefore)
  summary.metricsBeforeSummary = metricsBeforeSummary
  summary.nvidiaSmiBefore = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout

  if (enableWarmup) {
    const warmupProfiles =
      profile === 'full'
        ? [
            ['warmup-c1', 1024, 16, 1, 1] as const,
            ['warmup-c2', 2048, 16, 2, 2] as const,
            ['warmup-c4', 4096, 16, 4, 4] as const,
            ['warmup-c8', 4096, 16, 8, 8] as const,
            ['warmup-c16', 4096, 16, 16, 16] as const,
            ['warmup-long-prefill', 32768, 16, 2, 2] as const,
          ]
        : [['warmup-c1', 1024, 16, 1, 1] as const, ['warmup-c2', 2048, 16, 2, 2] as const]

    for (const [label, inputLen, outputLen, numPrompts, concurrency] of warmupProfiles) {
      summary.warmups.push(await runBench(label, inputLen, outputLen, numPrompts, concurrency))
    }
  } else {
    summary.notes.push('warmup disabled by --warmup=false or FLAMINGO_BENCH_WARMUP=false')
  }

  summary.metricsAfterWarmup = await fetchText('/metrics')
  const metricsAfterWarmupSummary = buildMetricSnapshot(summary.metricsAfterWarmup)
  summary.metricsAfterWarmupSummary = metricsAfterWarmupSummary
  summary.warmupMetricDelta = diffMetricSnapshots(metricsBeforeSummary, metricsAfterWarmupSummary)

  summary.smokes.push(
    await chatSmoke('exact-no-thinking', {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: qwen36-ready' }],
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 16,
      temperature: 0,
    }),
  )

  summary.smokes.push(
    await chatSmoke('medium-thinking', {
      model,
      messages: [{ role: 'user', content: 'Reason briefly, then answer exactly: qwen36-thinking-ready' }],
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 2048,
      temperature: 0,
    }),
  )

  summary.smokes.push(
    await chatSmoke('tool-call', {
      model,
      messages: [{ role: 'user', content: 'Use the lookup_status tool for id FLAMINGO-262K and no other tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_status',
            description: 'Look up rollout status by id.',
            strict: true,
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 128,
      temperature: 0,
    }),
  )

  for (const target of contextTargets) {
    const marker = `flamingo-long-${target}`
    summary.smokes.push(
      await chatSmoke(`long-context-${target}`, {
        model,
        messages: [{ role: 'user', content: buildLongPrompt(target, marker) }],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 32,
        temperature: 0,
      }),
    )
  }

  const benchProfiles =
    profile === 'full'
      ? [
          ['scheduler-4k512', 4096, 512, 16, 4] as const,
          ['scheduler-32k4k', 32768, 4096, 8, 2] as const,
          ['scheduler-128k512', 131072, 512, 4, 2] as const,
        ]
      : [['short-coding-loop-smoke', 4096, 512, 4, 2] as const]

  for (const [label, inputLen, outputLen, numPrompts, concurrency] of benchProfiles) {
    summary.benchmarks.push(await runBench(label, inputLen, outputLen, numPrompts, concurrency))
  }

  if (profile === 'full') {
    const sharedPrefix = `${'shared repository context line\n'.repeat(12000)}\nReturn exactly: prefix-cache-ready`
    summary.smokes.push(
      await chatSmoke('prefix-cache-first', {
        model,
        messages: [{ role: 'user', content: sharedPrefix }],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 16,
        temperature: 0,
      }),
    )
    summary.smokes.push(
      await chatSmoke('prefix-cache-second', {
        model,
        messages: [{ role: 'user', content: sharedPrefix }],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 16,
        temperature: 0,
      }),
    )
  }

  summary.metricsAfter = await fetchText('/metrics')
  const metricsAfterSummary = buildMetricSnapshot(summary.metricsAfter)
  summary.metricsAfterSummary = metricsAfterSummary
  summary.measuredMetricDelta = diffMetricSnapshots(metricsAfterWarmupSummary, metricsAfterSummary)
  summary.speculativeDecode = buildSpeculativeDecodeSummary(summary.deploymentArgs, summary.measuredMetricDelta)
  summary.nvidiaSmiAfter = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout
  summary.finishedAt = new Date().toISOString()

  const outputPath = join(resultDir, `flamingo-${profile}-${summary.startedAt.replace(/[:.]/g, '-')}.json`)
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  const failedSmokes = summary.smokes.filter((smoke) => !smoke.ok)
  const failedWarmups = summary.warmups.filter((warmup) => warmup.result.code !== 0)
  const failedBenchmarks = summary.benchmarks.filter((benchmark) => benchmark.result.code !== 0)
  console.log(
    JSON.stringify({
      outputPath,
      failedSmokes: failedSmokes.length,
      failedWarmups: failedWarmups.length,
      failedBenchmarks: failedBenchmarks.length,
      measuredMetricDelta: summary.measuredMetricDelta,
      speculativeDecode: summary.speculativeDecode,
    }),
  )

  if (failedSmokes.length > 0 || failedWarmups.length > 0 || failedBenchmarks.length > 0) {
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
