import { stat } from 'node:fs/promises'
import process from 'node:process'
import { CodexRunner } from '@proompteng/codex'
import { type CodexLogger, consoleLogger } from './logger'

export interface DiscordChannelOptions {
  command: string[]
  onError?: (error: Error) => void
}

export interface RunCodexSessionOptions {
  stage: 'planning' | 'implementation' | 'review' | 'research'
  prompt: string
  outputPath: string
  jsonOutputPath: string
  agentOutputPath: string
  discordChannel?: DiscordChannelOptions
  resumeSessionId?: string
  logger?: CodexLogger
}

export interface RunCodexSessionResult {
  agentMessages: string[]
  sessionId?: string
}

export interface PushCodexEventsToLokiOptions {
  stage: string
  endpoint?: string
  jsonPath?: string
  agentLogPath?: string
  runtimeLogPath?: string
  labels?: Record<string, string | undefined>
  tenant?: string
  basicAuth?: string
  logger?: CodexLogger
}

interface WritableHandle {
  write: (chunk: string) => Promise<void>
  close: () => Promise<void>
}

const createWritableHandle = (stream: unknown): WritableHandle | undefined => {
  if (!stream) {
    return undefined
  }

  const candidate = stream as {
    getWriter?: () => WritableStreamDefaultWriter<string>
    write?: (chunk: string) => unknown
    flush?: () => Promise<unknown> | unknown
    end?: () => unknown
    close?: () => Promise<unknown> | unknown
  }

  if (typeof candidate.getWriter === 'function') {
    const writer = candidate.getWriter()
    return {
      write: async (chunk: string) => {
        await writer.write(chunk)
      },
      close: async () => {
        await writer.close()
      },
    }
  }

  if (typeof candidate.write === 'function') {
    return {
      write: async (chunk: string) => {
        candidate.write?.call(candidate, chunk)
        if (typeof candidate.flush === 'function') {
          try {
            await candidate.flush.call(candidate)
          } catch {
            // ignore flush errors; fallback to best effort
          }
        }
      },
      close: async () => {
        if (typeof candidate.end === 'function') {
          candidate.end.call(candidate)
        } else if (typeof candidate.close === 'function') {
          await candidate.close.call(candidate)
        }
      },
    }
  }

  return undefined
}

export const runCodexSession = async ({
  stage,
  prompt,
  outputPath,
  jsonOutputPath,
  agentOutputPath,
  discordChannel,
  resumeSessionId,
  logger,
}: RunCodexSessionOptions): Promise<RunCodexSessionResult> => {
  const log = logger ?? consoleLogger
  const resumeArg = resumeSessionId?.trim()

  const parsePositiveMs = (value: string | undefined, fallback: number) => {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
    return fallback
  }

  // Long-running tool calls may stay quiet; default to 30 minutes of silence before we force-exit.
  const idleTimeoutMs = parsePositiveMs(process.env.CODEX_IDLE_TIMEOUT_MS, 30 * 60 * 1000)
  // After the model reports turn completion, give a short grace period before forcing exit.
  const completedGraceMs = parsePositiveMs(process.env.CODEX_EXIT_GRACE_MS, 2 * 60 * 1000)

  let discordProcess: ReturnType<typeof Bun.spawn> | undefined
  let discordWriter: WritableHandle | undefined
  let discordClosed = false

  if (discordChannel) {
    try {
      discordProcess = Bun.spawn({
        cmd: discordChannel.command,
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const handle = createWritableHandle(discordProcess.stdin)
      if (handle) {
        discordWriter = handle
      } else {
        log.warn('Discord channel process did not expose stdin; disabling channel streaming')
        discordProcess.kill()
        discordProcess = undefined
        discordWriter = undefined
      }
    } catch (error) {
      if (discordChannel.onError && error instanceof Error) {
        discordChannel.onError(error)
      } else {
        log.error('Failed to start Discord channel:', error)
      }
    }
  }

  const runner = new CodexRunner()
  const agentMessages: string[] = []
  let sessionId: string | undefined
  let sawDelta = false

  const closeDiscordWriter = async () => {
    if (discordWriter && !discordClosed) {
      discordClosed = true
      await discordWriter.close().catch(() => {})
    }
  }

  const writeStdout = (payload: string) => {
    try {
      process.stdout.write(payload)
    } catch {
      // ignore stdout write errors; best-effort streaming
    }
  }

  const writeDiscord = async (payload: string, errorLabel: string) => {
    if (!discordWriter || discordClosed) {
      return
    }
    try {
      await discordWriter.write(payload)
    } catch (error) {
      await closeDiscordWriter()
      if (discordChannel?.onError && error instanceof Error) {
        discordChannel.onError(error)
      } else {
        log.error(errorLabel, error)
      }
    }
  }

  const emitStreamLine = async (payload: string, errorLabel: string) => {
    if (!payload) {
      return
    }
    const normalized = payload.endsWith('\n') ? payload : `${payload}\n`
    writeStdout(normalized)
    await writeDiscord(normalized, errorLabel)
  }

  const readString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined
    }
    const trimmed = value.trimEnd()
    return trimmed.length > 0 ? trimmed : undefined
  }

  const handleItemEvent = async (event: Record<string, unknown>, type: string) => {
    const item = event.item as Record<string, unknown> | undefined
    if (!item || typeof item !== 'object') {
      return
    }

    const itemType = typeof item.type === 'string' ? item.type : ''
    if (!itemType || itemType === 'agent_message' || itemType === 'reasoning') {
      return
    }

    if (itemType === 'command_execution') {
      if (type === 'item.started') {
        const command = readString(item.command)
        if (command) {
          await emitStreamLine(`$ ${command}`, 'Failed to write command start to Discord channel:')
        }
        return
      }

      const aggregated = readString(item.aggregated_output)
      const output = aggregated ?? readString(item.output)
      if (output) {
        await emitStreamLine(output, 'Failed to write command output to Discord channel:')
      }
      const exitCode = item.exit_code
      if (typeof exitCode === 'number' && exitCode !== 0) {
        await emitStreamLine(
          `Command exited with status ${exitCode}`,
          'Failed to write command exit status to Discord channel:',
        )
      }
      return
    }

    const text =
      readString(item.text) ??
      readString(item.output) ??
      readString(item.result) ??
      readString(item.message) ??
      readString(item.error)
    if (text) {
      await emitStreamLine(`[${itemType}] ${text}`, 'Failed to write tool output to Discord channel:')
    }
  }

  const runResult = await runner.run({
    input: prompt,
    model: process.env.CODEX_MODEL?.trim() || undefined,
    jsonMode: 'json',
    dangerouslyBypassApprovalsAndSandbox: true,
    lastMessagePath: outputPath,
    eventsPath: jsonOutputPath,
    agentLogPath: agentOutputPath,
    resumeSessionId: resumeArg === '--last' ? 'last' : resumeArg,
    idleTimeoutMs,
    completedGraceMs,
    env: { CODEX_STAGE: stage },
    allowEmptyEventsOnExitCode: 1,
    logger: log,
    onSessionId: (id) => {
      sessionId = id
    },
    onToolCall: async (payload) => {
      await emitStreamLine(`ToolCall → ${payload}`, 'Failed to write tool call to Discord channel:')
    },
    onEvent: async (event) => {
      const eventType = typeof event.type === 'string' ? event.type : ''
      if (eventType === 'item.started' || eventType === 'item.completed') {
        await handleItemEvent(event, eventType)
      }
    },
    onAgentMessageDelta: async (delta) => {
      sawDelta = true
      await emitStreamLine(delta, 'Failed to write to Discord channel stream:')
    },
    onAgentMessage: async (message) => {
      if (!sawDelta) {
        await emitStreamLine(message, 'Failed to write to Discord channel stream:')
      }
    },
  })

  agentMessages.push(...runResult.agentMessages)
  if (!sessionId) {
    sessionId = runResult.sessionId
  }

  await closeDiscordWriter()

  if (discordProcess) {
    const discordExit = await discordProcess.exited
    if (discordExit !== 0 && discordChannel?.onError) {
      discordChannel.onError(new Error(`Discord channel exited with status ${discordExit}`))
    }
  }

  return { agentMessages, sessionId }
}

export const pushCodexEventsToLoki = async ({
  stage,
  endpoint,
  jsonPath,
  agentLogPath,
  runtimeLogPath,
  labels,
  tenant,
  basicAuth,
  logger,
}: PushCodexEventsToLokiOptions) => {
  if (!endpoint) {
    return
  }

  const log = logger ?? consoleLogger
  const baseLabels = buildLokiLabels(stage, labels)
  const nextTimestamp = createTimestampGenerator()
  const streams: LokiStreamPayload[] = []

  if (jsonPath) {
    const jsonLines = await loadLogLines(jsonPath, 'Codex JSON event log', log)
    if (jsonLines && jsonLines.length > 0) {
      const values: Array<[string, string]> = []
      jsonLines.forEach((line) => {
        try {
          const payload = JSON.stringify(JSON.parse(line))
          values.push([nextTimestamp(), payload])
        } catch (error) {
          log.error('Skipping Codex event line that failed to parse for Loki export:', error)
        }
      })
      if (values.length > 0) {
        streams.push({
          stream: { ...baseLabels, stream_type: 'json', source: 'codex-events' },
          values,
        })
      } else {
        log.warn('Codex JSON event payload empty after parsing; skipping Loki export')
      }
    }
  }

  if (agentLogPath) {
    const agentLines = await loadLogLines(agentLogPath, 'Codex agent log', log)
    if (agentLines && agentLines.length > 0) {
      streams.push({
        stream: { ...baseLabels, stream_type: 'agent', source: 'codex-agent' },
        values: agentLines.map<[string, string]>((line) => [nextTimestamp(), line]),
      })
    }
  }

  if (runtimeLogPath) {
    const runtimeLines = await loadLogLines(runtimeLogPath, 'Codex runtime log', log)
    if (runtimeLines && runtimeLines.length > 0) {
      streams.push({
        stream: { ...baseLabels, stream_type: 'runtime', source: 'codex-runtime' },
        values: runtimeLines.map<[string, string]>((line) => [nextTimestamp(), line]),
      })
    }
  }

  if (streams.length === 0) {
    log.warn('No Codex log payloads available; skipping Loki export')
    return
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (tenant) {
    headers['X-Scope-OrgID'] = tenant
  }

  if (basicAuth) {
    headers.Authorization = basicAuth.startsWith('Basic ') ? basicAuth : `Basic ${basicAuth}`
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ streams }),
    })

    if (!response.ok) {
      log.error(`Failed to push Codex events to Loki at ${endpoint}: ${response.status} ${response.statusText}`)
    } else {
      log.info(`Pushed Codex events to Loki at ${endpoint}`)
    }
  } catch (error) {
    log.error('Failed to push Codex events to Loki:', error)
  }
}

const loadLogLines = async (path: string, description: string, log: CodexLogger) => {
  try {
    const stats = await stat(path)
    if (stats.size === 0) {
      log.warn(`${description} is empty; skipping log export`)
      return undefined
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      log.warn(`${description} not found at ${path}; skipping log export`)
      return undefined
    }
    throw error
  }

  const raw = await Bun.file(path).text()
  const lines: string[] = []

  raw.split(/\r?\n/).forEach((line) => {
    if (line.trim().length > 0) {
      lines.push(line)
    }
  })

  if (lines.length === 0) {
    log.warn(`${description} payload empty after parsing; skipping log export`)
    return undefined
  }

  return lines
}

const createTimestampGenerator = () => {
  const base = BigInt(Date.now()) * 1_000_000n
  let offset = 0n
  return () => {
    const timestamp = base + offset
    offset += 1n
    return timestamp.toString()
  }
}

const buildLokiLabels = (stage: string, labels?: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {
    job: 'codex-exec',
  }

  const stageValue = sanitizeLabelValue(stage)
  if (stageValue) {
    result.stage = stageValue
  }

  if (labels) {
    for (const [key, value] of Object.entries(labels)) {
      if (!key || value === undefined || value === null) {
        continue
      }
      const sanitizedKey = sanitizeLabelKey(key)
      if (!sanitizedKey || sanitizedKey === 'stage' || sanitizedKey === 'job') {
        continue
      }
      const sanitizedValue = sanitizeLabelValue(value)
      if (!sanitizedValue) {
        continue
      }
      result[sanitizedKey] = sanitizedValue
    }
  }

  return result
}

const sanitizeLabelKey = (key: string) => key.trim().replace(/[^A-Za-z0-9_]/g, '_')

const sanitizeLabelValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return ''
  }
  const normalized = `${value}`.trim()
  return normalized === 'null' ? '' : normalized
}

const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException => {
  if (!(error instanceof Error)) {
    return false
  }
  return 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

interface LokiStreamPayload {
  stream: Record<string, string>
  values: Array<[string, string]>
}
