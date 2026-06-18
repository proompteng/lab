import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
import type { AnypiStatus } from './types'

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

/**
 * Write status to the status file path.
 * This is a minimal write function to avoid circular imports.
 */
const writeStatusFile = async (path: string, status: Partial<AnypiStatus>) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

/**
 * Capture timeout evidence using shell commands.
 * This function runs git commands directly to avoid circular dependencies.
 */
const captureTimeoutEvidenceDirect = async (
  worktree: string,
  env?: Record<string, string | undefined>,
  runnerLogPath?: string,
  runnerStatusPath?: string,
): Promise<AnypiStatus['timeoutEvidence']> => {
  const timestamp = new Date().toISOString()

  const runGit = async (args: string[]): Promise<string> => {
    return new Promise((resolve, reject) => {
      const subprocess = spawn('git', args, { cwd: worktree, env: { ...process.env, ...env } })
      let stdout = ''
      subprocess.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      subprocess.stderr.on('data', () => {})
      subprocess.on('close', (code: number | null) => {
        if (code === 0 || code === null) resolve(stdout.trim())
        else resolve('')
      })
      subprocess.on('error', reject)
    })
  }

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await runGit(['rev-parse', 'HEAD'])
  const status = await runGit(['status', '--short'])
  const diffStat = await runGit(['diff', '--stat'])

  const patchDir = resolve('/tmp', `anypi-patch-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(patchDir, { recursive: true })
  const patchPath = resolve(patchDir, 'uncommitted.patch')

  const patchSubprocess = spawn('git', ['diff', 'HEAD'], { cwd: worktree, env: { ...process.env, ...env } })
  const patchWriteStream = writeFile(patchPath, '')
  patchSubprocess.stdout.pipe(patchWriteStream as any)
  await patchWriteStream

  return {
    branch,
    head,
    status,
    diffStat,
    patchPath,
    runnerLogPath: runnerLogPath ?? '',
    runnerStatusPath: runnerStatusPath ?? '',
    timestamp,
  }
}

const runPromptWithTimeout = async (
  session: Awaited<ReturnType<typeof createAgentSession>>['session'],
  prompt: string,
  timeoutSeconds: number,
  worktree: string,
  env?: Record<string, string | undefined>,
  runnerLogPath?: string,
  runnerStatusPath?: string,
): Promise<void> => {
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const promptPromise = session.prompt(prompt).catch((error: unknown) => {
    if (timedOut) return
    throw error
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(async () => {
      timedOut = true
      // Capture timeout evidence before dispose
      try {
        const evidence = await captureTimeoutEvidenceDirect(worktree, env, runnerLogPath, runnerStatusPath)
        // Write partial failed status with timeout evidence
        await writeStatusFile(runnerStatusPath ?? '', {
          status: 'failed' as const,
          finishedAt: new Date().toISOString(),
          error: `Pi prompt exceeded ${timeoutSeconds}s timeout`,
          timeoutEvidence: evidence,
        })
      } catch (err) {
        // If status writing fails, still proceed with dispose
        console.error('Failed to write timeout evidence:', err)
      }
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
      void log(`tool start: ${event.toolName}`)
    }
    if (event.type === 'tool_execution_end') {
      void log(`tool end: ${event.toolName}`)
    }
  })

  try {
    try {
      await runPromptWithTimeout(
        session,
        prompt,
        config.piPromptTimeoutSeconds,
        config.worktree,
        undefined, // env - will use process.env merged
        config.logPath,
        config.statusPath,
      )
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
