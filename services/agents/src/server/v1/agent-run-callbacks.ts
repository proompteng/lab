import {
  parseAgentRunNotifyPayload,
  parseAgentRunRunCompletePayload,
} from '@proompteng/agent-contracts/agent-run-callbacks'
import { Data, Effect } from 'effect'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { asString, readNested } from '../primitives'
import type { AgentRunRecord, CreateAuditEventInput, UpdateRunDetailsInput } from '../primitives-store'

import { AgentRunStorageError, describeAgentRunSubmitError } from './agent-run-errors'
import { AgentRunStoreService, makeAgentRunStoreLayer, type AgentRunsApiStore } from './agent-run-store'

export type AgentRunCallbackStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  getAgentRunByExternalRunId: (externalRunId: string) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: UpdateRunDetailsInput) => Promise<AgentRunRecord | null>
  createAuditEvent: (input: CreateAuditEventInput) => Promise<unknown>
}

export type AgentRunCallbacksApiDependencies = {
  storeFactory: () => AgentRunCallbackStore & AgentRunsApiStore
  requireLeaderForMutation?: () => Response | null
}

type CallbackKind = 'notify' | 'run_complete'

type ParsedCallback =
  | {
      kind: 'run_complete'
      agentRunName: string | null
      agentRunNamespace: string | null
      agentRunUid: string | null
      runId: string | null
      status: string
      stage: string | null
      payload: Record<string, unknown>
      auditDetails: Record<string, unknown>
    }
  | {
      kind: 'notify'
      agentRunName: string | null
      agentRunNamespace: string | null
      agentRunUid: string | null
      runId: string | null
      status: string | null
      stage: string | null
      payload: Record<string, unknown>
      auditDetails: Record<string, unknown>
    }

class AgentRunCallbackRequestError extends Data.TaggedError('AgentRunCallbackRequestError')<{
  readonly message: string
  readonly status: 400 | 404 | 503
}> {}

class AgentRunCallbackStorageError extends Data.TaggedError('AgentRunCallbackStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

type AgentRunCallbackError = AgentRunCallbackRequestError | AgentRunCallbackStorageError | AgentRunStorageError

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const normalizeString = (value: unknown) => {
  const normalized = asString(value)
  return normalized && normalized.length > 0 ? normalized : null
}

const normalizeKind = (payload: Record<string, unknown>): CallbackKind | null => {
  const raw = normalizeString(payload.callbackType ?? payload.callback_type ?? payload.type ?? payload.eventType)
  if (!raw) return null
  const normalized = raw.trim().toLowerCase().replaceAll('-', '_')
  if (normalized === 'notify' || normalized === 'agent_run_notify') return 'notify'
  if (normalized === 'run_complete' || normalized === 'run_completed' || normalized === 'agent_run_run_complete') {
    return 'run_complete'
  }
  return null
}

const inferKind = (payload: Record<string, unknown>): CallbackKind => {
  const explicit = normalizeKind(payload)
  if (explicit) return explicit
  if (payload.pr_url || payload.prUrl || payload.review_status || payload.reviewStatus) return 'notify'
  return 'run_complete'
}

const parseCallback = (payload: Record<string, unknown>): ParsedCallback => {
  const kind = inferKind(payload)
  if (kind === 'notify') {
    const parsed = parseAgentRunNotifyPayload(payload)
    return {
      kind,
      agentRunName: parsed.agentRunName || null,
      agentRunNamespace: parsed.agentRunNamespace,
      agentRunUid: null,
      runId: parsed.runId,
      status: null,
      stage: parsed.stage,
      payload: parsed.notifyPayload,
      auditDetails: {
        repository: parsed.repository,
        issueNumber: parsed.issueNumber,
        branch: parsed.branch,
        prNumber: parsed.prNumber,
        reviewStatus: parsed.reviewStatus,
      },
    }
  }

  const parsed = parseAgentRunRunCompletePayload(payload)
  return {
    kind,
    agentRunName: parsed.agentRunName || null,
    agentRunNamespace: parsed.agentRunNamespace,
    agentRunUid: parsed.agentRunUid,
    runId: parsed.runId,
    status: parsed.phase ?? 'run_complete',
    stage: parsed.stage,
    payload: parsed.runCompletePayload,
    auditDetails: {
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      branch: parsed.head,
      phase: parsed.phase,
      stage: parsed.stage,
      artifactCount: parsed.artifacts.length,
      finishedAt: parsed.finishedAt,
    },
  }
}

const deriveAgentRunName = (run: AgentRunRecord, parsed: ParsedCallback) =>
  parsed.agentRunName ?? asString(readNested(run.payload, ['resource', 'metadata', 'name'])) ?? run.externalRunId

const deriveAgentRunNamespace = (run: AgentRunRecord, parsed: ParsedCallback) =>
  parsed.agentRunNamespace ?? asString(readNested(run.payload, ['resource', 'metadata', 'namespace']))

const deriveAgentRunUid = (run: AgentRunRecord, parsed: ParsedCallback) =>
  parsed.agentRunUid ?? asString(readNested(run.payload, ['resource', 'metadata', 'uid']))

const resolveAgentRun = (
  store: AgentRunCallbackStore,
  routeId: string,
  parsed: ParsedCallback,
): Effect.Effect<AgentRunRecord, AgentRunCallbackError> =>
  Effect.gen(function* () {
    const lookupId = parsed.runId ?? routeId
    const byId = lookupId
      ? yield* Effect.tryPromise({
          try: () => store.getAgentRunById(lookupId),
          catch: (cause) => new AgentRunCallbackStorageError({ operation: 'get-agent-run-by-id', cause }),
        })
      : null
    const externalRunId = parsed.agentRunName ?? routeId
    const run =
      byId ??
      (externalRunId
        ? yield* Effect.tryPromise({
            try: () => store.getAgentRunByExternalRunId(externalRunId),
            catch: (cause) =>
              new AgentRunCallbackStorageError({ operation: 'get-agent-run-by-external-run-id', cause }),
          })
        : null)
    if (!run) {
      return yield* Effect.fail(
        new AgentRunCallbackRequestError({ message: 'callback parent AgentRun not found', status: 404 }),
      )
    }
    return run
  })

const updateAgentRunProjection = (store: AgentRunCallbackStore, run: AgentRunRecord, parsed: ParsedCallback) => {
  const callbackPayload = {
    ...(typeof run.payload.callbacks === 'object' && run.payload.callbacks && !Array.isArray(run.payload.callbacks)
      ? (run.payload.callbacks as Record<string, unknown>)
      : {}),
    [parsed.kind]: {
      receivedAt: new Date().toISOString(),
      stage: parsed.stage,
      payload: parsed.payload,
    },
  }
  const status = parsed.status ?? run.status
  return Effect.tryPromise({
    try: () =>
      store.updateAgentRunDetails({
        id: run.id,
        status,
        externalRunId: run.externalRunId,
        payload: {
          ...run.payload,
          callbacks: callbackPayload,
          agentRunName: deriveAgentRunName(run, parsed),
          agentRunNamespace: deriveAgentRunNamespace(run, parsed),
          agentRunUid: deriveAgentRunUid(run, parsed),
        },
      }),
    catch: (cause) => new AgentRunCallbackStorageError({ operation: 'update-agent-run-callback', cause }),
  })
}

const createAuditEvent = (store: AgentRunCallbackStore, input: CreateAuditEventInput) =>
  Effect.tryPromise({
    try: () => store.createAuditEvent(input),
    catch: (cause) => new AgentRunCallbackStorageError({ operation: 'create-audit-event', cause }),
  })

export const ingestAgentRunCallbackEffect = (
  routeId: string,
  request: Request,
  deps: AgentRunCallbacksApiDependencies,
): Effect.Effect<Record<string, unknown>, AgentRunCallbackError> =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new AgentRunCallbackRequestError({ message: toErrorMessage(cause), status: 400 }),
    })
    const parsed = yield* Effect.try({
      try: () => parseCallback(payload),
      catch: (cause) => new AgentRunCallbackRequestError({ message: toErrorMessage(cause), status: 400 }),
    })

    const stores = yield* AgentRunStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          const store = activeStore as unknown as AgentRunCallbackStore
          yield* stores.ready(activeStore)
          const run = yield* resolveAgentRun(store, routeId, parsed)
          const updated = yield* updateAgentRunProjection(store, run, parsed)
          yield* createAuditEvent(store, {
            entityType: 'AgentRun',
            entityId: run.id,
            eventType: 'agent_run.callback_received',
            context: {
              source: 'v1.agent-runs.callbacks',
              namespace: deriveAgentRunNamespace(run, parsed),
            },
            details: { callbackType: parsed.kind, ...parsed.auditDetails },
          })
          return {
            ok: true,
            callbackType: parsed.kind,
            agentRun: updated ?? run,
          }
        }),
      stores.close,
    )
  }).pipe(Effect.provide(makeAgentRunStoreLayer(deps.storeFactory)))

const describeCallbackError = (error: AgentRunCallbackError) => {
  if (error instanceof AgentRunCallbackRequestError) return error.message
  if (error instanceof AgentRunStorageError) return describeAgentRunSubmitError(error)
  return `AgentRun callback storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
}

const callbackStatus = (error: AgentRunCallbackError) => {
  if (error instanceof AgentRunCallbackRequestError) return error.status
  return 503
}

export const postAgentRunCallbacksHandler = async (
  routeId: string,
  request: Request,
  deps: AgentRunCallbacksApiDependencies,
) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(ingestAgentRunCallbackEffect(routeId, request, deps).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right, 202)
  return errorResponse(describeCallbackError(result.left), callbackStatus(result.left))
}

export const __test__ = {
  inferKind,
  parseCallback,
}
