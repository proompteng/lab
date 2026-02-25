import { stat } from 'node:fs/promises'
import process from 'node:process'
import { CodexRunner } from '@proompteng/codex'
import { type CodexLogger, consoleLogger } from './logger'

// Keep the codex runtime self-contained: Discord channel frames are NUL-delimited.
const DISCORD_MESSAGE_SEPARATOR = '\u0000'

export interface DiscordChannelOptions {
  command: string[]
  onError?: (error: Error) => void
}

export interface RunCodexSessionOptions {
  stage: 'planning' | 'implementation' | 'review' | 'research' | 'verify'
  prompt: string
  systemPrompt?: string
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
  exitCode?: number
  forcedTermination?: boolean
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

const MAX_DISCORD_COMMAND_LINES = 10
const DISCORD_STREAM_FLUSH_THRESHOLD = 900

const normalizeLineBreaks = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const trimTrailingEmptyLines = (lines: string[]) => {
  let trimmed = lines.slice()
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

const truncateCommandOutput = (output: string) => {
  const normalized = normalizeLineBreaks(output)
  const lines = trimTrailingEmptyLines(normalized.split('\n'))
  if (lines.length <= MAX_DISCORD_COMMAND_LINES) {
    return { lines, truncated: false, truncatedCount: 0 }
  }

  const visibleLineCount = Math.max(0, MAX_DISCORD_COMMAND_LINES - 1)
  const truncatedCount = lines.length - visibleLineCount
  const visibleLines = lines.slice(0, visibleLineCount)
  visibleLines.push(`... (truncated, ${truncatedCount} more line${truncatedCount === 1 ? '' : 's'})`)
  return { lines: visibleLines, truncated: true, truncatedCount }
}

const createCodeFence = (content: string, language = 'ts') => {
  const matches = content.match(/`+/g) ?? []
  const longest = matches.reduce((max, segment) => Math.max(max, segment.length), 0)
  const fenceLength = Math.max(3, longest + 1)
  const fence = '`'.repeat(fenceLength)
  return {
    open: `\n${fence}${language}\n`,
    close: `\n${fence}\n`,
  }
}

const formatDiscordCommandBlock = (command?: string, output?: string, exitCode?: number) => {
  const lines: string[] = []
  if (command) {
    lines.push(`$ ${command}`)
  }
  if (output) {
    const { lines: outputLines } = truncateCommandOutput(output)
    lines.push(...outputLines)
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    lines.push(`exit status: ${exitCode}`)
  }
  if (lines.length === 0) {
    return undefined
  }
  const content = lines.join('\n')
  const fence = createCodeFence(content, 'ts')
  return `${fence.open}${content}${fence.close}`
}

export const runCodexSession = async ({
  stage,
  prompt,
  systemPrompt,
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
  let discordStreamBuffer = ''
  let discordWriteQueue = Promise.resolve()

  const awaitDiscordQueueDrain = async () => {
    try {
      await discordWriteQueue
    } catch {
      // ignore queued write failures
    }
  }

  const closeDiscordWriter = async () => {
    if (discordWriter && !discordClosed) {
      discordClosed = true
      await discordWriter.close().catch(() => {})
    }
  }

  const enqueueDiscordWrite = async (task: () => Promise<void>) => {
    const next = discordWriteQueue.then(task, task)
    discordWriteQueue = next.catch(() => undefined)
    return next
  }

  const writeStdout = (payload: string) => {
    try {
      process.stdout.write(payload)
    } catch {
      // ignore stdout write errors; best-effort streaming
    }
  }

  const writeDiscordRaw = async (payload: string, errorLabel: string) => {
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

  const writeDiscordMessage = async (payload: string, errorLabel: string) => {
    if (!payload) {
      return
    }
    const framed = `${DISCORD_MESSAGE_SEPARATOR}${payload}${DISCORD_MESSAGE_SEPARATOR}`
    await enqueueDiscordWrite(async () => {
      await writeDiscordRaw(framed, errorLabel)
    })
  }

  const flushDiscordStream = async () => {
    await enqueueDiscordWrite(async () => {
      if (!discordStreamBuffer) {
        return
      }
      const payload = discordStreamBuffer
      discordStreamBuffer = ''
      const framed = `${DISCORD_MESSAGE_SEPARATOR}${payload}${DISCORD_MESSAGE_SEPARATOR}`
      await writeDiscordRaw(framed, 'Failed to write to Discord channel stream:')
    })
  }

  const queueDiscordStream = async (payload: string) => {
    if (!payload) {
      return
    }
    await enqueueDiscordWrite(async () => {
      if (!discordWriter || discordClosed) {
        return
      }
      discordStreamBuffer += payload
      if (discordStreamBuffer.length >= DISCORD_STREAM_FLUSH_THRESHOLD || payload.includes('\n')) {
        const framed = `${DISCORD_MESSAGE_SEPARATOR}${discordStreamBuffer}${DISCORD_MESSAGE_SEPARATOR}`
        discordStreamBuffer = ''
        await writeDiscordRaw(framed, 'Failed to write to Discord channel stream:')
      }
    })
  }

  const emitStreamLine = async (payload: string, errorLabel: string) => {
    if (!payload) {
      return
    }
    const normalized = payload.endsWith('\n') ? payload : `${payload}\n`
    writeStdout(normalized)
    await flushDiscordStream()
    await writeDiscordMessage(normalized, errorLabel)
  }

  const emitStdoutLine = (payload: string) => {
    if (!payload) {
      return
    }
    const normalized = payload.endsWith('\n') ? payload : `${payload}\n`
    writeStdout(normalized)
  }

  const readString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined
    }
    const trimmed = value.trimEnd()
    return trimmed.length > 0 ? trimmed : undefined
  }

  const formatFileChangeSummary = (item: Record<string, unknown>) => {
    const rawChanges = item.changes
    const changes = Array.isArray(rawChanges)
      ? rawChanges
          .map((entry) => {
            if (!entry || typeof entry !== 'object') {
              return undefined
            }
            const path = readString((entry as { path?: unknown }).path)
            const kind = readString((entry as { kind?: unknown }).kind)
            if (!path && !kind) {
              return undefined
            }
            return kind ? `${kind} ${path ?? ''}`.trim() : path
          })
          .filter((value): value is string => Boolean(value))
      : []

    const status = readString(item.status)
    const prefix = status ? `Files changed (${status})` : 'Files changed'
    if (changes.length === 0) {
      return prefix
    }
    return `${prefix} → ${changes.join(', ')}`
  }

  const formatTodoList = (items: unknown) => {
    if (!Array.isArray(items)) {
      return []
    }
    return items
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return undefined
        }
        const text = readString((entry as { text?: unknown }).text)
        if (!text) {
          return undefined
        }
        const completed = Boolean((entry as { completed?: unknown }).completed)
        return `- [${completed ? 'x' : ' '}] ${text}`
      })
      .filter((value): value is string => Boolean(value))
  }

  const formatMcpToolCall = (item: Record<string, unknown>) => {
    const server = readString(item.server) ?? 'mcp'
    const tool = readString(item.tool) ?? 'call'
    const status = readString(item.status)
    const query = readString((item.arguments as Record<string, unknown> | undefined)?.query)
    let header = `MCP → ${server}.${tool}`
    if (status) {
      header += ` (${status})`
    }
    if (query) {
      header += ` query="${query}"`
    }

    const result = item.result as Record<string, unknown> | undefined
    let resultText: string | undefined
    if (result && typeof result === 'object') {
      const content = result.content
      if (Array.isArray(content)) {
        const parts = content
          .map((entry) => {
            if (!entry || typeof entry !== 'object') {
              return undefined
            }
            return readString((entry as { text?: unknown }).text)
          })
          .filter((value): value is string => Boolean(value))
        if (parts.length > 0) {
          resultText = parts.join(' ')
        }
      }
      if (!resultText) {
        const structured = result.structured_content ?? result.structuredContent
        if (structured && typeof structured === 'object') {
          const count = (structured as { count?: unknown }).count
          if (typeof count === 'number') {
            resultText = `result count: ${count}`
          }
        }
      }
    }

    const errorMessage = readString((item.error as Record<string, unknown> | undefined)?.message)

    return {
      header,
      resultText,
      errorMessage,
    }
  }

  const readNumber = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  const handleTurnCompleted = async (event: Record<string, unknown>) => {
    const usage = event.usage as Record<string, unknown> | undefined
    if (!usage) {
      return
    }

    const inputTokens = readNumber(usage.input_tokens ?? usage.inputTokens ?? usage.input)
    const cachedInputTokens = readNumber(usage.cached_input_tokens ?? usage.cachedInputTokens)
    const outputTokens = readNumber(usage.output_tokens ?? usage.outputTokens ?? usage.output)
    const reasoningTokens = readNumber(usage.reasoning_tokens ?? usage.reasoningTokens)

    const hasUsage =
      inputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      outputTokens !== undefined ||
      reasoningTokens !== undefined
    if (!hasUsage) {
      return
    }

    const parts: string[] = []
    if (inputTokens !== undefined) {
      const cachedSuffix = cachedInputTokens !== undefined ? ` (cached ${cachedInputTokens})` : ''
      parts.push(`input: ${inputTokens}${cachedSuffix}`)
    } else if (cachedInputTokens !== undefined) {
      parts.push(`input cached: ${cachedInputTokens}`)
    }
    if (outputTokens !== undefined) {
      parts.push(`output: ${outputTokens}`)
    }
    if (reasoningTokens !== undefined) {
      parts.push(`reasoning: ${reasoningTokens}`)
    }

    if (parts.length === 0) {
      return
    }
    await emitStreamLine(`Usage → ${parts.join(' | ')}`, 'Failed to write token usage to Discord channel:')
  }

  const handleItemEvent = async (event: Record<string, unknown>, type: string) => {
    const item = event.item as Record<string, unknown> | undefined
    if (!item || typeof item !== 'object') {
      return
    }

    const itemType = typeof item.type === 'string' ? item.type : ''
    if (!itemType || itemType === 'agent_message') {
      return
    }

    if (itemType === 'reasoning') {
      const text = readString(item.text)
      if (text) {
        await emitStreamLine(text, 'Failed to write reasoning summary to Discord channel:')
      }
      return
    }

    if (itemType === 'command_execution') {
      if (type === 'item.started') {
        const command = readString(item.command)
        if (command) {
          emitStdoutLine(`$ ${command}`)
        }
        return
      }

      const aggregated = readString(item.aggregated_output)
      const output = aggregated ?? readString(item.output)
      if (output) {
        emitStdoutLine(output)
      }
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
      if (exitCode !== undefined && exitCode !== 0) {
        emitStdoutLine(`Command exited with status ${exitCode}`)
      }

      const command = readString(item.command)
      const discordBlock = formatDiscordCommandBlock(command, output, exitCode)
      if (discordBlock) {
        await flushDiscordStream()
        await writeDiscordMessage(discordBlock, 'Failed to write command output to Discord channel:')
      }
      return
    }

    if (itemType === 'file_change') {
      await emitStreamLine(formatFileChangeSummary(item), 'Failed to write file change to Discord channel:')
      return
    }

    if (itemType === 'web_search') {
      const query = readString(item.query) ?? readString(item.text)
      if (query) {
        await emitStreamLine(`Web search → ${query}`, 'Failed to write web search to Discord channel:')
      }
      return
    }

    if (itemType === 'todo_list') {
      const statusLabel = type === 'item.started' ? 'started' : type === 'item.updated' ? 'updated' : 'completed'
      const lines = formatTodoList(item.items)
      const payload = [`Todo list (${statusLabel}):`, ...lines].join('\n')
      await emitStreamLine(payload, 'Failed to write todo list to Discord channel:')
      return
    }

    if (itemType === 'mcp_tool_call') {
      const { header, resultText, errorMessage } = formatMcpToolCall(item)
      const lines = [header]
      if (resultText) {
        lines.push(resultText)
      }
      if (errorMessage) {
        lines.push(`Error → ${errorMessage}`)
      }
      await emitStreamLine(lines.join('\n'), 'Failed to write MCP tool call to Discord channel:')
      return
    }

    if (itemType === 'error') {
      const message = readString(item.message) ?? readString(item.text)
      if (message) {
        await emitStreamLine(`Error item → ${message}`, 'Failed to write error item to Discord channel:')
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
    systemPrompt,
    model: process.env.CODEX_MODEL?.trim() || undefined,
    jsonMode: 'json',
    dangerouslyBypassApprovalsAndSandbox: true,
    workingDirectory: process.env.WORKTREE?.trim() || undefined,
    sandboxMode: (process.env.CODEX_SANDBOX_MODE?.trim() || 'workspace-write') as
      | 'workspace-write'
      | 'workspace-readonly'
      | 'unrestricted',
    skipGitRepoCheck: (process.env.CODEX_SKIP_GIT_REPO_CHECK ?? '1').trim() !== '0',
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
      if (eventType === 'turn.started') {
        await emitStreamLine('Turn started', 'Failed to write turn started to Discord channel:')
        return
      }
      if (eventType === 'turn.completed') {
        await handleTurnCompleted(event)
        return
      }
      if (eventType === 'turn.failed') {
        const error = event.error as Record<string, unknown> | undefined
        const message = readString(error?.message) ?? readString(event.message)
        const payload = message ? `Turn failed → ${message}` : 'Turn failed'
        await emitStreamLine(payload, 'Failed to write turn failure to Discord channel:')
        return
      }
      if (eventType === 'error') {
        const message =
          readString(event.message) ?? readString((event.error as Record<string, unknown> | undefined)?.message)
        const payload = message ? `Stream error → ${message}` : 'Stream error'
        await emitStreamLine(payload, 'Failed to write stream error to Discord channel:')
        return
      }
      if (eventType === 'item.started' || eventType === 'item.updated' || eventType === 'item.completed') {
        await handleItemEvent(event, eventType)
      }
    },
    onAgentMessageDelta: async (delta) => {
      sawDelta = true
      if (!delta) {
        return
      }
      writeStdout(delta)
      await queueDiscordStream(delta)
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

  await flushDiscordStream()
  await awaitDiscordQueueDrain()
  await closeDiscordWriter()

  if (discordProcess) {
    const discordExit = await discordProcess.exited
    if (discordExit !== 0 && discordChannel?.onError) {
      discordChannel.onError(new Error(`Discord channel exited with status ${discordExit}`))
    }
  }

  return {
    agentMessages,
    sessionId,
    exitCode: runResult.exitCode,
    forcedTermination: runResult.forcedTermination,
  }
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
