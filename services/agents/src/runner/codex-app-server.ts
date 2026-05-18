import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type CodexAppServerTurnOptions,
  type StreamDelta,
  type Turn,
} from '@proompteng/codex'

import { ensureFileDirectory } from '../../scripts/codex/lib/fs'

import {
  asNumber,
  asString,
  buildTemplateContext,
  type AgentRunnerGoal,
  type AgentRunnerSpec,
  type CodexAppServerAdapterConfig,
  isRecord,
  renderTemplate,
} from './spec'

type AgentRunPayload = Record<string, unknown>

export const DEFAULT_CODEX_BINARY_PATH = '/usr/local/bin/codex'

export type CodexAppServerRunnerStatus = {
  provider: string
  adapter: 'codex-app-server'
  exitCode: number
  status: 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string
  threadId?: string
  turnId?: string
  model?: string
  effort?: string
  cwd?: string | null
  artifacts: {
    statusPath?: string
    logPath?: string
  }
  error?: string
}

export type CodexAppServerRunnerClient = {
  runTurnStream: (
    prompt: string,
    options?: CodexAppServerTurnOptions,
  ) => Promise<{ stream: AsyncGenerator<StreamDelta, Turn | null, void>; turnId: string; threadId: string }>
  interruptTurn?: (turnId: string, threadId: string) => Promise<void>
  stop?: () => void
}

export type RunCodexAppServerAdapterOptions = {
  createClient?: (options: CodexAppServerOptions) => CodexAppServerRunnerClient
  now?: () => Date
}

const timestampUtc = (now: () => Date): string =>
  now()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readNested = (value: unknown, path: string[]): unknown => {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

const readJsonFile = async (path: string): Promise<AgentRunPayload> => {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object in ${path}`)
  }
  return parsed
}

const loadRunPayload = async (spec: AgentRunnerSpec): Promise<AgentRunPayload> => {
  const payloadPath = asString(spec.payloads?.eventFilePath) ?? asString(spec.payloads?.eventBodyPath)
  if (!payloadPath) {
    return {}
  }
  return readJsonFile(payloadPath)
}

const nonEmptyString = (value: unknown): string | null => {
  const text = asString(value)?.trim()
  return text ? text : null
}

export const resolveCodexBinaryPath = (
  adapter: CodexAppServerAdapterConfig,
  env: Record<string, string | undefined> = process.env,
): string => {
  return (
    nonEmptyString(adapter.binaryPath) ??
    nonEmptyString(env.AGENTS_CODEX_BINARY) ??
    nonEmptyString(env.CODEX_BINARY) ??
    DEFAULT_CODEX_BINARY_PATH
  )
}

const renderOptionalTemplate = (
  template: string | undefined,
  spec: AgentRunnerSpec,
  runPayload: AgentRunPayload,
): string | null => {
  if (!template) return null
  const rendered = renderTemplate(template, {
    ...buildTemplateContext(spec),
    run: runPayload,
  })
  return nonEmptyString(rendered)
}

const resolvePrompt = (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
): string => {
  const adapterPrompt = renderOptionalTemplate(adapter.prompt, spec, runPayload)
  if (adapterPrompt) return adapterPrompt

  const candidates = [
    runPayload.prompt,
    readNested(runPayload, ['parameters', 'prompt']),
    readNested(runPayload, ['implementation', 'text']),
    readNested(runPayload, ['implementation', 'summary']),
    runPayload.issueBody,
    readNested(runPayload, ['event', 'body']),
  ]

  for (const candidate of candidates) {
    const text = nonEmptyString(candidate)
    if (text) return text
  }

  return JSON.stringify(runPayload, null, 2)
}

const normalizeGoal = (value: unknown): AgentRunnerGoal | null => {
  if (typeof value === 'string') {
    const objective = value.trim()
    return objective ? { objective } : null
  }
  if (!isRecord(value)) return null

  const objective =
    nonEmptyString(value.objective) ??
    nonEmptyString(value.text) ??
    nonEmptyString(value.summary) ??
    nonEmptyString(value.prompt)
  const tokenBudget = asNumber(value.tokenBudget)
  const status = asString(value.status) as AgentRunnerGoal['status']

  const goal: AgentRunnerGoal = {}
  if (objective) goal.objective = objective
  if (tokenBudget !== null) goal.tokenBudget = tokenBudget
  if (status) goal.status = status

  return Object.keys(goal).length > 0 ? goal : null
}

const mergeGoals = (...goals: Array<AgentRunnerGoal | null | undefined>): AgentRunnerGoal | null => {
  const merged: AgentRunnerGoal = {}
  for (const goal of goals) {
    if (!goal) continue
    if (goal.objective !== undefined) merged.objective = goal.objective
    if (goal.status !== undefined) merged.status = goal.status
    if (goal.tokenBudget !== undefined) merged.tokenBudget = goal.tokenBudget
  }
  return Object.keys(merged).length > 0 ? merged : null
}

const writeStatus = async (statusPath: string | undefined, status: CodexAppServerRunnerStatus) => {
  if (!statusPath) return
  await ensureFileDirectory(statusPath)
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

const openLog = async (logPath: string | undefined) => {
  if (!logPath) return null
  await ensureFileDirectory(logPath)
  return createWriteStream(logPath, { flags: 'a' })
}

const writeDelta = (delta: StreamDelta, logStream: ReturnType<typeof createWriteStream> | null) => {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), event: delta })}\n`
  logStream?.write(line)

  if (delta.type === 'message') {
    process.stdout.write(delta.delta)
    return
  }

  if (delta.type === 'reasoning') {
    process.stderr.write(delta.delta)
    return
  }

  if (delta.type === 'tool') {
    const detail = delta.detail ? ` ${delta.detail}` : ''
    process.stdout.write(`[${delta.toolKind}:${delta.status}] ${delta.title}${detail}\n`)
  }
}

export const runCodexAppServerAdapter = async (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  options: RunCodexAppServerAdapterOptions = {},
): Promise<number> => {
  const now = options.now ?? (() => new Date())
  const startedAt = timestampUtc(now)
  const runPayload = await loadRunPayload(spec)
  const prompt = resolvePrompt(spec, adapter, runPayload)
  const baseInstructions =
    renderOptionalTemplate(adapter.baseInstructions, spec, runPayload) ?? nonEmptyString(runPayload.systemPrompt)
  const developerInstructions = renderOptionalTemplate(adapter.developerInstructions, spec, runPayload)
  const goal = mergeGoals(normalizeGoal(runPayload.goal), spec.goal, adapter.goal)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath

  let threadId: string | undefined
  let turnId: string | undefined
  let exitCode = 1
  let errorMessage: string | undefined

  const clientOptions: CodexAppServerOptions = {
    binaryPath: resolveCodexBinaryPath(adapter),
    cliConfigOverrides: adapter.cliConfigOverrides,
    cwd: adapter.cwd,
    sandbox: adapter.sandbox,
    approval: adapter.approval,
    defaultModel: adapter.model,
    defaultEffort: adapter.effort,
    threadConfig: adapter.threadConfig as CodexAppServerOptions['threadConfig'],
    experimentalRawEvents: adapter.experimentalRawEvents,
    persistExtendedHistory: adapter.persistExtendedHistory,
    bootstrapTimeoutMs: adapter.bootstrapTimeoutMs,
  }
  const client = options.createClient?.(clientOptions) ?? new CodexAppServerClient(clientOptions)
  const logStream = await openLog(logPath)

  try {
    const turnOptions: CodexAppServerTurnOptions = {
      model: adapter.model,
      cwd: adapter.cwd,
      threadId: adapter.threadId,
      effort: adapter.effort,
      baseInstructions,
      developerInstructions,
      goal,
    }
    const response = await client.runTurnStream(prompt, turnOptions)
    threadId = response.threadId
    turnId = response.turnId

    const iterator = response.stream[Symbol.asyncIterator]()
    while (true) {
      const { value, done } = await iterator.next()
      if (done) break
      writeDelta(value, logStream)
    }
    exitCode = 0
  } catch (error) {
    errorMessage = toErrorMessage(error)
    exitCode = 1
  } finally {
    await new Promise<void>((resolve) => {
      if (!logStream) {
        resolve()
        return
      }
      logStream.end(resolve)
    })
    client.stop?.()

    await writeStatus(statusPath, {
      provider: spec.provider,
      adapter: 'codex-app-server',
      exitCode,
      status: exitCode === 0 ? 'succeeded' : 'failed',
      startedAt,
      finishedAt: timestampUtc(now),
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(adapter.model ? { model: adapter.model } : {}),
      ...(adapter.effort ? { effort: adapter.effort } : {}),
      ...(adapter.cwd !== undefined ? { cwd: adapter.cwd } : {}),
      artifacts: {
        statusPath,
        logPath,
      },
      ...(errorMessage ? { error: errorMessage } : {}),
    })
  }

  if (errorMessage) {
    throw new Error(errorMessage)
  }

  return exitCode
}
