import { createWriteStream, type WriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import process from 'node:process'
import { ensureFileDirectory } from './fs'
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

const decoder = new TextDecoder()
const toolCallPattern = /codex_core::codex:\s+ToolCall:\s+(.*)$/
const sessionConfiguredPattern =
  /SessionConfiguredEvent\s*\{\s*session_id:\s*ConversationId\s*\{\s*uuid:\s*([0-9a-fA-F-]+)\s*}/

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

const extractSessionIdFromParsedEvent = (parsed: Record<string, unknown>): string | undefined => {
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

const writeLine = (stream: WriteStream, content: string) => {
  return new Promise<void>((resolve, reject) => {
    stream.write(`${content}\n`, (error: Error | null | undefined) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

const closeStream = (stream: WriteStream) => {
  return new Promise<void>((resolve, reject) => {
    stream.end((error: Error | null | undefined) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
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

  await Promise.all([
    ensureFileDirectory(outputPath),
    ensureFileDirectory(jsonOutputPath),
    ensureFileDirectory(agentOutputPath),
  ])

  const jsonStream = createWriteStream(jsonOutputPath, { flags: 'w' })
  const agentStream = createWriteStream(agentOutputPath, { flags: 'w' })

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

  const codexCommand = [
    'codex',
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    outputPath,
  ]

  const envModel = process.env.CODEX_MODEL?.trim()
  if (envModel) {
    codexCommand.push('-m', envModel)
  }

  if (resumeArg && resumeArg.length > 0) {
    codexCommand.push('resume')
    if (resumeArg === '--last') {
      codexCommand.push('--last')
    } else {
      codexCommand.push(resumeArg)
    }
  }

  // For --last we must not pass any positional (clap treats it as session_id and errors).
  // For all other cases, pass '-' so Codex reads the prompt from stdin.
  const useStdinDash = !(resumeArg === '--last')
  if (useStdinDash) {
    codexCommand.push('-')
  }

  const codexProcess = Bun.spawn({
    cmd: codexCommand,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      CODEX_STAGE: stage,
    },
  })

  const codexStdin = createWritableHandle(codexProcess.stdin)
  if (!codexStdin) {
    throw new Error('Codex subprocess is missing stdin')
  }

  await codexStdin.write(prompt)
  await codexStdin.close()

  const agentMessages: string[] = []
  const reader = codexProcess.stdout?.getReader()
  let buffer = ''
  let sessionId: string | undefined
  let sawTurnCompleted = false
  let forcedTermination = false
  let lastActivity = Date.now()

  if (!reader) {
    throw new Error('Codex subprocess is missing stdout')
  }

  const flushLine = async (line: string) => {
    if (!line.trim()) {
      return
    }

    await writeLine(jsonStream, line)
    lastActivity = Date.now()

    const toolCallPayload = extractToolCallPayload(line)
    const logLineSession = extractSessionIdFromLogLine(line)

    if (!sessionId && logLineSession) {
      sessionId = logLineSession
    }

    if (toolCallPayload && discordWriter && !discordClosed) {
      try {
        await discordWriter.write(`ToolCall → ${toolCallPayload}\n`)
      } catch (error) {
        discordClosed = true
        await discordWriter.close().catch(() => {})
        if (discordChannel?.onError && error instanceof Error) {
          discordChannel.onError(error)
        } else {
          log.error('Failed to write tool call to Discord channel:', error)
        }
      }
    }

    try {
      const parsed = JSON.parse(line)
      const item = parsed?.item
      if (!sessionId) {
        const candidateSession = extractSessionIdFromParsedEvent(parsed)
        if (candidateSession) {
          sessionId = candidateSession
        }
      }
      if (parsed?.type === 'turn.completed') {
        sawTurnCompleted = true
      }
      if (parsed?.type === 'item.completed' && item?.type === 'agent_message' && typeof item?.text === 'string') {
        const message = item.text
        agentMessages.push(message)
        await writeLine(agentStream, message)
        if (discordWriter && !discordClosed) {
          try {
            await discordWriter.write(`${message}\n`)
          } catch (error) {
            discordClosed = true
            await discordWriter.close().catch(() => {})
            if (discordChannel?.onError && error instanceof Error) {
              discordChannel.onError(error)
            } else {
              log.error('Failed to write to Discord channel stream:', error)
            }
          }
        }
      }
    } catch (error) {
      if (!toolCallPayload && !logLineSession) {
        log.error('Failed to parse Codex event line as JSON:', error)
      }
    }
  }

  while (true) {
    const timeoutMs = sawTurnCompleted ? completedGraceMs : idleTimeoutMs

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const readResult = await Promise.race([
      reader.read(),
      new Promise<{ timeout: true }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs)
        // Avoid keeping the event loop alive after a successful read.
        if (typeof (timeoutHandle as unknown as { unref?: () => void }).unref === 'function') {
          ;(timeoutHandle as unknown as { unref: () => void }).unref()
        }
      }),
    ])

    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }

    if ((readResult as { timeout?: boolean }).timeout) {
      const idleFor = Date.now() - lastActivity
      log.warn(
        `Codex stdout idle for ${idleFor}ms (stage=${stage}); terminating child process after timeout ${timeoutMs}ms`,
      )
      forcedTermination = true
      await reader.cancel().catch(() => {})
      codexProcess.kill()
      break
    }

    const { value, done } = readResult as { value?: Uint8Array; done?: boolean }
    if (done) {
      break
    }
    if (!value) {
      continue
    }
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      await flushLine(line)
      newlineIndex = buffer.indexOf('\n')
    }
  }

  const remaining = buffer.trim()
  if (remaining) {
    await flushLine(remaining)
  }

  await closeStream(jsonStream)
  await closeStream(agentStream)

  if (discordWriter && !discordClosed) {
    await discordWriter.close()
    discordClosed = true
  }

  const codexExitCode = await codexProcess.exited

  if (forcedTermination) {
    if (codexExitCode !== 0) {
      log.warn(`Codex subprocess was terminated due to idle timeout (exit ${codexExitCode})`)
    } else {
      log.warn('Codex subprocess was terminated due to idle timeout')
    }
  } else if (codexExitCode !== 0) {
    let eventsLogMissing = false
    try {
      const stats = await stat(jsonOutputPath)
      eventsLogMissing = stats.size === 0
    } catch (error) {
      if (isNotFoundError(error)) {
        eventsLogMissing = true
      } else {
        throw error
      }
    }

    const allowArtifactCapture = eventsLogMissing && codexExitCode === 1

    if (allowArtifactCapture) {
      log.warn(
        `Codex exited with status ${codexExitCode} but event log is missing/empty; continuing to allow artifact capture`,
      )
    } else {
      throw new Error(`Codex exited with status ${codexExitCode}`)
    }
  }

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
