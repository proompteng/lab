#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export type BenchmarkResultSummary = {
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

export type MetricSnapshot = {
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
  preemptions: number
  specAcceptedTokens: number
  specDrafts: number
}

export type MetricDelta = {
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
  numRequestsRunning: number
  numRequestsWaiting: number
  preemptions: number
  specAcceptedTokens: number
  specDrafts: number
  speculativeAcceptanceLength?: number
}

type SpeculativeDecodeSummary = {
  requestedCandidates: number[]
  deployedConfig?: unknown
  metricDelta: Pick<MetricDelta, 'specAcceptedTokens' | 'specDrafts' | 'speculativeAcceptanceLength'>
  mtpAcceptanceCells: MtpAcceptanceCell[]
  note: string
}

type MtpAcceptanceCell = {
  label: string
  thinking: boolean
  ok: boolean
  elapsedMs: number
  metricsBeforeSummary: MetricSnapshot
  metricsAfterSummary: MetricSnapshot
  metricDelta: MetricDelta
  chat: ChatResult
}

type RuntimeEvidence = {
  argo?: {
    sync?: string
    health?: string
    revision?: string
    operation?: string
    reconciledAt?: string
  }
  deploymentImage?: string
  podImageIDs?: string[]
  podNames?: string[]
  podEvents?: string
  vllmLogTail?: string
}

export type GateCheck = {
  name: string
  ok: boolean
  actual?: number | string
  threshold?: number | string
  note?: string
}

export type RunSummary = {
  startedAt: string
  finishedAt?: string
  candidateId: string
  profile: string
  contextTargets: number[]
  model: string
  tokenizer: string
  baseUrl: string
  serverUrl: string
  baselineResultPath?: string
  serverUrls: {
    baseUrl: string
    serverUrl: string
  }
  kubernetes: {
    context: string
    namespace: string
    deployment: string
  }
  runtimeEvidence?: RuntimeEvidence
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
  baselineComparison?: {
    baselineCandidateId?: string
    baselineProfile?: string
    primaryCurrent?: BenchmarkResultSummary
    primaryBaseline?: BenchmarkResultSummary
  }
  nvidiaSmiBefore?: string
  nvidiaSmiAfter?: string
  warmups: BenchmarkRun[]
  smokes: ChatResult[]
  benchmarks: BenchmarkRun[]
  speculativeDecode?: SpeculativeDecodeSummary
  gateChecks?: GateCheck[]
  gateFailures?: GateCheck[]
  fatalError?: string
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
const candidateId = args.get('candidate-id') ?? process.env.FLAMINGO_CANDIDATE_ID ?? 'live'
const baselineResultPath = args.get('baseline-result') ?? process.env.FLAMINGO_BASELINE_RESULT
const failOnGate = (args.get('fail-on-gate') ?? process.env.FLAMINGO_BENCH_FAIL_ON_GATE ?? 'false') !== 'false'
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

function kubectl(commandArgs: string[]): string[] {
  return ['kubectl', '--context', kubeContext, '-n', namespace, ...commandArgs]
}

function kubectlNamespace(targetNamespace: string, commandArgs: string[]): string[] {
  return ['kubectl', '--context', kubeContext, '-n', targetNamespace, ...commandArgs]
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

export function buildMetricSnapshot(text: string): MetricSnapshot {
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
    preemptions:
      parseMetric(text, 'vllm:num_preemptions_total') +
      parseMetric(text, 'vllm:preemption_total') +
      parseMetric(text, 'vllm:preemptions_total'),
    specAcceptedTokens: parseMetric(text, 'vllm:spec_decode_num_accepted_tokens_total'),
    specDrafts: parseMetric(text, 'vllm:spec_decode_num_drafts_total'),
  }
}

export function diffMetricSnapshots(before: MetricSnapshot, after: MetricSnapshot): MetricDelta {
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
    numRequestsRunning: Math.max(before.numRequestsRunning, after.numRequestsRunning),
    numRequestsWaiting: Math.max(before.numRequestsWaiting, after.numRequestsWaiting),
    preemptions: after.preemptions - before.preemptions,
    specAcceptedTokens,
    specDrafts,
    speculativeAcceptanceLength: specDrafts > 0 ? 1 + specAcceptedTokens / specDrafts : undefined,
  }
}

export function summarizeBenchmarkResult(resultJson: unknown): BenchmarkResultSummary | undefined {
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
  mtpAcceptanceCells: MtpAcceptanceCell[],
): SpeculativeDecodeSummary {
  const deployedConfig = parseJsonFlag(deploymentArgs, '--speculative-config')
  const metricDelta = {
    specAcceptedTokens: measuredMetricDelta.specAcceptedTokens,
    specDrafts: measuredMetricDelta.specDrafts,
    speculativeAcceptanceLength: measuredMetricDelta.speculativeAcceptanceLength,
  }
  const note =
    deployedConfig === undefined
      ? 'No deployed --speculative-config detected; MTP AL cells can only measure a deployed MTP candidate.'
      : 'Measured real vLLM speculative accepted-token and draft counters for the deployed speculative configuration.'

  return {
    requestedCandidates: mtpCandidates,
    deployedConfig,
    metricDelta,
    mtpAcceptanceCells,
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

function buildMtpAcceptancePrompt(thinking: boolean): string {
  const mode = thinking ? 'thinking-on' : 'thinking-off'
  return [
    `You are validating Flamingo MTP acceptance in ${mode} mode.`,
    'Write a concise TypeScript function that validates an array of benchmark gate results.',
    'Mention the exact marker flamingo-mtp-acceptance-ready in the final sentence.',
    'Do not call tools.',
  ].join('\n')
}

function chatContent(result: ChatResult): string {
  if (!isRecord(result.response)) return ''
  const choices = result.response.choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.message)) return ''
  const content = first.message.content
  return typeof content === 'string' ? content : ''
}

function chatToolCalls(result: ChatResult): unknown[] {
  if (!isRecord(result.response)) return []
  const choices = result.response.choices
  if (!Array.isArray(choices)) return []
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.message)) return []
  const toolCalls = first.message.tool_calls
  return Array.isArray(toolCalls) ? toolCalls : []
}

function modelEntries(models: unknown): Record<string, unknown>[] {
  if (!isRecord(models) || !Array.isArray(models.data)) return []
  return models.data.filter(isRecord)
}

function modelIds(models: unknown): string[] {
  return modelEntries(models)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string')
}

function modelMaxLen(models: unknown, modelId: string): number | undefined {
  const entry = modelEntries(models).find((item) => item.id === modelId)
  return entry ? numberField(entry, ['max_model_len', 'maxModelLen']) : undefined
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

async function runMtpAcceptanceCell(label: string, thinking: boolean): Promise<MtpAcceptanceCell> {
  const metricsBeforeSummary = buildMetricSnapshot(await fetchText('/metrics'))
  const started = Date.now()
  const chat = await chatSmoke(label, {
    model,
    messages: [{ role: 'user', content: buildMtpAcceptancePrompt(thinking) }],
    chat_template_kwargs: { enable_thinking: thinking },
    max_tokens: 512,
    temperature: thinking ? 0.6 : 0.7,
    top_p: thinking ? 0.95 : 0.8,
    presence_penalty: thinking ? 0 : 1.5,
  })
  const metricsAfterSummary = buildMetricSnapshot(await fetchText('/metrics'))
  const metricDelta = diffMetricSnapshots(metricsBeforeSummary, metricsAfterSummary)

  return {
    label,
    thinking,
    ok: chat.ok,
    elapsedMs: Date.now() - started,
    metricsBeforeSummary,
    metricsAfterSummary,
    metricDelta,
    chat,
  }
}

function findPrimaryBenchmark(summary: Pick<RunSummary, 'benchmarks'>): BenchmarkResultSummary | undefined {
  const preferredLabels = ['short-coding-loop-smoke', 'scheduler-4k512']
  for (const label of preferredLabels) {
    const found = summary.benchmarks.find((benchmark) => benchmark.label === label)?.resultSummary
    if (found) return found
  }
  return summary.benchmarks.find((benchmark) => benchmark.resultSummary !== undefined)?.resultSummary
}

function compareAtMost(actual: number | undefined, threshold: number, name: string): GateCheck {
  return actual === undefined
    ? { name, ok: false, note: 'missing metric', threshold }
    : { name, ok: actual <= threshold, actual, threshold }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareAtLeast(actual: number | undefined, threshold: number, name: string): GateCheck {
  return actual === undefined
    ? { name, ok: false, note: 'missing metric', threshold }
    : { name, ok: actual >= threshold, actual, threshold }
}

function smokeByLabel(summary: RunSummary, label: string): ChatResult | undefined {
  return summary.smokes.find((smoke) => smoke.label === label)
}

function addSmokeContentGate(checks: GateCheck[], summary: RunSummary, label: string, expectedContent: string): void {
  const smoke = smokeByLabel(summary, label)
  checks.push({
    name: `${label} response contains ${expectedContent}`,
    ok: smoke?.ok === true && chatContent(smoke).includes(expectedContent),
    actual: smoke ? chatContent(smoke).slice(0, 160) : 'missing smoke',
    threshold: expectedContent,
  })
}

export function buildGateChecks(summary: RunSummary, baseline?: RunSummary): GateCheck[] {
  const checks: GateCheck[] = []
  const ids = modelIds(summary.models)
  const measured = summary.measuredMetricDelta
  const deployedSpecConfig = summary.speculativeDecode?.deployedConfig
  const benchmarkFailures = summary.benchmarks.filter((benchmark) => benchmark.result.code !== 0).length
  const warmupFailures = summary.warmups.filter((warmup) => warmup.result.code !== 0).length
  const smokeFailures = summary.smokes.filter((smoke) => !smoke.ok).length

  checks.push({
    name: 'benchmark completed without fatal runner error',
    ok: summary.fatalError === undefined,
    actual: summary.fatalError ?? 'none',
    threshold: 'none',
  })
  checks.push({
    name: '/v1/models exposes only qwen36-flamingo',
    ok: ids.length === 1 && ids[0] === 'qwen36-flamingo',
    actual: ids.join(','),
    threshold: 'qwen36-flamingo',
  })
  checks.push({
    name: '/v1/models max_model_len is 262144',
    ok: modelMaxLen(summary.models, 'qwen36-flamingo') === 262144,
    actual: modelMaxLen(summary.models, 'qwen36-flamingo'),
    threshold: 262144,
  })
  checks.push({ name: 'all chat smokes succeeded', ok: smokeFailures === 0, actual: smokeFailures, threshold: 0 })
  checks.push({ name: 'all warmups succeeded', ok: warmupFailures === 0, actual: warmupFailures, threshold: 0 })
  checks.push({
    name: 'all benchmark runs succeeded',
    ok: benchmarkFailures === 0,
    actual: benchmarkFailures,
    threshold: 0,
  })
  addSmokeContentGate(checks, summary, 'exact-no-thinking', 'qwen36-ready')
  addSmokeContentGate(checks, summary, 'medium-thinking', 'qwen36-thinking-ready')

  const toolSmoke = smokeByLabel(summary, 'tool-call')
  const toolCall = chatToolCalls(toolSmoke ?? { label: 'missing', ok: false, elapsedMs: 0 })[0]
  const toolCallOk =
    isRecord(toolCall) &&
    isRecord(toolCall.function) &&
    toolCall.function.name === 'lookup_status' &&
    typeof toolCall.function.arguments === 'string' &&
    toolCall.function.arguments.includes('FLAMINGO-262K')
  checks.push({
    name: 'structured Qwen tool call is valid',
    ok: toolSmoke?.ok === true && toolCallOk,
    actual: toolSmoke ? JSON.stringify(chatToolCalls(toolSmoke)).slice(0, 240) : 'missing smoke',
    threshold: 'lookup_status({id:FLAMINGO-262K})',
  })

  for (const target of summary.contextTargets) {
    addSmokeContentGate(checks, summary, `long-context-${target}`, `flamingo-long-${target}`)
  }

  if (summary.profile === 'full') {
    addSmokeContentGate(checks, summary, 'prefix-cache-second', 'prefix-cache-ready')
    checks.push(compareAtLeast(measured?.prefixCacheHits, 1, 'prefix cache records hits during full profile'))
  }

  checks.push(compareAtMost(measured?.requestErrors, 0, 'request errors stayed zero'))
  checks.push(compareAtMost(measured?.requestAborts, 0, 'request aborts stayed zero'))
  checks.push(compareAtMost(measured?.preemptions, 0, 'vLLM preemptions stayed zero'))
  checks.push(compareAtMost(measured?.peakKvCacheUsagePerc, 0.85, 'KV cache usage stayed below 85%'))

  const forbiddenProductionFlags = ['--enable-dbo', '--max-num-partial-prefills']
  for (const flag of forbiddenProductionFlags) {
    checks.push({
      name: `known-bad single-GPU flag absent: ${flag}`,
      ok: !(summary.deploymentArgs ?? []).includes(flag),
      actual: (summary.deploymentArgs ?? []).includes(flag) ? 'present' : 'absent',
      threshold: 'absent',
    })
  }

  if (summary.profile === 'mtp-al' || deployedSpecConfig !== undefined) {
    checks.push({
      name: 'deployed MTP speculative config is present',
      ok: deployedSpecConfig !== undefined,
      actual: deployedSpecConfig === undefined ? 'missing' : JSON.stringify(deployedSpecConfig),
      threshold: '{"method":"mtp",...}',
    })
    checks.push(
      compareAtLeast(measured?.speculativeAcceptanceLength, 1.01, 'real speculative acceptance length exists'),
    )
  }

  if (baseline) {
    const current = findPrimaryBenchmark(summary)
    const previous = findPrimaryBenchmark(baseline)
    summary.baselineComparison = {
      baselineCandidateId: baseline.candidateId,
      baselineProfile: baseline.profile,
      primaryCurrent: current,
      primaryBaseline: previous,
    }

    const throughputMultiplier = deployedSpecConfig !== undefined || summary.profile === 'mtp-al' ? 1.15 : 1.2
    checks.push(
      compareAtLeast(
        current?.outputThroughput,
        previous?.outputThroughput === undefined
          ? Number.POSITIVE_INFINITY
          : previous.outputThroughput * throughputMultiplier,
        `${throughputMultiplier}x output throughput against baseline`,
      ),
    )
    checks.push(
      compareAtMost(
        current?.p99TtftMs,
        previous?.p99TtftMs === undefined ? 0 : previous.p99TtftMs * 1.1,
        'p99 TTFT regression within 10%',
      ),
    )
    checks.push(
      compareAtMost(
        current?.meanTpotMs,
        previous?.meanTpotMs === undefined ? 0 : previous.meanTpotMs * 1.05,
        'mean TPOT regression within 5%',
      ),
    )
  } else {
    checks.push({
      name: 'baseline comparison supplied for improvement gates',
      ok: true,
      note: 'no --baseline-result supplied; improvement gates skipped',
    })
  }

  return checks
}

async function loadBaseline(path: string | undefined): Promise<RunSummary | undefined> {
  if (!path) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as RunSummary
}

function parseRuntimeEvidence(
  deploymentJson: unknown,
  podsJson: unknown,
  argoJson: unknown,
  podEvents: string,
  vllmLogTail: string,
): RuntimeEvidence {
  const deploymentImage =
    isRecord(deploymentJson) &&
    isRecord(deploymentJson.spec) &&
    isRecord(deploymentJson.spec.template) &&
    isRecord(deploymentJson.spec.template.spec) &&
    Array.isArray(deploymentJson.spec.template.spec.containers)
      ? deploymentJson.spec.template.spec.containers.filter(isRecord).find((container) => container.name === 'vllm')
          ?.image
      : undefined
  const podItems = isRecord(podsJson) && Array.isArray(podsJson.items) ? podsJson.items.filter(isRecord) : []
  const podNames = podItems
    .map((pod) => (isRecord(pod.metadata) && typeof pod.metadata.name === 'string' ? pod.metadata.name : undefined))
    .filter((name): name is string => name !== undefined)
  const podImageIDs = podItems
    .flatMap((pod) =>
      isRecord(pod.status) && Array.isArray(pod.status.containerStatuses) ? pod.status.containerStatuses : [],
    )
    .filter(isRecord)
    .map((status) => (typeof status.imageID === 'string' ? status.imageID : undefined))
    .filter((imageID): imageID is string => imageID !== undefined)
  const argoStatus = isRecord(argoJson) && isRecord(argoJson.status) ? argoJson.status : undefined

  return {
    argo: argoStatus
      ? {
          sync:
            isRecord(argoStatus.sync) && typeof argoStatus.sync.status === 'string'
              ? argoStatus.sync.status
              : undefined,
          health:
            isRecord(argoStatus.health) && typeof argoStatus.health.status === 'string'
              ? argoStatus.health.status
              : undefined,
          revision:
            isRecord(argoStatus.sync) && typeof argoStatus.sync.revision === 'string'
              ? argoStatus.sync.revision
              : undefined,
          operation:
            isRecord(argoStatus.operationState) && typeof argoStatus.operationState.phase === 'string'
              ? argoStatus.operationState.phase
              : undefined,
          reconciledAt: typeof argoStatus.reconciledAt === 'string' ? argoStatus.reconciledAt : undefined,
        }
      : undefined,
    deploymentImage: typeof deploymentImage === 'string' ? deploymentImage : undefined,
    podImageIDs,
    podNames,
    podEvents,
    vllmLogTail,
  }
}

async function readRuntimeEvidence(deploymentJson: unknown): Promise<RuntimeEvidence> {
  const [pods, events, logs, argo] = await Promise.all([
    run(
      kubectl([
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=flamingo,app.kubernetes.io/component=model-server',
        '-o',
        'json',
      ]),
    ),
    run(kubectl(['get', 'events', '--sort-by=.lastTimestamp'])),
    run(kubectl(['logs', `deploy/${deployment}`, '--tail=300'])),
    run(kubectlNamespace('argocd', ['get', 'app', 'flamingo', '-o', 'json'])),
  ])
  const podsJson = pods.code === 0 ? JSON.parse(pods.stdout) : undefined
  const argoJson = argo.code === 0 ? JSON.parse(argo.stdout) : undefined

  return parseRuntimeEvidence(deploymentJson, podsJson, argoJson, events.stdout, logs.stdout)
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'candidate'
}

async function main(): Promise<void> {
  if (profile !== 'smoke' && profile !== 'full' && profile !== 'mtp-al') {
    throw new Error(`--profile must be smoke, full, or mtp-al, got ${profile}`)
  }

  await mkdir(resultDir, { recursive: true })

  const summary: RunSummary = {
    startedAt: new Date().toISOString(),
    candidateId,
    profile,
    contextTargets,
    model,
    tokenizer,
    baseUrl,
    serverUrl,
    baselineResultPath,
    serverUrls: { baseUrl, serverUrl },
    kubernetes: { context: kubeContext, namespace, deployment },
    warmups: [],
    smokes: [],
    benchmarks: [],
    notes: [],
  }

  try {
    const deploymentJsonResult = await run(kubectl(['get', 'deployment', deployment, '-o', 'json']))
    if (deploymentJsonResult.code !== 0) {
      throw new Error(`failed to read deployment: ${deploymentJsonResult.stderr}`)
    }
    const parsedDeployment = JSON.parse(deploymentJsonResult.stdout) as {
      spec?: { template?: { spec?: { containers?: Array<{ name?: string; args?: string[] }> } } }
    }
    summary.deploymentArgs =
      parsedDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')?.args ?? []
    summary.runtimeEvidence = await readRuntimeEvidence(parsedDeployment)

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
        : profile === 'smoke'
          ? [['short-coding-loop-smoke', 4096, 512, 4, 2] as const]
          : []

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

    const mtpAcceptanceCells =
      profile === 'mtp-al'
        ? [
            await runMtpAcceptanceCell('mtp-al-thinking-off', false),
            await runMtpAcceptanceCell('mtp-al-thinking-on', true),
          ]
        : []

    summary.metricsAfter = await fetchText('/metrics')
    const metricsAfterSummary = buildMetricSnapshot(summary.metricsAfter)
    summary.metricsAfterSummary = metricsAfterSummary
    summary.measuredMetricDelta = diffMetricSnapshots(metricsAfterWarmupSummary, metricsAfterSummary)
    summary.speculativeDecode = buildSpeculativeDecodeSummary(
      summary.deploymentArgs,
      summary.measuredMetricDelta,
      mtpAcceptanceCells,
    )
    summary.nvidiaSmiAfter = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout
  } catch (error) {
    summary.fatalError = errorMessage(error)
    summary.notes.push(`benchmark aborted before completion: ${summary.fatalError}`)

    try {
      summary.runtimeEvidence = await readRuntimeEvidence({})
    } catch (evidenceError) {
      summary.notes.push(`failed to refresh runtime evidence after abort: ${errorMessage(evidenceError)}`)
    }

    try {
      summary.metricsAfter = await fetchText('/metrics')
      const metricsAfterSummary = buildMetricSnapshot(summary.metricsAfter)
      summary.metricsAfterSummary = metricsAfterSummary
      if (summary.metricsBeforeSummary) {
        summary.measuredMetricDelta = diffMetricSnapshots(summary.metricsBeforeSummary, metricsAfterSummary)
      }
    } catch (metricsError) {
      summary.notes.push(`failed to capture metrics after abort: ${errorMessage(metricsError)}`)
    }

    try {
      summary.nvidiaSmiAfter = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout
    } catch (nvidiaError) {
      summary.notes.push(`failed to capture nvidia-smi after abort: ${errorMessage(nvidiaError)}`)
    }
  }
  summary.finishedAt = new Date().toISOString()

  const baseline = await loadBaseline(baselineResultPath)
  summary.gateChecks = buildGateChecks(summary, baseline)
  summary.gateFailures = summary.gateChecks.filter((check) => !check.ok)

  const outputPath = join(
    resultDir,
    `flamingo-${sanitizeFilePart(candidateId)}-${profile}-${summary.startedAt.replace(/[:.]/g, '-')}.json`,
  )
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
      failedGates: summary.gateFailures.length,
      fatalError: summary.fatalError,
      measuredMetricDelta: summary.measuredMetricDelta,
      speculativeDecode: summary.speculativeDecode,
      gateFailures: summary.gateFailures,
    }),
  )

  if (
    failedSmokes.length > 0 ||
    failedWarmups.length > 0 ||
    failedBenchmarks.length > 0 ||
    summary.fatalError !== undefined ||
    (failOnGate && summary.gateFailures.length > 0)
  ) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
