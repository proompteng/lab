import { spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from './options'

export type CodexEvent = Record<string, unknown>

export interface CodexRunnerLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

export interface CodexRunnerOptions {
  codexPathOverride?: string
}

export interface CodexRunOptions {
  input: string
  model?: string
  sandboxMode?: SandboxMode
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  modelReasoningEffort?: ModelReasoningEffort
  networkAccessEnabled?: boolean
  webSearchEnabled?: boolean
  approvalPolicy?: ApprovalMode
  additionalDirectories?: string[]
  images?: string[]
  jsonMode?: 'json' | 'experimental-json'
  outputSchemaPath?: string
  lastMessagePath?: string
  resumeSessionId?: string | 'last'
  idleTimeoutMs?: number
  completedGraceMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
  eventsPath?: string
  agentLogPath?: string
  allowEmptyEventsOnExitCode?: number
  logger?: CodexRunnerLogger
  onEvent?: (event: CodexEvent) => void
  onRawLine?: (line: string) => void
  onAgentMessage?: (message: string, event: CodexEvent) => void
  onAgentMessageDelta?: (delta: string, event: CodexEvent) => void
  onToolCall?: (payload: string, line: string) => void
  onSessionId?: (sessionId: string) => void
}

export interface CodexRunResult {
  agentMessages: string[]
  sessionId?: string
  exitCode: number
  forcedTermination: boolean
}

const toolCallPattern = /codex_core::codex:\s+ToolCall:\s+(.*)$/
const sessionConfiguredPattern =
  /SessionConfiguredEvent\s*\{\s*session_id:\s*ConversationId\s*\{\s*uuid:\s*([0-9a-fA-F-]+)\s*}/

const ensureFileDirectory = async (path: string | undefined) => {
  if (!path) {
    return
  }
  await mkdir(dirname(path), { recursive: true })
}

const writeLine = (stream: WriteStream, content: string) =>
  new Promise<void>((resolve, reject) => {
    stream.write(`${content}\n`, (error: Error | null | undefined) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })

const closeStream = (stream: WriteStream) =>
  new Promise<void>((resolve, reject) => {
    stream.end((error: Error | null | undefined) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })

const extractToolCallPayload = (line: string): string | undefined => {
  const match = line.match(toolCallPattern)
  if (!match) {
    return undefined
  }
  const payload = match[1]?.trim()
  return payload && payload.length > 0 ? payload : 'Tool call invoked'
}

const normalizeSessionCandidate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const extractSessionIdFromParsedEvent = (parsed: CodexEvent): string | undefined => {
  const threadId = normalizeSessionCandidate(parsed.thread_id)
  if (threadId) {
    return threadId
  }

  const direct =
    normalizeSessionCandidate((parsed.session as Record<string, unknown> | undefined)?.id) ??
    normalizeSessionCandidate(parsed.session_id) ??
    normalizeSessionCandidate(parsed.sessionId)
  if (direct) {
    return direct
  }

  const item = parsed.item as Record<string, unknown> | undefined
  const fromItem =
    normalizeSessionCandidate((item?.session as Record<string, unknown> | undefined)?.id) ??
    normalizeSessionCandidate(item?.session_id) ??
    normalizeSessionCandidate(item?.sessionId)
  if (fromItem) {
    return fromItem
  }

  return normalizeSessionCandidate(parsed.conversation_id) ?? normalizeSessionCandidate(parsed.conversationId)
}

const extractSessionIdFromLogLine = (line: string): string | undefined => {
  const match = line.match(sessionConfiguredPattern)
  if (match?.[1]) {
    return match[1].trim()
  }
  return undefined
}

const readString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const extractAgentMessage = (parsed: CodexEvent): string | undefined => {
  if (parsed.type !== 'item.completed') {
    return undefined
  }
  const item = parsed.item as Record<string, unknown> | undefined
  if (item?.type !== 'agent_message') {
    return undefined
  }
  return readString(item.text)
}

const extractAgentMessageDelta = (parsed: CodexEvent): string | undefined => {
  if (parsed.type === 'response.output_text.delta') {
    return readString(parsed.delta) ?? readString(parsed.text)
  }

  if (parsed.type === 'response.output_text.completed') {
    return readString(parsed.text)
  }

  const item = parsed.item as Record<string, unknown> | undefined
  if (item?.type !== 'agent_message') {
    return undefined
  }

  const itemDelta = readString(item.delta) ?? readString(item.text_delta)
  if (itemDelta) {
    return itemDelta
  }

  const content = item.content
  if (Array.isArray(content)) {
    const parts = content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return undefined
        }
        const text = readString((entry as { text?: unknown }).text)
        return text ?? readString((entry as { delta?: unknown }).delta)
      })
      .filter((value): value is string => Boolean(value))
    if (parts.length > 0) {
      return parts.join('')
    }
  }

  return undefined
}

export class CodexRunner {
  private codexPath: string

  constructor(options: CodexRunnerOptions = {}) {
    this.codexPath = options.codexPathOverride ?? process.env.CODEX_BINARY ?? 'codex'
  }

  async run(options: CodexRunOptions): Promise<CodexRunResult> {
    const {
      input,
      model,
      sandboxMode,
      workingDirectory,
      skipGitRepoCheck,
      modelReasoningEffort,
      networkAccessEnabled,
      webSearchEnabled,
      approvalPolicy,
      additionalDirectories,
      images,
      jsonMode = 'json',
      outputSchemaPath,
      lastMessagePath,
      resumeSessionId,
      idleTimeoutMs = 30 * 60 * 1000,
      completedGraceMs = 2 * 60 * 1000,
      env,
      signal,
      eventsPath,
      agentLogPath,
      allowEmptyEventsOnExitCode,
      logger,
      onEvent,
      onRawLine,
      onAgentMessage,
      onAgentMessageDelta,
      onToolCall,
      onSessionId,
    } = options

    await Promise.all([
      ensureFileDirectory(eventsPath),
      ensureFileDirectory(agentLogPath),
      ensureFileDirectory(lastMessagePath),
    ])

    const jsonStream = eventsPath ? createWriteStream(eventsPath, { flags: 'w' }) : undefined
    const agentStream = agentLogPath ? createWriteStream(agentLogPath, { flags: 'w' }) : undefined

    const commandArgs = ['exec', jsonMode === 'experimental-json' ? '--experimental-json' : '--json']

    if (outputSchemaPath) {
      commandArgs.push('--output-schema', outputSchemaPath)
    }
    if (model) {
      commandArgs.push('--model', model)
    }
    if (sandboxMode) {
      commandArgs.push('--sandbox', sandboxMode)
    }
    if (workingDirectory) {
      commandArgs.push('--cd', workingDirectory)
    }
    if (additionalDirectories?.length) {
      for (const dir of additionalDirectories) {
        commandArgs.push('--add-dir', dir)
      }
    }
    if (skipGitRepoCheck) {
      commandArgs.push('--skip-git-repo-check')
    }
    if (modelReasoningEffort) {
      commandArgs.push('--config', `model_reasoning_effort="${modelReasoningEffort}"`)
    }
    if (networkAccessEnabled !== undefined) {
      commandArgs.push('--config', `sandbox_workspace_write.network_access=${networkAccessEnabled}`)
    }
    if (webSearchEnabled !== undefined) {
      commandArgs.push('--config', `features.web_search_request=${webSearchEnabled}`)
    }
    if (approvalPolicy) {
      commandArgs.push('--config', `approval_policy="${approvalPolicy}"`)
    }
    if (images?.length) {
      for (const image of images) {
        commandArgs.push('--image', image)
      }
    }
    if (lastMessagePath) {
      commandArgs.push('--output-last-message', lastMessagePath)
    }

    const resumeArg = resumeSessionId?.trim()
    if (resumeArg) {
      commandArgs.push('resume')
      if (resumeArg === 'last' || resumeArg === '--last') {
        commandArgs.push('--last')
      } else {
        commandArgs.push(resumeArg)
      }
    }

    const useStdinDash = !(resumeArg === 'last' || resumeArg === '--last')
    if (useStdinDash) {
      commandArgs.push('-')
    }

    const child = spawn(this.codexPath, commandArgs, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    })

    let spawnError: Error | null = null
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error('failed to spawn codex process')
    })

    const exitPromise = new Promise<number>((resolve) => {
      child.once('exit', (code) => resolve(code ?? -1))
    })

    if (!child.stdin) {
      child.kill()
      throw new Error('codex subprocess missing stdin handle')
    }

    child.stdin.write(input)
    child.stdin.end()

    if (!child.stdout) {
      child.kill()
      throw new Error('codex subprocess missing stdout handle')
    }

    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })

    const agentMessages: string[] = []
    let sessionId: string | undefined
    let sawTurnCompleted = false
    let forcedTermination = false
    let lastActivity = Date.now()
    let lineCount = 0

    const killForIdle = (timeoutMs: number) => {
      forcedTermination = true
      logger?.warn?.(`Codex stdout idle for ${Date.now() - lastActivity}ms; terminating after ${timeoutMs}ms`, {
        timeoutMs,
      })
      reader.close()
      if (!child.killed) {
        child.kill()
      }
    }

    const timer = setInterval(() => {
      const timeoutMs = sawTurnCompleted ? completedGraceMs : idleTimeoutMs
      if (Date.now() - lastActivity > timeoutMs) {
        killForIdle(timeoutMs)
      }
    }, 1000)
    timer.unref?.()

    try {
      for await (const line of reader) {
        if (!line.trim()) {
          continue
        }
        lastActivity = Date.now()
        lineCount += 1
        onRawLine?.(line)
        if (jsonStream) {
          await writeLine(jsonStream, line)
        }

        const toolCallPayload = extractToolCallPayload(line)
        if (toolCallPayload) {
          onToolCall?.(toolCallPayload, line)
        }

        if (!sessionId) {
          const logLineSession = extractSessionIdFromLogLine(line)
          if (logLineSession) {
            sessionId = logLineSession
            onSessionId?.(sessionId)
          }
        }

        let parsed: CodexEvent | undefined
        try {
          parsed = JSON.parse(line) as CodexEvent
        } catch (error) {
          if (!toolCallPayload) {
            logger?.error?.('Failed to parse Codex event line as JSON', { error })
          }
        }

        if (!parsed) {
          continue
        }

        onEvent?.(parsed)

        if (!sessionId) {
          const parsedSession = extractSessionIdFromParsedEvent(parsed)
          if (parsedSession) {
            sessionId = parsedSession
            onSessionId?.(sessionId)
          }
        }

        if (parsed.type === 'turn.completed') {
          sawTurnCompleted = true
        }

        const agentMessage = extractAgentMessage(parsed)
        if (agentMessage) {
          agentMessages.push(agentMessage)
          if (agentStream) {
            await writeLine(agentStream, agentMessage)
          }
          onAgentMessage?.(agentMessage, parsed)
        }

        const delta = extractAgentMessageDelta(parsed)
        if (delta) {
          onAgentMessageDelta?.(delta, parsed)
        }
      }
    } finally {
      clearInterval(timer)
      reader.close()
    }

    if (jsonStream) {
      await closeStream(jsonStream)
    }
    if (agentStream) {
      await closeStream(agentStream)
    }

    const exitCode = await exitPromise

    if (spawnError) {
      throw spawnError
    }

    if (!forcedTermination && exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const allowEmptyEvents = allowEmptyEventsOnExitCode !== undefined && exitCode === allowEmptyEventsOnExitCode
      if (!allowEmptyEvents || lineCount > 0) {
        throw new Error(`codex exited with status ${exitCode}: ${stderr}`)
      }
      logger?.warn?.('Codex exited non-zero but event log empty; allowing continuation', { exitCode })
    }

    return { agentMessages, sessionId, exitCode, forcedTermination }
  }
}
