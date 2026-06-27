#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// ── Types ────────────────────────────────────────────────────────────────────

type CommandResult = {
  command: string[]
  code: number | null
  stdout: string
  stderr: string
  elapsedMs: number
}

export type ChatResult = {
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
  metricsAfter?: string
  nvidiaSmiBefore?: string
  nvidiaSmiAfter?: string
  smokes: ChatResult[]
  benchmarks: BenchmarkRun[]
  notes: string[]
}

// ── Dependency injection interface ───────────────────────────────────────────
// Allows tests to replace spawn / fetch without mocking globals.

interface RunnerDeps {
  spawn: typeof spawn
  fetch: typeof fetch
}

// ── Config helpers ───────────────────────────────────────────────────────────

export function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const [key, value = ''] = arg.split('=', 2)
    if (key.startsWith('--')) {
      args.set(key.slice(2), value || 'true')
    }
  }
  return args
}

export function resolveConfig(args: Map<string, string>): {
  profile: string
  kubeContext: string
  namespace: string
  deployment: string
  model: string
  tokenizer: string
  baseUrl: string
  serverUrl: string
  resultDir: string
  timeoutMs: number
  contextTargets: number[]
} {
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
  const resultDir = resolve(
    args.get('result-dir') ?? process.env.FLAMINGO_BENCH_RESULT_DIR ?? '/tmp/flamingo-vllm-bench',
  )
  const timeoutMs = Number.parseInt(args.get('timeout-ms') ?? process.env.FLAMINGO_BENCH_TIMEOUT_MS ?? '1800000', 10)
  const contextTargets = (
    args.get('long-targets') ??
    process.env.FLAMINGO_LONG_TARGETS ??
    (profile === 'full' ? '220000' : '')
  )
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)

  return {
    profile,
    kubeContext,
    namespace,
    deployment,
    model,
    tokenizer,
    baseUrl,
    serverUrl,
    resultDir,
    timeoutMs,
    contextTargets,
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const benchmarkResultMarker = '__FLAMINGO_BENCH_RESULT_JSON__'

// ── Command builders (testable) ──────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the raw vLLM bench command array (not wrapped in kubectl exec).
 * Pure function – no side effects, no I/O.
 */
export function buildBenchmarkCommand({
  model,
  tokenizer,
  label,
  inputLen,
  outputLen,
  numPrompts,
  concurrency,
  podDir,
  resultFile,
}: {
  model: string
  tokenizer: string
  label: string
  inputLen: number
  outputLen: number
  numPrompts: number
  concurrency: number
  podDir: string
  resultFile: string
}): string[] {
  return [
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
}

/**
 * Build the full kubectl exec wrapper that runs the benchmark inside a pod.
 * Pure function.
 */
export function buildKubectlExecCommand({
  deployment,
  podDir,
  resultFile,
  label,
  inputLen,
  outputLen,
  numPrompts,
  concurrency,
  model,
  tokenizer,
  kubeContext,
  namespace,
}: {
  deployment: string
  podDir: string
  resultFile: string
  label: string
  inputLen: number
  outputLen: number
  numPrompts: number
  concurrency: number
  model: string
  tokenizer: string
  kubeContext: string
  namespace: string
}): string[] {
  const benchCommand = buildBenchmarkCommand({
    model,
    tokenizer,
    label,
    inputLen,
    outputLen,
    numPrompts,
    concurrency,
    podDir,
    resultFile,
  })

  return [
    'kubectl',
    '--context',
    kubeContext,
    '-n',
    namespace,
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
  ]
}

/**
 * Parse benchmark JSON from shell output that has the marker appended.
 * Returns the parsed JSON object or `undefined` if no marker / parse failure.
 */
export function parseBenchmarkOutput(stdout: string): unknown {
  const markerIndex = stdout.lastIndexOf(benchmarkResultMarker)
  if (markerIndex < 0) {
    return undefined
  }
  try {
    return JSON.parse(stdout.slice(markerIndex + benchmarkResultMarker.length).trim())
  } catch {
    return undefined
  }
}

// ── Semantic smoke validation ────────────────────────────────────────────────

/**
 * Semantic validation rules per smoke label.
 * Each validator returns a string reason on failure, or `null` on success.
 */
type SmokeValidator = (result: ChatResult) => string | null

export const smokeValidators: Record<string, SmokeValidator> = {
  /** exact-no-thinking: response content must contain "qwen36-ready" and finish cleanly. */
  'exact-no-thinking': (result: ChatResult): string | null => {
    if (!result.ok) return 'HTTP request failed'
    if (!result.response) return 'missing response payload'

    const resp = result.response as { choices?: Array<{ message?: { content?: unknown; finish_reason?: string } }> }
    const choice = resp.choices?.[0]
    if (!choice?.message) return 'missing choices[0].message'

    const content = choice.message.content
    if (typeof content !== 'string') return 'content is not a string'

    if (!content.includes('qwen36-ready')) {
      return `content must contain "qwen36-ready", got: ${String(content).slice(0, 200)}`
    }

    // "finish cleanly" = finish_reason is "stop" or "length" (non-error)
    const finishReason = choice.message.finish_reason
    if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
      return `finish_reason must be "stop" or "length", got "${finishReason}"`
    }

    return null
  },

  /** medium-thinking: content must contain "qwen36-thinking-ready", finish cleanly, nonzero completion tokens. */
  'medium-thinking': (result: ChatResult): string | null => {
    if (!result.ok) return 'HTTP request failed'
    if (!result.response) return 'missing response payload'

    const resp = result.response as {
      choices?: Array<{ message?: { content?: unknown; finish_reason?: string; completion_tokens?: number } }>
    }
    const choice = resp.choices?.[0]
    if (!choice?.message) return 'missing choices[0].message'

    const content = choice.message.content
    if (typeof content !== 'string') return 'content is not a string'

    if (!content.includes('qwen36-thinking-ready')) {
      return `content must contain "qwen36-thinking-ready", got: ${String(content).slice(0, 200)}`
    }

    const finishReason = choice.message.finish_reason
    if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
      return `finish_reason must be "stop" or "length", got "${finishReason}"`
    }

    const completionTokens = choice.message.completion_tokens
    if (typeof completionTokens !== 'number' || completionTokens === 0) {
      return `completion_tokens must be nonzero, got ${completionTokens}`
    }

    return null
  },

  /** tool-call: must be a structured lookup_status call with JSON arguments id exactly "FLAMINGO-262K". */
  'tool-call': (result: ChatResult): string | null => {
    if (!result.ok) return 'HTTP request failed'
    if (!result.response) return 'missing response payload'

    const resp = result.response as {
      choices?: Array<{
        message?: { tool_calls?: unknown }
        finish_reason?: string
      }>
    }
    const choice = resp.choices?.[0]
    if (!choice?.message) return 'missing choices[0].message'

    const toolCalls = choice.message.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return 'tool_calls must be a non-empty array'
    }

    // Validate the first tool call
    const tc = toolCalls[0] as {
      type?: string
      function?: { name?: string; arguments?: string }
    }
    if (typeof tc?.type !== 'string' || tc.type !== 'function') {
      return 'tool_calls[0].type must be "function"'
    }

    const fn = tc.function
    if (typeof fn?.name !== 'string' || fn.name !== 'lookup_status') {
      return `tool_calls[0].function.name must be "lookup_status", got "${fn?.name}"`
    }

    if (typeof fn?.arguments !== 'string') {
      return 'tool_calls[0].function.arguments must be a string'
    }

    let args: unknown
    try {
      args = JSON.parse(fn.arguments)
    } catch {
      return 'tool_calls[0].function.arguments is not valid JSON'
    }

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return 'tool_calls[0].function.arguments must parse to an object'
    }

    const obj = args as Record<string, unknown>
    if (typeof obj.id !== 'string' || obj.id !== 'FLAMINGO-262K') {
      return `arguments.id must be exactly "FLAMINGO-262K", got "${obj.id}"`
    }

    // finish_reason should be "tool_calls" to indicate clean completion
    if (typeof choice.finish_reason !== 'string' || choice.finish_reason !== 'tool_calls') {
      return `finish_reason must be "tool_calls", got "${choice.finish_reason}"`
    }

    return null
  },

  /** long-context-N: content must contain the expected marker (flamingo-long-N). */
}

export function buildLongContextValidator(expectedMarker: string): SmokeValidator {
  return (result: ChatResult): string | null => {
    if (!result.ok) return 'HTTP request failed'
    if (!result.response) return 'missing response payload'

    const resp = result.response as { choices?: Array<{ message?: { content?: unknown; finish_reason?: string } }> }
    const choice = resp.choices?.[0]
    if (!choice?.message) return 'missing choices[0].message'

    const content = choice.message.content
    if (typeof content !== 'string') return 'content is not a string'

    if (!content.includes(expectedMarker)) {
      return `content must contain "${expectedMarker}", got: ${String(content).slice(0, 200)}`
    }

    const finishReason = choice.message.finish_reason
    if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
      return `finish_reason must be "stop" or "length", got "${finishReason}"`
    }

    return null
  }
}

// Attach long-context validator dynamically
smokeValidators['long-context-validator'] = function (): string | null {
  return null // placeholder – use per-instance validation below
}

/**
 * Validate a single smoke result semantically.
 * Returns an array of error strings (empty = pass).
 */
export function validateSmokeResult(label: string, result: ChatResult): string[] {
  const errors: string[] = []

  // Check HTTP-level success first
  if (!result.ok) {
    errors.push(`HTTP-level failure: ${result.error ?? 'unknown'}`)
    return errors
  }

  // Run semantic validation
  const reason = smokeValidators[label]?.(result)
  if (reason) {
    errors.push(`semantic: ${reason}`)
  }

  return errors
}

/**
 * Validate a long-context smoke result given the expected marker.
 */
export function validateLongContextSmoke(result: ChatResult, expectedMarker: string): string[] {
  const errors: string[] = []

  if (!result.ok) {
    errors.push(`HTTP-level failure: ${result.error ?? 'unknown'}`)
    return errors
  }

  if (!result.response) {
    errors.push('missing response payload')
    return errors
  }

  const resp = result.response as { choices?: Array<{ message?: { content?: unknown; finish_reason?: string } }> }
  const choice = resp.choices?.[0]
  if (!choice?.message) {
    errors.push('missing choices[0].message')
    return errors
  }

  const content = choice.message.content
  if (typeof content !== 'string') {
    errors.push('content is not a string')
    return errors
  }

  if (!content.includes(expectedMarker)) {
    errors.push(`content must contain "${expectedMarker}", got: ${String(content).slice(0, 200)}`)
  }

  const finishReason = choice.message.finish_reason
  if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
    errors.push(`finish_reason must be "stop" or "length", got "${finishReason}"`)
  }

  return errors
}

// ── Other helpers (still exported for testability) ───────────────────────────

/**
 * Build the long-context prompt used for recall validation.
 */
export function buildLongPrompt(targetTokens: number, marker: string): string {
  const filler = 'x '.repeat(targetTokens)
  return [
    `Remember the marker ${marker}.`,
    'The following filler exists only to validate long-context recall.',
    filler,
    `Return exactly: ${marker}`,
  ].join('\n')
}

function kubectlBuild(args: string[], kubeContext: string, namespace: string): string[] {
  return ['kubectl', '--context', kubeContext, '-n', namespace, ...args]
}

async function runCommand(command: string[], timeout: number, spawnImpl: typeof spawn): Promise<CommandResult> {
  const started = Date.now()

  return await new Promise((resolvePromise) => {
    const child = spawnImpl(command[0], command.slice(1), {
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

async function fetchJsonWithDeps(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.FLAMINGO_API_KEY ?? 'flamingo-local'}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`)
  }

  return text.length > 0 ? JSON.parse(text) : null
}

async function fetchTextWithDeps(
  serverUrl: string,
  path: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${serverUrl}${path}`, {
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

async function chatSmoke(
  label: string,
  payload: unknown,
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  const started = Date.now()
  try {
    const response = await fetchJsonWithDeps(
      baseUrl,
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      timeoutMs,
      fetchImpl,
    )
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

// ── Benchmark runner ─────────────────────────────────────────────────────────

async function runBench({
  label,
  inputLen,
  outputLen,
  numPrompts,
  concurrency,
  deployment,
  model,
  tokenizer,
  kubeContext,
  namespace,
  timeout,
  spawnImpl,
}: {
  label: string
  inputLen: number
  outputLen: number
  numPrompts: number
  concurrency: number
  deployment: string
  model: string
  tokenizer: string
  kubeContext: string
  namespace: string
  timeout: number
  spawnImpl: typeof spawn
}): Promise<BenchmarkRun> {
  const podDir = `/tmp/flamingo-bench-${Date.now()}-${label}`
  const resultFile = `${label}.json`

  const command = buildKubectlExecCommand({
    deployment,
    podDir,
    resultFile,
    label,
    inputLen,
    outputLen,
    numPrompts,
    concurrency,
    model,
    tokenizer,
    kubeContext,
    namespace,
  })

  const result = await runCommand(command, timeout, spawnImpl)

  const resultJson = parseBenchmarkOutput(result.stdout)

  return { label, command, result, resultJson }
}

// ── Main (still the entry point) ─────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()

  const config = resolveConfig(args)
  const {
    profile,
    kubeContext,
    namespace,
    deployment,
    model,
    tokenizer,
    baseUrl,
    serverUrl,
    resultDir,
    timeoutMs: timeout,
    contextTargets,
  } = config

  if (profile !== 'smoke' && profile !== 'full') {
    throw new Error(`--profile must be smoke or full, got ${profile}`)
  }

  const deps: RunnerDeps = { spawn, fetch }

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
    smokes: [],
    benchmarks: [],
    notes: [],
  }

  const deploymentJson = await runCommand(
    kubectlBuild(['get', 'deployment', deployment, '-o', 'json'], kubeContext, namespace),
    timeout,
    deps.spawn,
  )
  if (deploymentJson.code !== 0) {
    throw new Error(`failed to read deployment: ${deploymentJson.stderr}`)
  }
  const parsedDeployment = JSON.parse(deploymentJson.stdout) as {
    spec?: { template?: { spec?: { containers?: Array<{ name?: string; args?: string[] }> } } }
  }
  summary.deploymentArgs =
    parsedDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')?.args ?? []

  summary.models = await fetchJsonWithDeps(baseUrl, '/models', {}, timeout, deps.fetch)
  summary.metricsBefore = await fetchTextWithDeps(serverUrl, '/metrics', timeout, deps.fetch)
  summary.nvidiaSmiBefore = (
    await runCommand(
      kubectlBuild(['exec', `deploy/${deployment}`, '--', 'nvidia-smi'], kubeContext, namespace),
      120000,
      deps.spawn,
    )
  ).stdout

  summary.smokes.push(
    await chatSmoke(
      'exact-no-thinking',
      {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: qwen36-ready' }],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 16,
        temperature: 0,
      },
      baseUrl,
      timeout,
      deps.fetch,
    ),
  )

  summary.smokes.push(
    await chatSmoke(
      'medium-thinking',
      {
        model,
        messages: [{ role: 'user', content: 'Reason briefly, then answer exactly: qwen36-thinking-ready' }],
        chat_template_kwargs: { enable_thinking: true },
        max_tokens: 2048,
        temperature: 0,
      },
      baseUrl,
      timeout,
      deps.fetch,
    ),
  )

  summary.smokes.push(
    await chatSmoke(
      'tool-call',
      {
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
      },
      baseUrl,
      timeout,
      deps.fetch,
    ),
  )

  for (const target of contextTargets) {
    const marker = `flamingo-long-${target}`
    summary.smokes.push(
      await chatSmoke(
        `long-context-${target}`,
        {
          model,
          messages: [{ role: 'user', content: buildLongPrompt(target, marker) }],
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 32,
          temperature: 0,
        },
        baseUrl,
        timeout,
        deps.fetch,
      ),
    )
  }

  const benchProfiles =
    profile === 'full'
      ? [['short-coding-loop', 4096, 512, 16, 4] as const, ['agent-edit-loop', 32768, 4096, 8, 2] as const]
      : [['short-coding-loop-smoke', 4096, 512, 4, 2] as const]

  for (const [label, inputLen, outputLen, numPrompts, concurrency] of benchProfiles) {
    summary.benchmarks.push(
      await runBench({
        label,
        inputLen,
        outputLen,
        numPrompts,
        concurrency,
        deployment,
        model,
        tokenizer,
        kubeContext,
        namespace,
        timeout,
        spawnImpl: deps.spawn,
      }),
    )
  }

  if (profile === 'full') {
    const sharedPrefix = `${'shared repository context line\n'.repeat(12000)}\nReturn exactly: prefix-cache-ready`
    summary.smokes.push(
      await chatSmoke(
        'prefix-cache-first',
        {
          model,
          messages: [{ role: 'user', content: sharedPrefix }],
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 16,
          temperature: 0,
        },
        baseUrl,
        timeout,
        deps.fetch,
      ),
    )
    summary.smokes.push(
      await chatSmoke(
        'prefix-cache-second',
        {
          model,
          messages: [{ role: 'user', content: sharedPrefix }],
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 16,
          temperature: 0,
        },
        baseUrl,
        timeout,
        deps.fetch,
      ),
    )
  }

  summary.metricsAfter = await fetchTextWithDeps(serverUrl, '/metrics', timeout, deps.fetch)
  summary.nvidiaSmiAfter = (
    await runCommand(
      kubectlBuild(['exec', `deploy/${deployment}`, '--', 'nvidia-smi'], kubeContext, namespace),
      120000,
      deps.spawn,
    )
  ).stdout
  summary.finishedAt = new Date().toISOString()

  const outputPath = join(resultDir, `flamingo-${profile}-${summary.startedAt.replace(/[:.]/g, '-')}.json`)
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  const failedSmokes = summary.smokes.filter((smoke) => !smoke.ok)
  const failedBenchmarks = summary.benchmarks.filter((benchmark) => benchmark.result.code !== 0)
  console.log(
    JSON.stringify({ outputPath, failedSmokes: failedSmokes.length, failedBenchmarks: failedBenchmarks.length }),
  )

  if (failedSmokes.length > 0 || failedBenchmarks.length > 0) {
    process.exitCode = 1
  }
}

// Guard: do not run `main()` when this file is imported by bun test.
if (import.meta.main && process.argv[1]?.includes('benchmark-flamingo-vllm')) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
