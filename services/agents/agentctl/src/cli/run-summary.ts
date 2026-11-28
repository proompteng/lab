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
    input: tokenCount(usage?.inputTokens),
    cached: tokenCount(usage?.cachedInputTokens),
    output: tokenCount(usage?.outputTokens),
    reasoning: tokenCount(usage?.reasoningOutputTokens),
  }
  return Object.values(counts).some((count) => count !== null) ? counts : null
}

const runnerStatus = (value: unknown) => {
  const record = asRecord(value)
  return typeof record?.status === 'string' && isTerminalPhase(record.status) ? record : null
}

type Message = { chunks: string[]; truncated: boolean }

export const parseRunLogs = (logs: string, status?: unknown, knownToken?: string) => {
  let terminal = runnerStatus(status)
  let telemetry: Record<string, unknown> | null = null
  let usage: ReturnType<typeof readUsage> = null
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

  // These are the agent-runner telemetry events, not app-server RPC messages or raw command output.
  for (const line of logs.split('\n')) {
    const event = asRecord(jsonRecord(line)?.event)
    switch (event?.type) {
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
      case 'message':
        if (typeof event.delta !== 'string' || !event.delta) break
        if (!current) {
          current = { chunks: [], truncated: false }
          messages.push(current)
        }
        current.chunks.push(event.delta)
        current.truncated ||= event.truncated === true
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
      default:
        continue
    }
    events++
  }

  const candidates = messages.map(({ chunks, truncated }) => ({ text: chunks.join(''), truncated }))
  for (const { text } of candidates) scanPrUrls(text)
  for (const chunks of output.values()) scanPrUrls(chunks.join(''))

  const preview = asRecord(terminal?.result)
  const previewText = typeof preview?.text === 'string' && preview.text.trim() ? preview.text : null
  let message = candidates.at(-1)?.text ?? null
  let complete = false
  if (previewText) {
    scanPrUrls(previewText)
    message = previewText
    complete = preview?.truncated === false
    if (!complete) {
      // Existing pods do not include message IDs in deltas. Use the authoritative final preview
      // to choose its streamed text, not the commentary that can precede a tool call.
      const matches = candidates.filter(({ text }) => text.startsWith(previewText))
      if (matches.length === 1) {
        message = matches[0].text
        complete = !matches[0].truncated && message.length > previewText.length
      }
    }
  }

  const finalTelemetry = asRecord(terminal?.telemetry)
  return {
    events,
    startedAt: asString(terminal?.startedAt) ?? asString(telemetry?.startedAt),
    finishedAt: asString(terminal?.finishedAt),
    model: asString(terminal?.model) ?? asString(finalTelemetry?.model) ?? asString(telemetry?.model),
    effort: asString(terminal?.effort) ?? asString(finalTelemetry?.effort) ?? asString(telemetry?.effort),
    usage: readUsage(finalTelemetry?.usage) ?? usage,
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
) => {
  const { run, name, phase, observedPhase, node, head } = observation
  const parsed = parseRunLogs(logs, status, knownToken)
  const startedAt = Date.parse(run.status?.startedAt ?? parsed.startedAt ?? '')
  const finishedAt = Date.parse(run.status?.finishedAt ?? parsed.finishedAt ?? '')
  const end = Number.isFinite(finishedAt)
    ? finishedAt
    : isTerminalPhase(phase) || isTerminalPhase(observedPhase)
      ? NaN
      : Date.now()
  const safe = (value: string | null | undefined) =>
    value ? redactRunText(value, knownToken).replace(/\s+/g, ' ').trim() || null : null
  return {
    name: safe(name),
    phase: safe(phase),
    observedPhase: safe(observedPhase),
    node: safe(node),
    durationMs: end >= startedAt ? end - startedAt : null,
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
          (isTerminalPhase(observation.phase) ? readNestedValue(observation.resource, ['status', 'runner']) : null)
        const summary = summarize(observation, logStatus, logs, status, token)
        if (json || ['json', 'yaml', 'yaml-stream'].includes(output)) {
          outputResource(summary, json ? 'json' : output)
          return
        }
        const counts = summary.usage
        const phase = summary.phase ?? '-'
        console.log(
          [
            `AgentRun: ${summary.name ?? '-'}`,
            `Phase:    ${phase}${summary.observedPhase && summary.observedPhase !== phase ? ` (workload: ${summary.observedPhase})` : ''}`,
            `Node:     ${summary.node ?? '-'}`,
            `Duration: ${summary.durationMs === null ? '-' : `${(summary.durationMs / 1000).toFixed(1)}s`}`,
            `Model:    ${summary.model ?? '-'} (effort: ${summary.effort ?? '-'})`,
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
