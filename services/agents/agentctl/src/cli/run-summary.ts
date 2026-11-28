import { Argument, Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import { resolveRunHeadBranch } from '../../../src/server/agents-controller/run-utils'
import { asRecord, asString } from '../../../src/server/primitives'
import { isTerminalPhase, readRunObservation, type RunObservation } from '../kube/runs'
import { outputResource, readNestedValue } from '../runtime'
import { TransportService } from '../transport'
import { AgentctlContext } from './context'
import { validationError } from './errors'
import { kubeCall, runnerContainer } from './run-observation'
import { kubeStatusSuffix, redactRunText } from './run-redaction'

const jsonRecord = (line: string) => {
  if (!line.trimStart().startsWith('{')) return null
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

const tokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const readUsage = (value: unknown) => {
  const usage = asRecord(value)
  const counts = {
    input: tokenCount(usage?.inputTokens) ?? tokenCount(usage?.input_tokens),
    cached: tokenCount(usage?.cachedInputTokens) ?? tokenCount(usage?.cache_read_tokens),
    output: tokenCount(usage?.outputTokens) ?? tokenCount(usage?.output_tokens),
    reasoning: tokenCount(usage?.reasoningOutputTokens) ?? tokenCount(usage?.thinking_tokens),
  }
  return Object.values(counts).some((count) => count !== null) ? counts : null
}

const durationMsFromRecord = (record: Record<string, unknown> | null) => {
  if (!record) return null
  const ms = record.durationMs
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.round(ms)
  const seconds = record.duration_seconds ?? record.durationSeconds
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  return null
}

const isRunnerTerminalStatus = (value: unknown) =>
  typeof value === 'string' &&
  (isTerminalPhase(value) || ['success', 'error', 'interrupted'].includes(value.toLowerCase()))

const runnerStatus = (value: unknown) => {
  const record = asRecord(value)
  return isRunnerTerminalStatus(record?.status) ? record : null
}

const runnerResultFile = (value: unknown) => {
  const record = asRecord(value)
  if (!record || typeof record.responseText !== 'string') return null
  return {
    text: record.responseText,
    truncated: record.responseTruncated === true,
  }
}

type Message = { chunks: string[]; truncated: boolean }

export const parseRunLogs = (logs: string, status?: unknown, knownToken?: string, resultFile?: unknown) => {
  let terminal = runnerStatus(status)
  let parsedResultFile = runnerResultFile(resultFile) ?? runnerResultFile(status)
  let telemetry: Record<string, unknown> | null = null
  let usage: ReturnType<typeof readUsage> = null
  let agyModel: string | null = null
  let agyEffort: string | null = null
  let agyStartedAt: string | null = null
  let agyFinishedAt: string | null = null
  let agyDurationMs: number | null = null
  let agyResult: { text: string; truncated: boolean } | null = null
  let messages: Message[] = []
  let current: Message | undefined
  let events = 0
  const output = new Map<string, string[]>()
  const prUrls = new Map<string, string>()
  const scanPrUrls = (text: string) => {
    for (const [url] of text.matchAll(/\bhttps:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?![\w%-])/gi)) {
      const key = url.toLowerCase()
      if (!prUrls.has(key) && redactRunText(url, knownToken) === url) prUrls.set(key, url)
    }
  }

  const pushMessage = (delta: string, truncated = false) => {
    if (!delta) return
    if (!current) {
      current = { chunks: [], truncated: false }
      messages.push(current)
    }
    current.chunks.push(delta)
    current.truncated ||= truncated
  }

  // Parse agent-runner telemetry events (codex-app-server and agy-cli), raw agy-cli stream-json events,
  // and inline status.json / result.json records without leaking raw tool or error payloads.
  for (const line of logs.split('\n')) {
    const record = jsonRecord(line)
    if (!record) continue
    const event = asRecord(record.event)
    if (event) {
      switch (event.type) {
        case 'heartbeat':
          telemetry = asRecord(event.telemetry) ?? telemetry
          usage = readUsage(telemetry?.usage) ?? usage
          break
        case 'usage':
          // Both events carry cumulative totals. Summing them counts the same tokens many times.
          usage = readUsage(event.usage) ?? usage
          break
        case 'runner_terminal_status':
          terminal = runnerStatus(event.status) ?? terminal
          break
        case 'turn_started':
          for (const message of messages) scanPrUrls(message.chunks.join(''))
          messages = []
          current = undefined
          break
        case 'turn_completed':
          break
        case 'message':
          if (typeof event.delta !== 'string' || !event.delta) break
          pushMessage(event.delta, event.truncated === true)
          break
        case 'tool':
          if (event.status === 'started') current = undefined
          if (typeof event.output === 'string') scanPrUrls(event.output)
          break
        case 'output':
          if (typeof event.id === 'string' && typeof event.delta === 'string') {
            const chunks = output.get(event.id) ?? []
            chunks.push(event.delta)
            output.set(event.id, chunks)
          }
          break
        case 'stdout':
          if (typeof event.line === 'string') scanPrUrls(event.line)
          break
        default:
          continue
      }
      events++
      continue
    }

    if (typeof record.event === 'string') {
      if (record.event === 'init') {
        const init = asRecord(record.init)
        agyModel = asString(init?.model) ?? asString(record.model) ?? agyModel
        agyEffort = asString(init?.effort) ?? asString(record.effort) ?? agyEffort
        agyStartedAt ??= asString(record.ts) ?? asString(record.timestamp)
        events++
        continue
      }
      if (record.event === 'step_update') {
        const step = asRecord(record.step_update)
        if (!step) continue
        const stepType = asString(step.step_type)
        const state = asString(step.state)?.toUpperCase()
        if (stepType === 'agent_response') {
          const delta =
            typeof step.text_delta === 'string' && step.text_delta
              ? step.text_delta
              : typeof step.text === 'string' && step.text
                ? step.text
                : ''
          pushMessage(delta)
        } else if (stepType === 'tool') {
          if (state === 'ACTIVE' || state === 'RUNNING' || state === 'STARTED') current = undefined
          const toolInfo = asRecord(step.tool_info)
          if (typeof toolInfo?.output === 'string') scanPrUrls(toolInfo.output)
        }
        usage = readUsage(step.usage) ?? usage
        events++
        continue
      }
      if (record.event === 'result') {
        const res = asRecord(record.result)
        if (!res) continue
        agyModel = asString(res.model) ?? agyModel
        agyEffort = asString(res.effort) ?? agyEffort
        usage = readUsage(res.usage) ?? usage
        agyDurationMs = durationMsFromRecord(res) ?? agyDurationMs
        agyFinishedAt = asString(record.ts) ?? asString(record.timestamp) ?? agyFinishedAt
        const response = typeof res.response === 'string' && res.response.trim() ? res.response : null
        if (response) {
          agyResult = { text: response, truncated: false }
          scanPrUrls(response)
        }
        events++
        continue
      }
      continue
    }

    const maybeResult = runnerResultFile(record)
    if (maybeResult) {
      parsedResultFile = maybeResult
      events++
      continue
    }
    if (
      record.adapter !== undefined ||
      record.provider !== undefined ||
      record.result !== undefined ||
      record.telemetry !== undefined ||
      record.startedAt !== undefined ||
      record.finishedAt !== undefined
    ) {
      const maybeStatus = runnerStatus(record)
      if (maybeStatus) {
        terminal = maybeStatus
        events++
      }
    }
  }

  const candidates = messages.map(({ chunks, truncated }) => ({ text: chunks.join(''), truncated }))
  for (const { text } of candidates) scanPrUrls(text)
  for (const chunks of output.values()) scanPrUrls(chunks.join(''))

  const preview = asRecord(terminal?.result)
  const previewText = typeof preview?.text === 'string' && preview.text.trim() ? preview.text : null
  const resultText = parsedResultFile?.text.trim() ? parsedResultFile.text : null
  if (resultText) scanPrUrls(resultText)

  let message = candidates.at(-1)?.text ?? null
  let complete = false
  if (resultText && (!previewText || !parsedResultFile?.truncated || resultText.length > previewText.length)) {
    message = resultText
    complete = parsedResultFile?.truncated === false
  } else if (previewText) {
    scanPrUrls(previewText)
    message = previewText
    complete = preview?.truncated === false
    if (!complete) {
      if (agyResult && !agyResult.truncated) {
        message = agyResult.text
        complete = true
      } else {
        const isAgyRun =
          asString(terminal?.adapter) === 'agy-cli' ||
          asString(terminal?.provider) === 'google' ||
          agyModel !== null ||
          agyResult !== null
        if (isAgyRun && candidates.length > 1) {
          // agy-cli accumulates agent_response deltas across tool calls into status.result.text.
          const joined = candidates.map(({ text }) => text).join('')
          const start = joined.indexOf(previewText)
          if (start !== -1 && start === joined.lastIndexOf(previewText)) {
            message = joined.slice(start)
            complete = !candidates.some(({ truncated }) => truncated) && message.length > previewText.length
          }
        }
        if (!complete) {
          // Deltas lack message IDs, so commentary and the final answer can share a candidate.
          // Recover the suffix only when the authoritative preview identifies a unique starting point.
          const matches = candidates.flatMap(({ text, truncated }) => {
            const start = text.indexOf(previewText)
            return start === -1 ? [] : [{ text, start, truncated }]
          })
          if (matches.length === 1) {
            const { text, start, truncated } = matches[0]
            if (start === text.lastIndexOf(previewText)) {
              message = text.slice(start)
              complete = !truncated && message.length > previewText.length
            }
          } else if (!isAgyRun && matches.length === 0 && candidates.length > 1) {
            const joined = candidates.map(({ text }) => text).join('')
            const start = joined.indexOf(previewText)
            if (start !== -1 && start === joined.lastIndexOf(previewText)) {
              message = joined.slice(start)
              complete = !candidates.some(({ truncated }) => truncated) && message.length > previewText.length
            }
          }
        }
        if (!complete && agyResult && agyResult.text.length > message.length) {
          message = agyResult.text
          complete = false
        }
      }
    }
  } else if (agyResult) {
    message = agyResult.text
    complete = !agyResult.truncated
  }

  const finalTelemetry = asRecord(terminal?.telemetry)
  const finishedTelemetryAt =
    asString(finalTelemetry?.state) === 'finished'
      ? asString(finalTelemetry?.heartbeatAt)
      : asString(telemetry?.state) === 'finished'
        ? asString(telemetry?.heartbeatAt)
        : null
  return {
    events,
    startedAt:
      asString(terminal?.startedAt) ??
      asString(finalTelemetry?.startedAt) ??
      asString(telemetry?.startedAt) ??
      agyStartedAt,
    finishedAt: asString(terminal?.finishedAt) ?? finishedTelemetryAt ?? agyFinishedAt,
    durationMs: durationMsFromRecord(terminal) ?? agyDurationMs,
    model: asString(terminal?.model) ?? asString(finalTelemetry?.model) ?? asString(telemetry?.model) ?? agyModel,
    effort: asString(terminal?.effort) ?? asString(finalTelemetry?.effort) ?? asString(telemetry?.effort) ?? agyEffort,
    usage: readUsage(finalTelemetry?.usage) ?? readUsage(terminal?.usage) ?? usage,
    prUrls: [...prUrls.values()],
    assistantMessage: message ? redactRunText(message, knownToken).trim() || null : null,
    assistantMessageComplete: complete,
  }
}

type LogStatus = 'available' | 'no-runner-pod' | 'runner-not-started' | 'no-structured-events'

const summarize = (
  observation: RunObservation,
  logStatus: LogStatus,
  logs: string,
  status: unknown,
  knownToken?: string,
  containerState?: { running?: { startedAt?: string }; terminated?: { startedAt?: string; finishedAt?: string } },
) => {
  const { run, name, agent, phase, observedPhase, node, head } = observation
  const parsed = parseRunLogs(logs, status, knownToken)
  const startedAt = Date.parse(
    run.status?.startedAt ??
      parsed.startedAt ??
      containerState?.terminated?.startedAt ??
      containerState?.running?.startedAt ??
      '',
  )
  const finishedAt = Date.parse(
    run.status?.finishedAt ?? parsed.finishedAt ?? containerState?.terminated?.finishedAt ?? '',
  )
  const end = Number.isFinite(finishedAt)
    ? finishedAt
    : isTerminalPhase(phase) || isTerminalPhase(observedPhase)
      ? NaN
      : Date.now()
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(end) && end >= startedAt ? end - startedAt : parsed.durationMs
  const safe = (value: string | null | undefined) =>
    value ? redactRunText(value, knownToken).replace(/\s+/g, ' ').trim() || null : null
  return {
    name: safe(name),
    agent: safe(agent),
    phase: safe(phase),
    observedPhase: safe(observedPhase),
    node: safe(node),
    durationMs,
    model: safe(parsed.model),
    effort: safe(parsed.effort),
    usage: parsed.usage,
    prUrls: parsed.prUrls,
    base: safe(asString(run.status?.vcs?.baseBranch) ?? run.spec?.parameters?.base),
    head: safe(asString(head) ?? resolveRunHeadBranch(observation.resource)),
    logStatus: logStatus === 'available' && !parsed.events ? 'no-structured-events' : logStatus,
    assistantMessage: parsed.assistantMessage,
    assistantMessageComplete: parsed.assistantMessageComplete,
  }
}

export const makeRunSummaryCommand = () =>
  Command.make(
    'summary',
    {
      name: Argument.String('name').pipe(Argument.withDescription('AgentRun name in the selected namespace.')),
      json: Flag.Boolean('json').pipe(Flag.withDefault(false), Flag.withDescription('Print the summary as JSON.')),
    },
    ({ name, json }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        if (transport.mode !== 'kube')
          return yield* Effect.fail(validationError('run summary requires Kubernetes mode.'))
        const { namespace, token, output } = resolved
        const { backend } = transport
        const observation = yield* kubeCall((signal) => readRunObservation(backend, namespace, name, signal)).pipe(
          Effect.mapError((error) => ({
            _tag: 'KubeError' as const,
            message:
              error.message === 'Invalid AgentRun name'
                ? error.message
                : `Could not read AgentRun or its workloads${kubeStatusSuffix(error.message)}; check the name, namespace, and access.`,
          })),
        )
        const pod = observation.pod
        const container = runnerContainer(pod?.spec)
        const state = pod?.status?.containerStatuses?.find(({ name }) => name === container?.name)?.state
        const logStatus = !pod || !container ? 'no-runner-pod' : state?.waiting ? 'runner-not-started' : 'available'
        const logs =
          logStatus === 'available' && pod && container
            ? yield* kubeCall((signal) =>
                backend.readPodLogs(namespace, pod.metadata.name, container.name, signal),
              ).pipe(
                Effect.mapError((error) => ({
                  _tag: 'KubeError' as const,
                  message: redactRunText(
                    `Could not read runner logs for AgentRun ${name}${kubeStatusSuffix(error.message)}; see agentctl describe run ${name}.`,
                    token,
                  ),
                })),
              )
            : ''
        const podStatus = state?.terminated?.message ? jsonRecord(state.terminated.message) : null
        const status =
          runnerStatus(podStatus) ??
          (runnerResultFile(podStatus) ? podStatus : null) ??
          runnerStatus(readNestedValue(observation.resource, ['status', 'runner'])) ??
          (isTerminalPhase(observation.phase) ? readNestedValue(observation.resource, ['status', 'runner']) : null)
        const summary = summarize(observation, logStatus, logs, status, token, state)
        if (json || ['json', 'yaml', 'yaml-stream'].includes(output)) {
          outputResource(summary, json ? 'json' : output)
          return
        }
        const counts = summary.usage
        const phase = summary.phase ?? '-'
        console.log(
          [
            `AgentRun: ${summary.name ?? '-'}`,
            `Agent:    ${summary.agent ?? '-'}`,
            `Phase:    ${phase}${summary.observedPhase && summary.observedPhase !== phase ? ` (workload: ${summary.observedPhase})` : ''}`,
            `Node:     ${summary.node ?? '-'}`,
            `Duration: ${summary.durationMs === null ? '-' : `${(summary.durationMs / 1000).toFixed(1)}s`}`,
            `Model:    ${summary.model ?? '-'}${summary.effort ? ` (effort: ${summary.effort})` : ''}`,
            `Tokens:   ${counts ? `input ${counts.input ?? '-'}, cached ${counts.cached ?? '-'}, output ${counts.output ?? '-'}, reasoning ${counts.reasoning ?? '-'}` : '-'}`,
            `Base:     ${summary.base ?? '-'}`,
            `Head:     ${summary.head ?? '-'}`,
            `PRs:      ${summary.prUrls.join(', ') || '-'}`,
            ...(summary.logStatus === 'available' ? [] : [`Logs:     ${summary.logStatus}`]),
            '',
            summary.assistantMessage
              ? `Assistant message${summary.assistantMessageComplete ? '' : ' (partial or unconfirmed)'}:\n${summary.assistantMessage}`
              : 'No assistant message available.',
          ].join('\n'),
        )
      }),
  ).pipe(
    Command.withDescription(
      'Summarize the current runner Pod’s structured events and final assistant message (kube only).',
    ),
  )
