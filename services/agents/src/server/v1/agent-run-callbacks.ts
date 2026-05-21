import {
  parseAgentRunNotifyPayload,
  parseAgentRunRunCompletePayload,
} from '@proompteng/agent-contracts/agent-run-callbacks'
import { Data, Effect, Layer } from 'effect'

import { type CodexRunProjectionStore } from '../codex-run-projection-store'
import { errorResponse, okResponse, parseJsonBody } from '../http'
import { asString, readNested } from '../primitives'
import type { AgentRunRecord, CreateAuditEventInput, UpdateRunDetailsInput } from '../primitives-store'

import { AgentRunStorageError, describeAgentRunSubmitError } from './agent-run-errors'
import { AgentRunStoreService, makeAgentRunStoreLayer, type AgentRunsApiStore } from './agent-run-store'
import {
  CodexRunProjectionStorageError,
  CodexRunProjectionStoreService,
  type CodexRunProjectionStoreServiceDefinition,
  describeCodexRunProjectionStorageError,
  makeCodexRunProjectionStoreLayer,
} from './codex-run-projection-store'

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
  codexStoreFactory?: () => CodexRunProjectionStore
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
      codexProjection: ReturnType<typeof parseAgentRunRunCompletePayload>
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
      codexProjection: ReturnType<typeof parseAgentRunNotifyPayload>
    }

class AgentRunCallbackRequestError extends Data.TaggedError('AgentRunCallbackRequestError')<{
  readonly message: string
  readonly status: 400 | 404 | 503
}> {}

class AgentRunCallbackStorageError extends Data.TaggedError('AgentRunCallbackStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

type AgentRunCallbackError =
  | AgentRunCallbackRequestError
  | AgentRunCallbackStorageError
  | AgentRunStorageError
  | CodexRunProjectionStorageError

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
      codexProjection: parsed,
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
    codexProjection: parsed,
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

const updateCodexNotifyProjection = (
  codexStores: CodexRunProjectionStoreServiceDefinition,
  codexStore: CodexRunProjectionStore,
  run: AgentRunRecord,
  parsed: Extract<ParsedCallback, { kind: 'notify' }>,
) =>
  Effect.gen(function* () {
    const codex = parsed.codexProjection
    const agentRunName = deriveAgentRunName(run, parsed) ?? parsed.agentRunName ?? run.externalRunId ?? run.id
    const agentRunNamespace = deriveAgentRunNamespace(run, parsed)
    const projection = yield* codexStores.attachNotify(codexStore, {
      runId: codex.runId,
      agentRunName,
      agentRunNamespace,
      notifyPayload: codex.notifyPayload,
      repository: codex.repository,
      issueNumber: codex.issueNumber,
      branch: codex.branch,
      prompt: codex.prompt,
      stage: codex.stage,
      iteration: codex.iteration,
      iterationCycle: codex.iterationCycle,
    })

    const prNumber = codex.prNumber
    const prUrl = codex.prUrl
    if (projection && prNumber && prUrl) {
      yield* codexStores.updateRunPrInfo(codexStore, projection.id, prNumber, prUrl, codex.headSha)
    }

    const reviewStatus = codex.reviewStatus
    if (projection && reviewStatus) {
      yield* codexStores.updateReviewStatus(codexStore, {
        runId: projection.id,
        status: reviewStatus,
        summary: codex.reviewSummary ?? {},
      })
    }

    return projection
  })

const updateCodexRunCompleteProjection = (
  codexStores: CodexRunProjectionStoreServiceDefinition,
  codexStore: CodexRunProjectionStore,
  run: AgentRunRecord,
  parsed: Extract<ParsedCallback, { kind: 'run_complete' }>,
) =>
  Effect.gen(function* () {
    const codex = parsed.codexProjection
    const agentRunName = deriveAgentRunName(run, parsed) ?? parsed.agentRunName ?? run.externalRunId ?? run.id
    const agentRunNamespace = deriveAgentRunNamespace(run, parsed)
    const existing =
      (codex.runId ? yield* codexStores.getRunById(codexStore, codex.runId) : null) ??
      (agentRunName ? yield* codexStores.getRunByAgentRun(codexStore, agentRunName, agentRunNamespace) : null)
    const repository = codex.repository || existing?.repository || 'unknown'
    const issueNumber = codex.issueNumber > 0 ? codex.issueNumber : (existing?.issueNumber ?? 0)
    const branch = codex.head || existing?.branch || 'unknown'
    const projection = yield* codexStores.upsertRunComplete(codexStore, {
      runId: codex.runId,
      repository,
      issueNumber,
      branch,
      agentRunName,
      agentRunUid: codex.agentRunUid ?? existing?.agentRunUid ?? deriveAgentRunUid(run, parsed),
      agentRunNamespace,
      stage: codex.stage ?? existing?.stage ?? null,
      turnId: codex.turnId ?? existing?.turnId ?? null,
      threadId: codex.threadId ?? existing?.threadId ?? null,
      status: 'run_complete',
      phase: codex.phase,
      iteration: codex.iteration,
      iterationCycle: codex.iterationCycle,
      prompt: codex.prompt ?? existing?.prompt ?? null,
      runCompletePayload: {
        ...codex.runCompletePayload,
        issueTitle: codex.issueTitle,
        issueBody: codex.issueBody,
        issueUrl: codex.issueUrl,
        base: codex.base,
        head: branch,
        repository,
        issueNumber,
        turnId: codex.turnId ?? existing?.turnId ?? null,
        threadId: codex.threadId ?? existing?.threadId ?? null,
        iteration: codex.iteration,
        iteration_cycle: codex.iterationCycle,
        iterations: codex.iterations,
        runId: codex.runId,
        agentRunName,
        agentRunNamespace,
        agentRunUid: codex.agentRunUid,
      },
      startedAt: codex.startedAt,
      finishedAt: codex.finishedAt,
    })

    if (codex.artifacts.length > 0) {
      yield* codexStores.upsertArtifacts(codexStore, { runId: projection.id, artifacts: codex.artifacts })
    }

    return projection
  })

const updateCodexRunProjection = (run: AgentRunRecord, parsed: ParsedCallback) =>
  Effect.gen(function* () {
    const codexStores = yield* CodexRunProjectionStoreService
    return yield* Effect.acquireUseRelease(
      codexStores.open,
      (codexStore) =>
        Effect.gen(function* () {
          yield* codexStores.ready(codexStore)
          if (parsed.kind === 'notify') {
            return yield* updateCodexNotifyProjection(codexStores, codexStore, run, parsed)
          }
          return yield* updateCodexRunCompleteProjection(codexStores, codexStore, run, parsed)
        }),
      codexStores.close,
    )
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
          const codexRun = yield* updateCodexRunProjection(run, parsed)
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
            codexRun,
          }
        }),
      stores.close,
    )
  }).pipe(
    Effect.provide(
      Layer.merge(makeAgentRunStoreLayer(deps.storeFactory), makeCodexRunProjectionStoreLayer(deps.codexStoreFactory)),
    ),
  )

const describeCallbackError = (error: AgentRunCallbackError) => {
  if (error instanceof AgentRunCallbackRequestError) return error.message
  if (error instanceof AgentRunStorageError) return describeAgentRunSubmitError(error)
  if (error instanceof CodexRunProjectionStorageError) return describeCodexRunProjectionStorageError(error)
  return `AgentRun callback storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
}

const callbackStatus = (error: AgentRunCallbackError) => {
  if (error instanceof AgentRunCallbackRequestError) return error.status
  if (error instanceof CodexRunProjectionStorageError) return error.httpStatusCode
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
