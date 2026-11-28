import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureFileDirectory } from '../../scripts/codex/lib/fs'
import { AGENT_RUNNER_RESULT_PREVIEW_CHARS, type AgentRunnerResultPreview } from '../runner-result'
import { encodeRunnerStatus } from '../runner-status'
import { RUNNER_LOG_SUFFIX, type RunnerTelemetry } from '../runner-telemetry'
import { SHARED_WORKSPACE_CACHE_MOUNT_PATH } from '../workspace-cache'

import { uploadOutputArtifacts } from './artifact-upload'
import {
  ensureGitAskpass,
  prepareRunnerWorkspace,
  readRunnerSystemPrompt,
  readRunnerWorkspaceTmpfsBytes,
  runDefaultCommand,
  type CommandRunner,
  type ReportStartupPhase,
} from './codex-app-server'
import { RUNNER_PROCESS_TERM_GRACE_MS } from './process-command'
import { createRemoteFlushDeadline, waitWithSignal } from './shutdown'
import {
  asNumber,
  asString,
  buildTemplateContext,
  isRecord,
  renderOutputArtifacts,
  type AgentProviderOutputArtifact,
  type AgentRunnerSpec,
  type AgyCliAdapterConfig,
} from './spec'
import { createRunnerTelemetry, createTelemetryPublisher } from './telemetry'

export const DEFAULT_AGY_BINARY_PATH = '/usr/local/bin/agy'
export const DEFAULT_AGY_CREDENTIALS_ENV_VAR = 'GOOGLE_APPLICATION_CREDENTIALS_JSON'

const MAX_RESULT_RESPONSE_CHARS = 64_000
const MAX_STDERR_CHARS = 8_192

type AgentRunPayload = Record<string, unknown>

export type AgyCliRunnerStatus = {
  provider: string
  adapter: 'agy-cli'
  binary: string
  exitCode: number
  signal?: string | null
  status: 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string
  threadId?: string
  model?: string
  effort?: string
  cwd?: string | null
  artifacts: {
    statusPath?: string
    logPath?: string
    outputArtifacts?: AgentProviderOutputArtifact[]
  }
  error?: string
  result?: AgentRunnerResultPreview
  telemetry?: RunnerTelemetry
}

export type RunAgyCliAdapterOptions = {
  runCommand?: CommandRunner
  sharedCachePath?: string
  uploadArtifacts?: typeof uploadOutputArtifacts
  now?: () => Date
  abortSignal?: AbortSignal
  publishTelemetry?: (snapshot: RunnerTelemetry, signal?: AbortSignal) => Promise<void>
  env?: NodeJS.ProcessEnv
  sigkillGraceMs?: number
}

type StagedCredentials = {
  path: string
  projectId: string | null
  cleanup: () => Promise<void>
}

type AgyStreamResult = {
  conversationId?: string
  status?: string
  response?: string
  error?: string
  usage?: Record<string, unknown>
}

const nonEmptyString = (value: unknown): string | null => {
  const text = asString(value)?.trim()
  return text ? text : null
}

const nonBlankStringPreserve = (value: unknown): string | null => {
  const text = asString(value)
  return text && text.trim() ? text : null
}

const timestampUtc = (now: () => Date): string =>
  now()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const resolveAgyBinaryPath = (
  adapter: AgyCliAdapterConfig,
  env: Record<string, string | undefined> = process.env,
): string =>
  nonEmptyString(adapter.binaryPath) ??
  nonEmptyString(env.AGENTS_AGY_BINARY) ??
  nonEmptyString(env.AGY_BINARY) ??
  DEFAULT_AGY_BINARY_PATH

const loadRunPayload = async (spec: AgentRunnerSpec): Promise<AgentRunPayload> => {
  const payloadPath = asString(spec.payloads?.eventFilePath)
  if (!payloadPath) {
    throw new Error('agent-runner payloads.eventFilePath is required')
  }
  const raw = await readFile(payloadPath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object in ${payloadPath}`)
  }
  return parsed
}

const resolvePrompt = (adapter: AgyCliAdapterConfig, runPayload: AgentRunPayload): string => {
  const adapterPrompt = nonBlankStringPreserve(adapter.prompt)
  if (adapterPrompt) return adapterPrompt
  const impl = isRecord(runPayload.implementation) ? runPayload.implementation : {}
  const event = isRecord(runPayload.event) ? runPayload.event : {}
  const candidates = [runPayload.prompt, impl.text, impl.summary, runPayload.issueBody, event.body]
  for (const candidate of candidates) {
    const text = nonBlankStringPreserve(candidate)
    if (text) return text
  }
  throw new Error('agy-cli adapter requires a prompt in adapter.agy.prompt or run.json')
}

export const composeAgyPrompt = (prompt: string, systemPrompt: string | null): string => {
  if (!systemPrompt) return prompt
  return `<system_instructions>\n${systemPrompt.trim()}\n</system_instructions>\n\n<task>\n${prompt}\n</task>`
}

export const buildAgyArgs = (adapter: AgyCliAdapterConfig): string[] => {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json']
  const model = nonEmptyString(adapter.model)
  if (model) args.push('--model', model)
  const effort = nonEmptyString(adapter.effort)
  if (effort) args.push('--effort', effort)
  const agent = nonEmptyString(adapter.agent)
  if (agent) args.push('--agent', agent)
  const mode = nonEmptyString(adapter.mode)
  if (mode) args.push('--mode', mode)
  const printTimeout = nonEmptyString(adapter.printTimeout)
  if (printTimeout) args.push('--print-timeout', printTimeout)
  if (adapter.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions')
  }
  if (adapter.disableSlashCommands === true) {
    args.push('--disable-slash-commands')
  }
  if (adapter.settings !== undefined) {
    const serialized = typeof adapter.settings === 'string' ? adapter.settings : JSON.stringify(adapter.settings)
    if (serialized.trim()) {
      args.push('--settings', serialized)
    }
  }
  return args
}

export const stageAgyCredentials = async (
  adapter: AgyCliAdapterConfig,
  env: Record<string, string | undefined>,
): Promise<StagedCredentials | null> => {
  const existingPath = nonEmptyString(env.GOOGLE_APPLICATION_CREDENTIALS)
  if (existingPath && existsSync(existingPath)) {
    return null
  }

  const credentialsEnvVar = nonEmptyString(adapter.credentialsEnvVar) ?? DEFAULT_AGY_CREDENTIALS_ENV_VAR
  const rawJson = nonEmptyString(env[credentialsEnvVar])
  if (!rawJson) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error(`${credentialsEnvVar} does not contain valid JSON`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${credentialsEnvVar} must contain a JSON object`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'agents-agy-adc-'))
  const filePath = join(dir, 'credentials.json')
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
  await chmod(filePath, 0o600)

  return {
    path: filePath,
    projectId: nonEmptyString(parsed.quota_project_id) ?? nonEmptyString(parsed.project_id),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const mapAgyToolKind = (
  toolName: string,
): 'commandExecution' | 'mcpToolCall' | 'fileChange' | 'webSearch' | 'dynamicToolCall' => {
  if (toolName === 'run_command' || toolName === 'bash') return 'commandExecution'
  if (
    toolName === 'write_file' ||
    toolName === 'write_to_file' ||
    toolName === 'edit_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'multi_replace_file_content'
  ) {
    return 'fileChange'
  }
  if (toolName === 'search_web' || toolName === 'read_url_content') return 'webSearch'
  if (toolName === 'call_mcp_tool' || toolName.startsWith('mcp_')) return 'mcpToolCall'
  return 'dynamicToolCall'
}

const mapAgyUsage = (rawUsage: unknown) => {
  if (!isRecord(rawUsage)) return null
  const inputTokens = asNumber(rawUsage.input_tokens)
  const outputTokens = asNumber(rawUsage.output_tokens)
  const totalTokens = asNumber(rawUsage.total_tokens)
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null
  const cachedInputTokens = asNumber(rawUsage.cache_read_tokens) ?? 0
  const reasoningOutputTokens = asNumber(rawUsage.thinking_tokens) ?? 0
  return {
    inputTokens: Math.max(0, Math.trunc(inputTokens)),
    cachedInputTokens: Math.max(0, Math.trunc(cachedInputTokens)),
    cacheWriteInputTokens: 0,
    outputTokens: Math.max(0, Math.trunc(outputTokens)),
    reasoningOutputTokens: Math.max(0, Math.trunc(reasoningOutputTokens)),
    totalTokens: Math.max(0, Math.trunc(totalTokens)),
  }
}

const writeStatus = async (statusPath: string | undefined, status: AgyCliRunnerStatus) => {
  if (!statusPath) return
  await ensureFileDirectory(statusPath)
  const encoded = encodeRunnerStatus(status)
  if (encoded.logLine) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(encoded.logLine, (error) => (error ? reject(error) : resolve()))
    })
  }
  await writeFile(statusPath, encoded.message, 'utf8')
}

export const runAgyCliAdapter = async (
  spec: AgentRunnerSpec,
  adapter: AgyCliAdapterConfig,
  options: RunAgyCliAdapterOptions = {},
): Promise<number> => {
  const startupStarted = performance.now()
  const now = options.now ?? (() => new Date())
  const startedAt = timestampUtc(now)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath
  const baseEnv: Record<string, string | undefined> = { ...(options.env ?? process.env) }
  const binary = resolveAgyBinaryPath(adapter, baseEnv)

  let exitCode = 1
  let exitSignal: string | null = null
  let errorMessage: string | undefined
  let caughtError: unknown
  let conversationId: string | undefined
  let responseText = ''
  let responseTruncated = false
  let outputArtifacts = renderOutputArtifacts(spec.providerSpec?.outputArtifacts, buildTemplateContext(spec))
  let logStream: ReturnType<typeof createWriteStream> | null = null
  let telemetry: ReturnType<typeof createRunnerTelemetry> | null = null
  let stagedCreds: StagedCredentials | null = null
  const remoteFlush = createRemoteFlushDeadline(options.abortSignal)

  try {
    if (logPath) {
      await ensureFileDirectory(logPath)
      logStream = createWriteStream(logPath, { flags: 'a' })
    }
    const publishTelemetry = options.publishTelemetry ?? createTelemetryPublisher(baseEnv)
    const write = (line: string) => {
      logStream?.write(line)
      process.stdout.write(line)
    }
    const reportStartupPhase: ReportStartupPhase = (phase, started, outcome = 'ok') => {
      const finished = performance.now()
      write(
        `${JSON.stringify({
          ts: now().toISOString(),
          component: 'agent-runner',
          event: {
            type: 'startup_phase',
            phase,
            outcome,
            durationMs: Math.round(finished - started),
            elapsedMs: Math.round(finished - startupStarted),
          },
        })}\n`,
      )
    }

    telemetry = createRunnerTelemetry({
      model: adapter.model,
      effort: adapter.effort,
      now,
      podName: baseEnv.AGENT_RUN_POD_NAME,
      signal: options.abortSignal,
      publish: async (snapshot, signal) => {
        const workspaceTmpfsUsedBytes = await readRunnerWorkspaceTmpfsBytes()
        signal?.throwIfAborted()
        if (workspaceTmpfsUsedBytes !== undefined) {
          write(
            `${JSON.stringify({
              ts: snapshot.heartbeatAt,
              component: 'agent-runner',
              event: { type: 'workspace_usage', workspaceTmpfsUsedBytes },
            })}\n`,
          )
        }
        await publishTelemetry?.(snapshot, signal)
      },
      write,
    })
    void telemetry.start()

    if (options.abortSignal?.aborted) {
      exitCode = 130
      throw new Error('agent runner cancelled before start')
    }

    const runPayload = await loadRunPayload(spec)
    outputArtifacts = renderOutputArtifacts(spec.providerSpec?.outputArtifacts, {
      ...runPayload,
      ...buildTemplateContext(spec),
      run: runPayload,
    })

    const rawPrompt = resolvePrompt(adapter, runPayload)
    const systemPrompt = await readRunnerSystemPrompt(adapter, spec, runPayload, options.abortSignal)
    const effectivePrompt = composeAgyPrompt(rawPrompt, systemPrompt)

    const runCommand = options.runCommand ?? runDefaultCommand
    await prepareRunnerWorkspace(
      { cwd: adapter.cwd },
      runPayload,
      (command, args, commandOptions) => runCommand(command, args, { ...commandOptions, signal: options.abortSignal }),
      options.sharedCachePath ?? SHARED_WORKSPACE_CACHE_MOUNT_PATH,
      reportStartupPhase,
    )

    const effectiveEnv: Record<string, string | undefined> = options.env ? { ...options.env } : { ...process.env }
    stagedCreds = await stageAgyCredentials(adapter, effectiveEnv)
    const childEnv: Record<string, string> = {}
    const credentialsEnvVar = nonEmptyString(adapter.credentialsEnvVar) ?? DEFAULT_AGY_CREDENTIALS_ENV_VAR
    for (const [key, value] of Object.entries(effectiveEnv)) {
      if (value !== undefined && key !== credentialsEnvVar) {
        childEnv[key] = value
      }
    }
    await ensureGitAskpass(childEnv)
    if (stagedCreds) {
      childEnv.GOOGLE_APPLICATION_CREDENTIALS = stagedCreds.path
    }
    if (adapter.adcAuth !== false) {
      childEnv.AGY_ADC_AUTH = 'true'
    }
    const quotaProject =
      nonEmptyString(adapter.quotaProject) ??
      nonEmptyString(childEnv.GOOGLE_CLOUD_QUOTA_PROJECT) ??
      stagedCreds?.projectId
    if (quotaProject) {
      childEnv.GOOGLE_CLOUD_QUOTA_PROJECT = quotaProject
    }
    const location = nonEmptyString(adapter.location) ?? nonEmptyString(childEnv.GOOGLE_CLOUD_LOCATION) ?? 'global'
    childEnv.GOOGLE_CLOUD_LOCATION = location
    childEnv.AGY_CLI_DISABLE_AUTO_UPDATE ??= 'true'

    const homeDir = nonEmptyString(childEnv.HOME) ?? '/root'
    await mkdir(join(homeDir, '.gemini', 'antigravity-cli'), { recursive: true })

    if (options.abortSignal?.aborted) {
      exitCode = 130
      throw new Error('agent runner cancelled before launching agy')
    }

    const args = buildAgyArgs(adapter)
    const turnStarted = performance.now()
    let turnStartedReported = false
    const streamState: { terminalResult: AgyStreamResult | null } = { terminalResult: null }
    let stderrTail = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''
    const startedSteps = new Set<string>()
    const sigkillGraceMs = options.sigkillGraceMs ?? RUNNER_PROCESS_TERM_GRACE_MS

    const appendResponse = (chunk: string) => {
      if (!chunk) return
      const remaining = MAX_RESULT_RESPONSE_CHARS - responseText.length
      if (remaining > 0) {
        responseText += chunk.slice(0, remaining)
      }
      if (chunk.length > remaining) {
        responseTruncated = true
      }
    }

    const observeStreamLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        write(
          `${JSON.stringify({ ts: now().toISOString(), component: 'agy-cli', event: { type: 'stdout', line: trimmed.slice(0, 4096) } })}\n`,
        )
        return
      }
      if (!isRecord(parsed)) return

      const eventType = asString(parsed.event)
      if (eventType === 'init') {
        const initConversationId = nonEmptyString(parsed.conversation_id)
        if (initConversationId) conversationId = initConversationId
        if (!turnStartedReported) {
          turnStartedReported = true
          reportStartupPhase('first_turn_started', turnStarted)
        }
        telemetry?.observe({
          method: 'turn/started',
          params: { threadId: conversationId ?? 'agy-session', turnId: 'turn-1' },
        })
        return
      }

      if (eventType === 'step_update' && isRecord(parsed.step_update)) {
        const step = parsed.step_update
        const stepConversationId = nonEmptyString(step.conversation_id)
        if (stepConversationId && !conversationId) conversationId = stepConversationId
        if (!turnStartedReported) {
          turnStartedReported = true
          reportStartupPhase('first_turn_started', turnStarted)
          telemetry?.observe({
            method: 'turn/started',
            params: { threadId: conversationId ?? 'agy-session', turnId: 'turn-1' },
          })
        }
        const stepType = asString(step.step_type)
        const state = asString(step.state)
        const stepIndex = asNumber(step.step_index) ?? 0
        const stepId = `step-${stepIndex}`

        if (stepType === 'agent_response') {
          const delta = asString(step.text_delta) ?? ''
          if (delta) {
            appendResponse(delta)
            telemetry?.observe({
              method: 'item/agentMessage/delta',
              params: { threadId: conversationId ?? 'agy-session', turnId: 'turn-1', delta },
            })
          }
        } else if (stepType === 'tool') {
          const toolName = nonEmptyString(step.tool_name) ?? 'tool'
          const toolInfo = isRecord(step.tool_info) ? step.tool_info : {}
          const params = isRecord(toolInfo.parameters) ? toolInfo.parameters : {}
          const commandTitle = nonEmptyString(params.CommandLine) ?? nonEmptyString(params.Path) ?? toolName
          const output = asString(toolInfo.output) ?? ''
          const kind = mapAgyToolKind(toolName)
          const durationMs =
            asNumber(step.duration_seconds) !== null
              ? Math.round((asNumber(step.duration_seconds) ?? 0) * 1000)
              : undefined
          if (state === 'ACTIVE' && !startedSteps.has(stepId)) {
            startedSteps.add(stepId)
            telemetry?.observe({
              method: 'item/started',
              params: {
                threadId: conversationId ?? 'agy-session',
                turnId: 'turn-1',
                item: { id: stepId, type: kind, tool: toolName, command: commandTitle },
              },
            })
          } else if (state === 'DONE') {
            if (!startedSteps.has(stepId)) {
              startedSteps.add(stepId)
              telemetry?.observe({
                method: 'item/started',
                params: {
                  threadId: conversationId ?? 'agy-session',
                  turnId: 'turn-1',
                  item: { id: stepId, type: kind, tool: toolName, command: commandTitle },
                },
              })
            }
            telemetry?.observe({
              method: 'item/completed',
              params: {
                threadId: conversationId ?? 'agy-session',
                turnId: 'turn-1',
                item: {
                  id: stepId,
                  type: kind,
                  tool: toolName,
                  command: commandTitle,
                  aggregatedOutput: output,
                  ...(durationMs !== undefined ? { durationMs } : {}),
                },
              },
            })
          }
        }

        const usage = mapAgyUsage(step.usage)
        if (usage) {
          telemetry?.observe({
            method: 'thread/tokenUsage/updated',
            params: { threadId: conversationId ?? 'agy-session', turnId: 'turn-1', tokenUsage: { total: usage } },
          })
        }
        return
      }

      if (eventType === 'result' && isRecord(parsed.result)) {
        const res = parsed.result
        const resConversationId = nonEmptyString(res.conversation_id)
        if (resConversationId) conversationId = resConversationId
        const result: AgyStreamResult = {
          conversationId: resConversationId ?? conversationId,
          status: nonEmptyString(res.status) ?? undefined,
          response: asString(res.response) ?? undefined,
          error: nonEmptyString(res.error) ?? undefined,
          usage: isRecord(res.usage) ? res.usage : undefined,
        }
        streamState.terminalResult = result
        if (!responseText && result.response) {
          appendResponse(result.response)
        }
        const usage = mapAgyUsage(res.usage)
        if (usage) {
          telemetry?.observe({
            method: 'thread/tokenUsage/updated',
            params: { threadId: conversationId ?? 'agy-session', turnId: 'turn-1', tokenUsage: { total: usage } },
          })
        }
        telemetry?.observe({
          method: 'turn/completed',
          params: {
            threadId: conversationId ?? 'agy-session',
            turnId: 'turn-1',
            turn: { status: result.status === 'SUCCESS' ? 'completed' : 'failed' },
          },
        })
      }
    }

    const observeStderrLine = (line: string) => {
      const trimmed = line.trim()
      if (trimmed) {
        write(
          `${JSON.stringify({ ts: now().toISOString(), component: 'agy-cli', event: { type: 'stderr', line: trimmed.slice(0, 4096) } })}\n`,
        )
      }
    }

    const childResult = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: nonEmptyString(adapter.cwd) ?? undefined,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      let killTimer: ReturnType<typeof setTimeout> | undefined
      const isChildRunning = () => child.exitCode === null && child.signalCode === null
      const onAbort = () => {
        if (!isChildRunning()) return
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          if (isChildRunning()) child.kill('SIGKILL')
        }, sigkillGraceMs)
        killTimer.unref()
      }
      options.abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (options.abortSignal?.aborted) {
        onAbort()
      }

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          stderrTail = `${stderrTail}\nstdin write error: ${error.message}`.slice(-MAX_STDERR_CHARS)
        }
      })
      child.stdin?.end(`${JSON.stringify({ event: 'user', message: { content: effectivePrompt } })}\n`, 'utf8')

      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        let newlineIndex = stdoutBuffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex)
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
          observeStreamLine(line)
          newlineIndex = stdoutBuffer.indexOf('\n')
        }
      })

      child.stderr?.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS)
        stderrBuffer += chunk
        let newlineIndex = stderrBuffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = stderrBuffer.slice(0, newlineIndex)
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1)
          observeStderrLine(line)
          newlineIndex = stderrBuffer.indexOf('\n')
        }
      })

      child.on('error', (error) => {
        if (killTimer) clearTimeout(killTimer)
        options.abortSignal?.removeEventListener('abort', onAbort)
        reject(error)
      })

      child.on('close', (code, signal) => {
        if (killTimer) clearTimeout(killTimer)
        options.abortSignal?.removeEventListener('abort', onAbort)
        if (stdoutBuffer.trim()) {
          observeStreamLine(stdoutBuffer)
          stdoutBuffer = ''
        }
        if (stderrBuffer.trim()) {
          observeStderrLine(stderrBuffer)
          stderrBuffer = ''
        }
        resolve({ code: code ?? (signal ? 130 : 1), signal })
      })
    })

    exitCode = childResult.code
    exitSignal = childResult.signal

    const { terminalResult } = streamState
    if (
      options.abortSignal?.aborted ||
      terminalResult?.status === 'CANCELED' ||
      terminalResult?.status === 'INTERRUPTED'
    ) {
      exitCode = 130
      throw new Error(terminalResult?.error ?? `agy-cli cancelled${exitSignal ? ` (${exitSignal})` : ''}`)
    }

    if (exitCode !== 0 || !terminalResult || terminalResult.status !== 'SUCCESS') {
      const detail =
        terminalResult?.error ??
        (terminalResult?.status ? `agy-cli finished with status ${terminalResult.status}` : null) ??
        (exitCode === 0
          ? stderrTail.trim() || 'agy-cli exited without emitting a terminal result event'
          : stderrTail.trim() || `agy-cli exited with code ${exitCode}`)
      exitCode = exitCode === 0 ? 1 : exitCode
      throw new Error(detail)
    }

    if (spec.artifacts?.resultPath) {
      await ensureFileDirectory(spec.artifacts.resultPath)
      await writeFile(
        spec.artifacts.resultPath,
        `${JSON.stringify(
          {
            schemaVersion: 'agents.proompteng.ai/result/v1',
            threadId: conversationId,
            responseText,
            responseTruncated,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
    }

    exitCode = 0
  } catch (error) {
    caughtError = error
    errorMessage = toErrorMessage(error)
    if (options.abortSignal?.aborted && exitCode !== 130) {
      exitCode = 130
    } else if (exitCode === 0) {
      exitCode = 1
    }
    telemetry?.observe({ method: 'error', params: { error: { message: errorMessage } } })
  } finally {
    await stagedCreds?.cleanup().catch(() => undefined)
    const signal = remoteFlush.signal
    const finishArtifacts = async () => {
      const log = logStream
      logStream = null
      if (log) {
        await waitWithSignal(new Promise<void>((resolve) => log.end(resolve)), signal)
      }

      const resultKey = outputArtifacts.find((artifact) => artifact.name === 'runner-result')?.key
      if (resultKey && logPath) {
        outputArtifacts = outputArtifacts.map((artifact) =>
          artifact.name === 'runner-log' ? { ...artifact, key: `${resultKey}${RUNNER_LOG_SUFFIX}` } : artifact,
        )
      }

      const upload = options.uploadArtifacts ?? uploadOutputArtifacts
      const uploadMatching = async (isLog: boolean, uploadSignal: AbortSignal) => {
        const artifacts = outputArtifacts.filter((artifact) => (artifact.name === 'runner-log') === isLog)
        if (artifacts.length === 0) return
        uploadSignal.throwIfAborted()
        const uploaded = await waitWithSignal(upload(artifacts, { signal: uploadSignal }), uploadSignal)
        outputArtifacts = outputArtifacts.map(
          (artifact) => uploaded.find((retained) => retained.name === artifact.name) ?? artifact,
        )
      }
      await uploadMatching(true, signal)
      if (exitCode === 0 && !options.abortSignal?.aborted) {
        await uploadMatching(false, options.abortSignal ?? signal)
      }
    }
    // Queue the terminal heartbeat in the log before closing it, then flush both in parallel.
    const [finalTelemetry] = await Promise.all([
      telemetry?.finish(signal),
      finishArtifacts().catch((artifactError: unknown) => {
        caughtError ??= artifactError
        const detail = toErrorMessage(artifactError)
        errorMessage = errorMessage ? `${errorMessage}; ${detail}` : detail
        if (exitCode !== 130) exitCode = 1
      }),
    ]).finally(remoteFlush.dispose)
    if (options.abortSignal?.aborted) exitCode = 130

    const runnerStatus: AgyCliRunnerStatus = {
      provider: spec.provider,
      adapter: 'agy-cli',
      binary,
      ...(finalTelemetry ? { telemetry: finalTelemetry } : {}),
      exitCode,
      ...(exitSignal ? { signal: exitSignal } : {}),
      status: exitCode === 0 ? 'succeeded' : exitCode === 130 ? 'cancelled' : 'failed',
      startedAt,
      finishedAt: timestampUtc(now),
      ...(conversationId ? { threadId: conversationId } : {}),
      ...(adapter.model ? { model: adapter.model } : {}),
      ...(adapter.effort ? { effort: adapter.effort } : {}),
      ...(adapter.cwd !== undefined ? { cwd: adapter.cwd } : {}),
      ...(responseText
        ? {
            result: {
              text: responseText.slice(0, AGENT_RUNNER_RESULT_PREVIEW_CHARS),
              truncated: responseTruncated || responseText.length > AGENT_RUNNER_RESULT_PREVIEW_CHARS,
            },
          }
        : {}),
      artifacts: {
        statusPath,
        logPath,
        ...(outputArtifacts.length > 0 ? { outputArtifacts } : {}),
      },
      ...(errorMessage ? { error: errorMessage.slice(0, 640) } : {}),
    }

    try {
      await writeStatus(statusPath, runnerStatus)
    } catch (statusError) {
      if (!caughtError) {
        caughtError = statusError
        errorMessage = toErrorMessage(statusError)
        exitCode = 1
      } else {
        process.stderr.write(`failed to write agy-cli runner status: ${toErrorMessage(statusError)}\n`)
      }
    }
  }

  if (caughtError) {
    throw caughtError
  }

  return exitCode
}
