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
const contextTargets = (
  args.get('long-targets') ??
  process.env.FLAMINGO_LONG_TARGETS ??
  (profile === 'full' ? '220000' : '')
)
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

  return { label, command, result, resultJson }
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
  summary.nvidiaSmiBefore = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout

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
      ? [['short-coding-loop', 4096, 512, 16, 4] as const, ['agent-edit-loop', 32768, 4096, 8, 2] as const]
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
  summary.nvidiaSmiAfter = (await run(kubectl(['exec', `deploy/${deployment}`, '--', 'nvidia-smi']), 120000)).stdout
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
