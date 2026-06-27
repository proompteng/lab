#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RunResult = {
  args: string[]
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

type SessionEntry = {
  type?: string
  message?: {
    role?: string
  }
  role?: string
  [key: string]: unknown
}

const forbiddenOutput = [
  /maximum context length/i,
  /\binput_tokens\b/i,
  /Context overflow recovery failed/i,
  /HTTP\s*400/i,
  /\b400\b[^\n]*(context|token)/i,
]

function parseInteger(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined || value === '') {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }

  return parsed
}

function defaultClientContext(serverContext: number): number {
  if (serverContext >= 262144) {
    return 229376
  }

  if (serverContext >= 196608) {
    return 163840
  }

  if (serverContext >= 131072) {
    return 98304
  }

  if (serverContext >= 65536) {
    return 57344
  }

  return Math.max(8192, serverContext - 8192)
}

function buildPrompt(marker: string, targetChars: number): string {
  const prefix = [
    `Remember this exact marker for the next turn: ${marker}`,
    'If context is compacted, the summary must preserve that marker verbatim.',
    'After reading the filler below, reply with exactly:',
    `stored ${marker}`,
    '',
    'FILLER START',
  ].join('\n')

  const unit = [
    `The durable validation marker is ${marker}.`,
    'This line exists only to create enough reusable conversation history for a local Pi compaction smoke.',
    'Do not infer any task from this filler; preserve the marker and wait for the follow-up question.',
    '',
  ].join('\n')

  const filler = unit.repeat(Math.ceil(targetChars / unit.length)).slice(0, targetChars)

  return `${prefix}\n${filler}\nFILLER END\nReply with exactly: stored ${marker}\n`
}

async function runPi(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return await new Promise((resolve) => {
    const child = spawn('pi', args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ args, code, stdout, stderr, timedOut })
    })
  })
}

async function fetchServerContext(baseUrl: string, model: string): Promise<number | undefined> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      authorization: `Bearer ${process.env.PI_FLAMINGO_API_KEY ?? 'flamingo-local'}`,
    },
  })

  if (!response.ok) {
    throw new Error(`GET /v1/models failed with HTTP ${response.status}`)
  }

  const body = (await response.json()) as {
    data?: Array<{
      id?: string
      max_model_len?: number
    }>
  }
  const entry = body.data?.find((candidate) => candidate.id === model) ?? body.data?.[0]

  return entry?.max_model_len
}

async function findJsonlFiles(path: string): Promise<string[]> {
  const files: string[] = []

  for (const entry of await readdir(path)) {
    const child = join(path, entry)
    const childStat = await stat(child)

    if (childStat.isDirectory()) {
      files.push(...(await findJsonlFiles(child)))
      continue
    }

    if (entry.endsWith('.jsonl')) {
      files.push(child)
    }
  }

  return files
}

async function readSession(sessionDir: string): Promise<{ entries: SessionEntry[]; text: string; files: string[] }> {
  const files = await findJsonlFiles(sessionDir)
  const entries: SessionEntry[] = []
  let text = ''

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    text += `\n--- ${file} ---\n${content}`

    for (const line of content.split('\n')) {
      if (line.trim() === '') {
        continue
      }

      try {
        entries.push(JSON.parse(line) as SessionEntry)
      } catch {
        // Keep the raw text check authoritative for malformed lines.
      }
    }
  }

  return { entries, text, files }
}

function assertNoForbiddenOutput(label: string, text: string): void {
  const matched = forbiddenOutput.find((pattern) => pattern.test(text))
  if (matched) {
    throw new Error(`${label} contained forbidden overflow output matching ${matched}`)
  }
}

function assertCompactionBeforeFinalAssistant(entries: SessionEntry[]): number {
  const compactionIndexes = entries.flatMap((entry, index) => (entry.type === 'compaction' ? [index] : []))
  const finalAssistantIndex = entries.findLastIndex((entry) => {
    return entry.message?.role === 'assistant' || entry.role === 'assistant'
  })

  if (compactionIndexes.length === 0) {
    throw new Error('session did not contain a compaction entry')
  }

  if (finalAssistantIndex === -1) {
    throw new Error('session did not contain an assistant response')
  }

  if (!compactionIndexes.some((index) => index < finalAssistantIndex)) {
    throw new Error('session compaction entry was not recorded before the final assistant response')
  }

  return compactionIndexes.length
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/jangar/validate-pi-flamingo-compaction.ts

Environment:
  PI_FLAMINGO_BASE_URL             OpenAI-compatible base URL (default: http://flamingo.ide-newton.ts.net/v1)
  PI_FLAMINGO_MODEL                Model id (default: qwen36-flamingo)
  PI_FLAMINGO_API_KEY              Provider API key (default: flamingo-local)
  PI_FLAMINGO_SERVER_CONTEXT       Expected vLLM max_model_len (default: 262144)
  PI_FLAMINGO_CLIENT_CONTEXT       Pi models.json contextWindow (default follows rollout table)
  PI_FLAMINGO_MAX_TOKENS           Pi models.json maxTokens (default: 32768 for 128K+, else 2048)
  PI_FLAMINGO_COMPACTION_RESERVE   Pi compaction reserveTokens (default: 16384)
  PI_FLAMINGO_KEEP_RECENT          Pi compaction keepRecentTokens (default: 20000)
  PI_FLAMINGO_PROMPT_CHARS         First-turn filler size (default: threshold-sized)
  PI_FLAMINGO_TIMEOUT_MS           Timeout per Pi turn (default: 600000)
  PI_FLAMINGO_KEEP_TMP             Set to 1 to keep temp config/session dirs after success

Fast 32K live-server smoke:
  PI_FLAMINGO_SERVER_CONTEXT=32768 PI_FLAMINGO_CLIENT_CONTEXT=24576 PI_FLAMINGO_MAX_TOKENS=2048 \\
  PI_FLAMINGO_COMPACTION_RESERVE=8192 PI_FLAMINGO_KEEP_RECENT=4000 PI_FLAMINGO_PROMPT_CHARS=90000 \\
  bun run scripts/jangar/validate-pi-flamingo-compaction.ts

Production 262K profile smoke:
  PI_FLAMINGO_SERVER_CONTEXT=262144 PI_FLAMINGO_CLIENT_CONTEXT=229376 PI_FLAMINGO_MAX_TOKENS=32768 \\
  bun run scripts/jangar/validate-pi-flamingo-compaction.ts`)
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp()
    return
  }

  const baseUrl = process.env.PI_FLAMINGO_BASE_URL ?? 'http://flamingo.ide-newton.ts.net/v1'
  const provider = process.env.PI_FLAMINGO_PROVIDER ?? 'flamingo'
  const model = process.env.PI_FLAMINGO_MODEL ?? 'qwen36-flamingo'
  const apiKey = process.env.PI_FLAMINGO_API_KEY ?? 'flamingo-local'
  const serverContext = parseInteger('PI_FLAMINGO_SERVER_CONTEXT', 262144)
  const clientContext = parseInteger('PI_FLAMINGO_CLIENT_CONTEXT', defaultClientContext(serverContext))
  const maxTokens = parseInteger('PI_FLAMINGO_MAX_TOKENS', serverContext >= 131072 ? 32768 : 2048)
  const reserveTokens = parseInteger('PI_FLAMINGO_COMPACTION_RESERVE', 16384)
  const keepRecentTokens = parseInteger('PI_FLAMINGO_KEEP_RECENT', 20000)
  const threshold = clientContext - reserveTokens
  const promptChars = parseInteger('PI_FLAMINGO_PROMPT_CHARS', Math.max(12000, Math.ceil((threshold + 4096) * 4.7)))
  const timeoutMs = parseInteger('PI_FLAMINGO_TIMEOUT_MS', 600000)

  if (clientContext + maxTokens > serverContext) {
    throw new Error(
      `client contextWindow + maxTokens must fit server context (${clientContext} + ${maxTokens} > ${serverContext})`,
    )
  }

  if (threshold <= 0) {
    throw new Error(`compaction threshold must be positive (${clientContext} - ${reserveTokens})`)
  }

  const reportedServerContext = await fetchServerContext(baseUrl, model)
  if (reportedServerContext !== undefined && reportedServerContext < serverContext) {
    throw new Error(`/v1/models reports max_model_len=${reportedServerContext}, below expected ${serverContext}`)
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'pi-flamingo-compaction-'))
  const agentDir = join(tempRoot, 'agent')
  const sessionDir = join(tempRoot, 'sessions')
  const promptPath = join(tempRoot, 'first-turn.md')
  const sessionId = randomUUID()
  const marker = process.env.PI_FLAMINGO_MARKER ?? `flamingo-compaction-${randomUUID().slice(0, 8)}`
  let keepTemp = process.env.PI_FLAMINGO_KEEP_TMP === '1'

  try {
    await mkdir(agentDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })

    await writeFile(
      join(agentDir, 'settings.json'),
      `${JSON.stringify(
        {
          defaultProvider: provider,
          defaultModel: model,
          defaultThinkingLevel: 'medium',
          quietStartup: true,
          enableInstallTelemetry: false,
          compaction: {
            enabled: true,
            reserveTokens,
            keepRecentTokens,
          },
        },
        null,
        2,
      )}\n`,
    )

    await writeFile(
      join(agentDir, 'models.json'),
      `${JSON.stringify(
        {
          providers: {
            [provider]: {
              baseUrl,
              api: 'openai-completions',
              apiKey,
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                maxTokensField: 'max_tokens',
                thinkingFormat: 'qwen-chat-template',
              },
              models: [
                {
                  id: model,
                  name: 'Qwen3.6 Flamingo',
                  reasoning: true,
                  input: ['text'],
                  contextWindow: clientContext,
                  maxTokens,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    await writeFile(promptPath, buildPrompt(marker, promptChars))

    const commonArgs = [
      '--provider',
      provider,
      '--model',
      model,
      '--session-id',
      sessionId,
      '--session-dir',
      sessionDir,
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--print',
    ]
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    }

    const first = await runPi([...commonArgs, `@${promptPath}`], env, timeoutMs)
    assertNoForbiddenOutput('first Pi turn', `${first.stdout}\n${first.stderr}`)
    if (first.timedOut || first.code !== 0) {
      throw new Error(
        `first Pi turn failed with code ${first.code}${first.timedOut ? ' after timeout' : ''}\n${first.stderr}`,
      )
    }

    const second = await runPi(
      [...commonArgs, `What exact marker did I ask you to preserve? Reply with only ${marker}.`],
      env,
      timeoutMs,
    )
    assertNoForbiddenOutput('second Pi turn', `${second.stdout}\n${second.stderr}`)
    if (second.timedOut || second.code !== 0) {
      throw new Error(
        `second Pi turn failed with code ${second.code}${second.timedOut ? ' after timeout' : ''}\n${second.stderr}`,
      )
    }

    const session = await readSession(sessionDir)
    assertNoForbiddenOutput('saved Pi session', session.text)
    const compactionCount = assertCompactionBeforeFinalAssistant(session.entries)

    if (!second.stdout.includes(marker)) {
      keepTemp = true
      throw new Error(`follow-up did not preserve marker ${marker}\nOutput:\n${second.stdout}`)
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          model,
          reportedServerContext,
          serverContext,
          clientContext,
          maxTokens,
          reserveTokens,
          keepRecentTokens,
          threshold,
          promptChars,
          compactionCount,
          marker,
          sessionFiles: session.files,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    keepTemp = true
    console.error(`Pi Flamingo compaction validation failed. Temp root kept at ${tempRoot}`)
    throw error
  } finally {
    if (!keepTemp) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
