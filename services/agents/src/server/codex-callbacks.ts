import { createHash } from 'node:crypto'

import { Data, Effect, Layer } from 'effect'

import {
  AgentMessagesApiLive,
  AgentMessagesPublisher,
  AgentMessagesStoreFactory,
  describeAgentMessagesIngestError,
  ingestAgentMessagesEffect,
} from './agent-messages-api'
import type { AgentMessageInput, AgentMessageRecord } from './agent-messages-store'
import { errorResponse, okResponse, parseJsonBody } from './http'
import { asRecord, asString } from './primitives'

export type CodexCallbackKind = 'notify' | 'run-complete'

export class CodexCallbackInvalidPayloadError extends Data.TaggedError('CodexCallbackInvalidPayloadError')<{
  readonly message: string
}> {}

export type CodexCallbackIngestResult = {
  callback: {
    kind: CodexCallbackKind
    agentRunName: string | null
    agentRunNamespace: string | null
    agentRunUid: string | null
    runId: string | null
    stage: string | null
  }
  inserted: AgentMessageRecord[]
  skipped: boolean
}

export type CodexCallbackApiLayer = Layer.Layer<AgentMessagesStoreFactory | AgentMessagesPublisher, never, never>

const MAX_CONTENT_LENGTH = 16_000

const parseJsonRecord = (value: string) => {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

const readCallbackData = (payload: Record<string, unknown>) => {
  const raw = payload.data
  if (typeof raw === 'string') return parseJsonRecord(raw) ?? {}
  return asRecord(raw) ?? payload
}

const readRecordField = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value === 'string') return parseJsonRecord(value) ?? {}
  return asRecord(value) ?? {}
}

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const stringValue = asString(value)?.trim()
    if (stringValue) return stringValue
  }
  return null
}

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

const truncateContent = (value: string) =>
  value.length > MAX_CONTENT_LENGTH ? `${value.slice(0, MAX_CONTENT_LENGTH)}\n[truncated]` : value

const stableHash = (value: unknown) => {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = String(value)
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 24)
}

const readArtifacts = (data: Record<string, unknown>) => {
  const artifacts = data.artifacts
  if (Array.isArray(artifacts)) return artifacts
  if (typeof artifacts === 'string') {
    try {
      const parsed = JSON.parse(artifacts) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

const buildContent = (kind: CodexCallbackKind, data: Record<string, unknown>, status: Record<string, unknown>) => {
  const explicit = firstString(
    data.last_assistant_message,
    data.lastAssistantMessage,
    data.message,
    data.summary,
    data.review_status,
    data.reviewStatus,
  )
  if (explicit) return truncateContent(explicit)

  if (kind === 'run-complete') {
    const phase = firstString(data.phase, status.phase)
    return phase ? `Codex run completed with phase ${phase}` : 'Codex run completed'
  }

  return 'Codex callback notification received'
}

export const buildCodexCallbackMessage = (
  kind: CodexCallbackKind,
  payload: Record<string, unknown>,
): { message: AgentMessageInput; callback: CodexCallbackIngestResult['callback'] } => {
  const data = readCallbackData(payload)
  const metadata = readRecordField(data, 'metadata')
  const status = readRecordField(data, 'status')
  const agentRunName = firstString(data.agentRunName, data.agent_run_name, metadata.name)
  const agentRunNamespace = firstString(data.agentRunNamespace, data.agent_run_namespace, metadata.namespace)
  const agentRunUid = firstString(data.agentRunUid, data.agent_run_uid, metadata.uid)
  const stage = firstString(data.stage, data.agentRunStage, data.agent_run_stage)
  const runId =
    firstString(data.runId, data.run_id, data.agentRunId, data.agent_run_id, agentRunUid, agentRunName) ?? null
  const timestamp =
    firstString(data.timestamp, data.finishedAt, data.finished_at, status.finishedAt, status.finished_at) ??
    new Date().toISOString()
  const phase = firstString(data.phase, status.phase)
  const repository = firstString(data.repository, data.repo)
  const issueNumber = firstNumber(data.issueNumber, data.issue_number)
  const branch = firstString(data.branch, data.head_branch, data.head)
  const artifacts = readArtifacts(data)
  const content = buildContent(kind, data, status)

  if (!runId && !agentRunName && !agentRunUid) {
    throw new CodexCallbackInvalidPayloadError({
      message: 'callback payload must include agentRunName, agentRunUid, or runId',
    })
  }

  return {
    callback: {
      kind,
      agentRunName,
      agentRunNamespace,
      agentRunUid,
      runId,
      stage,
    },
    message: {
      agentRunUid,
      agentRunName,
      agentRunNamespace,
      runId,
      stepId: null,
      agentId: 'codex',
      role: 'system',
      kind: kind === 'run-complete' ? 'codex.run-complete' : 'codex.notify',
      timestamp,
      channel: 'general',
      stage,
      content,
      attrs: {
        callbackKind: kind,
        phase,
        repository,
        issueNumber,
        branch,
        artifacts,
        payload: data,
      },
      dedupeKey: `codex-callback:${kind}:${runId ?? agentRunUid ?? agentRunName}:${stableHash(data)}`,
    },
  }
}

export const ingestCodexCallbackEffect = (kind: CodexCallbackKind, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const built = yield* Effect.try({
      try: () => buildCodexCallbackMessage(kind, payload),
      catch: (error) => error,
    })
    const result = yield* ingestAgentMessagesEffect({ messages: [built.message] })
    return {
      callback: built.callback,
      inserted: result.inserted,
      skipped: result.skipped,
    }
  })

export const describeCodexCallbackError = (error: unknown) => {
  if (error instanceof CodexCallbackInvalidPayloadError) {
    return { status: 400, message: error.message }
  }

  return describeAgentMessagesIngestError(error)
}

export const postCodexCallbackHandler = async (
  kind: CodexCallbackKind,
  request: Request,
  layer: CodexCallbackApiLayer = AgentMessagesApiLive,
) => {
  try {
    let payload: Record<string, unknown>
    try {
      payload = await parseJsonBody(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResponse(message, 400)
    }

    const result = await Effect.runPromise(
      ingestCodexCallbackEffect(kind, payload).pipe(Effect.provide(layer), Effect.either),
    )
    if (result._tag === 'Left') throw result.left
    return okResponse({ ok: true, ...result.right }, result.right.skipped ? 200 : 202)
  } catch (error) {
    const response = describeCodexCallbackError(error)
    return errorResponse(response.message, response.status)
  }
}

export const codexCallbackMethodNotAllowedHandler = () => errorResponse('Method Not Allowed', 405)

export const codexCallbackOptionsHandler = () => okResponse({ ok: true, methods: ['POST', 'OPTIONS'] })
