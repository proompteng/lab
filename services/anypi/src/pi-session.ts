import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

import type { AnypiConfig } from './config'
import { writeModelsFile } from './config'
import { buildSystemPrompt } from './prompt'
import type { LoopDetectionEvidence, ToolEvent } from './types'

export type PiRunResult = {
  text: string
  tools: string[]
  sessionFile?: string
  loopEvidence?: LoopDetectionEvidence
}

export type PiRunOptions = {
  sessionLabel?: string
  systemPrompt?: string
}

export const isBenignAssistantContinuationError = (error: unknown) =>
  error instanceof Error && error.message.includes('Cannot continue from message role: assistant')

export const resolveAttemptSessionDir = (sessionDir: string, sessionLabel = 'attempt') => {
  const safeLabel = sessionLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return join(sessionDir, `${safeLabel || 'attempt'}-${randomUUID().slice(0, 8)}`)
}

export { type LoopDetectionEvidence, type ToolEvent }

const collectAgentsFiles = async (worktree: string) => {
  const rootAgents = join(worktree, 'AGENTS.md')
  if (!existsSync(rootAgents)) return []
  return [{ path: rootAgents, content: await readFile(rootAgents, 'utf8') }]
}

export const resolveEffectiveSystemPrompt = (config: Pick<AnypiConfig, 'promptVariant'>, inlineSystemPrompt?: string) =>
  inlineSystemPrompt?.trim() || buildSystemPrompt(config.promptVariant)

const createResourceLoader = async (worktree: string, systemPrompt: string): Promise<ResourceLoader> => {
  const agentsFiles = await collectAgentsFiles(worktree)
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

const runPromptWithTimeout = async (
  session: Awaited<ReturnType<typeof createAgentSession>>['session'],
  prompt: string,
  timeoutSeconds: number,
) => {
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const promptPromise = session.prompt(prompt).catch((error: unknown) => {
    if (timedOut) return
    throw error
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      session.dispose()
      reject(new Error(`Pi prompt exceeded ${timeoutSeconds}s timeout`))
    }, timeoutSeconds * 1000)
  })

  try {
    await Promise.race([promptPromise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export const runPiAgent = async (
  config: AnypiConfig,
  prompt: string,
  log: (message: string) => Promise<void>,
  options: PiRunOptions = {},
): Promise<PiRunResult> => {
  await mkdir(config.agentDir, { recursive: true })
  await mkdir(config.sessionDir, { recursive: true })
  await mkdir(dirname(config.authPath), { recursive: true })
  if (!existsSync(config.authPath)) await writeFile(config.authPath, '{}\n', 'utf8')
  await writeModelsFile(config)
  const attemptSessionDir = resolveAttemptSessionDir(config.sessionDir, options.sessionLabel)
  await mkdir(attemptSessionDir, { recursive: true })

  const authStorage = AuthStorage.create(config.authPath)
  const modelRegistry = ModelRegistry.create(authStorage, config.modelsPath)
  const model = modelRegistry.find(config.provider, config.model)
  if (!model) throw new Error(`Pi model not found: ${config.provider}/${config.model}`)

  const systemPrompt = resolveEffectiveSystemPrompt(config, options.systemPrompt)
  const resourceLoader = await createResourceLoader(config.worktree, systemPrompt)
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
    defaultProjectTrust: 'never',
    quietStartup: true,
  })

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: config.worktree,
    agentDir: config.agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: config.thinkingLevel,
    resourceLoader,
    tools: config.tools,
    sessionManager: SessionManager.create(config.worktree, attemptSessionDir),
    settingsManager,
  })

  if (modelFallbackMessage) await log(`pi model fallback: ${modelFallbackMessage}`)
  await log(`pi session dir: ${attemptSessionDir}`)
  session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name))
  await log(`pi active tools: ${session.getActiveToolNames().join(', ')}`)

  let text = ''
  const events: ToolEvent[] = []
  let finishFinalizationEvents = 0
  let readBashStatusEvents = 0
  const lastToolsSet = new Set<string>()

  const timestamp = () => new Date().toISOString()

  const recordToolEvent = (type: string, toolName?: string) => {
    const event: ToolEvent = { type, toolName, timestamp: timestamp() }
    events.push(event)
    if (toolName) lastToolsSet.add(toolName)
  }

  // Track finish/finalization-like tool calls
  const isFinishOrFinalizationTool = (name: string) => {
    const normalized = name.toLowerCase()
    return (
      normalized.includes('finish') ||
      normalized.includes('final') ||
      normalized.includes('complete') ||
      normalized === 'submit'
    )
  }

  // Track benign read/bash/status-like commands
  const isBenignCommand = (name: string) => {
    const normalized = name.toLowerCase()
    return (
      normalized === 'read' ||
      normalized === 'bash' ||
      normalized === 'status' ||
      normalized === 'git' ||
      normalized.includes('git_')
    )
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta
      text += delta
      void log(delta)
    }
    if (event.type === 'tool_execution_start') {
      recordToolEvent('tool_execution_start', event.toolName)
      void log(`tool start: ${event.toolName}`)
      if (isFinishOrFinalizationTool(event.toolName)) {
        finishFinalizationEvents += 1
      }
      if (isBenignCommand(event.toolName)) {
        readBashStatusEvents += 1
      }
    }
    if (event.type === 'tool_execution_end') {
      recordToolEvent('tool_execution_end', event.toolName)
      void log(`tool end: ${event.toolName}`)
    }
  })

  const startTime = Date.now()

  try {
    try {
      await runPromptWithTimeout(session, prompt, config.piPromptTimeoutSeconds)
    } catch (error) {
      if (!text.trim() || !isBenignAssistantContinuationError(error)) throw error
      await log(`pi stopped after assistant final response: ${(error as Error).message}`)
    }

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
    const lastTools = [...lastToolsSet]

    // Detect loop: many finish/finalization events or benign commands without worktree progress
    const recentEvents = events.slice(-10)
    const hasPotentialLoop =
      finishFinalizationEvents >= 2 || (readBashStatusEvents >= 3 && finishFinalizationEvents >= 1)

    let loopEvidence: LoopDetectionEvidence | undefined
    if (hasPotentialLoop && elapsedSeconds < config.piPromptTimeoutSeconds) {
      loopEvidence = {
        elapsedSeconds,
        lastTools,
        recentEvents,
        finishFinalizationEvents,
        readBashStatusEvents,
        gitStatusShort: '', // Will be populated by caller
      }
    }

    return {
      text,
      tools: session.getActiveToolNames(),
      sessionFile: session.sessionFile,
      loopEvidence,
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}
