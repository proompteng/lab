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

export type PiRunResult = {
  text: string
  tools: string[]
  sessionFile?: string
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

const MAX_TOOL_LOG_VALUE_LENGTH = 240

const SENSITIVE_KEY_PATTERN =
  /(auth|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i

const redactSensitiveText = (value: string) =>
  value
    .replace(
      /\b([A-Z0-9_]*(?:AUTH|CREDENTIAL|PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1=<redacted>',
    )
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-token>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-token>')
    .replace(/\bhf_[A-Za-z0-9_]{20,}\b/g, '<redacted-huggingface-token>')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '<redacted-api-key>')

const truncateToolLogValue = (value: string) =>
  value.length > MAX_TOOL_LOG_VALUE_LENGTH ? `${value.slice(0, MAX_TOOL_LOG_VALUE_LENGTH - 3)}...` : value

const stringifyToolValue = (value: unknown, key?: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return '<redacted>'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(truncateToolLogValue(redactSensitiveText(value)))
  if (Array.isArray(value)) return `array(${value.length})`
  return `object(${Object.keys(value as Record<string, unknown>).length})`
}

const toolArg = (args: unknown, name: string): unknown =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined

const joinToolParts = (parts: (string | undefined)[]) => parts.filter(Boolean).join(' ')

const formatKeyValue = (args: unknown, key: string) => {
  const value = stringifyToolValue(toolArg(args, key), key)
  return value ? `${key}=${value}` : undefined
}

export const formatToolExecutionSummary = (toolName: string, args: unknown) => {
  if (!args || typeof args !== 'object') return ''

  if (toolName === 'bash') {
    return joinToolParts([formatKeyValue(args, 'command'), formatKeyValue(args, 'timeout')])
  }
  if (toolName === 'read') {
    return joinToolParts([formatKeyValue(args, 'path'), formatKeyValue(args, 'offset'), formatKeyValue(args, 'limit')])
  }
  if (toolName === 'write') {
    const content = toolArg(args, 'content')
    const contentSummary = typeof content === 'string' ? `contentChars=${content.length}` : undefined
    return joinToolParts([formatKeyValue(args, 'path'), contentSummary])
  }
  if (toolName === 'edit') {
    const edits = toolArg(args, 'edits')
    const editSummary = Array.isArray(edits) ? `edits=${edits.length}` : undefined
    return joinToolParts([formatKeyValue(args, 'path'), editSummary])
  }
  if (toolName === 'grep') {
    return joinToolParts([
      formatKeyValue(args, 'pattern'),
      formatKeyValue(args, 'path'),
      formatKeyValue(args, 'glob'),
      formatKeyValue(args, 'limit'),
    ])
  }
  if (toolName === 'find') {
    return joinToolParts([formatKeyValue(args, 'pattern'), formatKeyValue(args, 'path'), formatKeyValue(args, 'limit')])
  }
  if (toolName === 'ls') {
    return joinToolParts([formatKeyValue(args, 'path'), formatKeyValue(args, 'limit')])
  }

  return Object.keys(args as Record<string, unknown>)
    .slice(0, 6)
    .map((key) => formatKeyValue(args, key))
    .filter(Boolean)
    .join(' ')
}

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
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta
      text += delta
      void log(delta)
    }
    if (event.type === 'tool_execution_start') {
      const summary = formatToolExecutionSummary(event.toolName, event.args)
      void log(`tool start: ${event.toolName}${summary ? ` ${summary}` : ''}`)
    }
    if (event.type === 'tool_execution_end') {
      void log(`tool end: ${event.toolName} ${event.isError ? 'error' : 'ok'}`)
    }
  })

  try {
    try {
      await runPromptWithTimeout(session, prompt, config.piPromptTimeoutSeconds)
    } catch (error) {
      if (!text.trim() || !isBenignAssistantContinuationError(error)) throw error
      await log(`pi stopped after assistant final response: ${(error as Error).message}`)
    }
    return {
      text,
      tools: session.getActiveToolNames(),
      sessionFile: session.sessionFile,
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}
