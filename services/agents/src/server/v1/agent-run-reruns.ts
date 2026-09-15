import { buildCodexOrchestrationParameters } from '@proompteng/agent-contracts'
import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { asRecord, asString, readNested } from '../primitives'
import type {
  AgentRunRecord,
  AgentRunRerunSubmissionRecord,
  CreateAuditEventInput,
  UpdateRunDetailsInput,
} from '../primitives-store'

import { AgentRunStorageError, describeAgentRunSubmitError } from './agent-run-errors'
import { AgentRunStoreService, makeAgentRunStoreLayer, type AgentRunsApiStore } from './agent-run-store'
import {
  describeOrchestrationSubmitError,
  OrchestrationSubmitKubeError,
  OrchestrationSubmitNotFoundError,
  OrchestrationSubmitPolicyDeniedError,
  OrchestrationSubmitStorageError,
  makeOrchestrationSubmitLayer,
  submitOrchestrationRunWithServicesEffect,
  type OrchestrationRunSubmitStore,
  type SubmitOrchestrationRunDeps,
} from './orchestration-submit'

export type AgentRunRerunRuntimeConfigOptions = {
  env?: Record<string, string | undefined>
}

type AgentRunRerunRuntimeConfigServiceDefinition = {
  readonly env: Record<string, string | undefined>
}

class AgentRunRerunRuntimeConfigService extends Context.Tag('agents/AgentRunRerunRuntimeConfigService')<
  AgentRunRerunRuntimeConfigService,
  AgentRunRerunRuntimeConfigServiceDefinition
>() {}

const makeAgentRunRerunRuntimeConfigLayer = (runtimeConfig?: AgentRunRerunRuntimeConfigOptions) =>
  Layer.succeed(AgentRunRerunRuntimeConfigService, { env: runtimeConfig?.env ?? process.env })

export type AgentRunRerunStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  getAgentRunByExternalRunId: (externalRunId: string) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: UpdateRunDetailsInput) => Promise<AgentRunRecord | null>
  enqueueAgentRunRerunSubmission: (input: {
    parentRef: string
    parentAgentRunId?: string | null
    parentAgentRunName?: string | null
    parentAgentRunNamespace?: string | null
    attempt: number
    deliveryId: string
    requestPayload: Record<string, unknown>
  }) => Promise<{ submission: AgentRunRerunSubmissionRecord; created: boolean }>
  claimAgentRunRerunSubmission: (input: {
    parentRef: string
    attempt: number
    deliveryId: string
  }) => Promise<{ submission: AgentRunRerunSubmissionRecord; shouldSubmit: boolean } | null>
  updateAgentRunRerunSubmission: (input: {
    id: string
    status: string
    responseStatus?: number | null
    error?: string | null
    responsePayload?: Record<string, unknown> | null
    submittedAt?: string | Date | null
  }) => Promise<AgentRunRerunSubmissionRecord | null>
  createAuditEvent: (input: CreateAuditEventInput) => Promise<unknown>
}

export type AgentRunRerunsApiDependencies = Omit<SubmitOrchestrationRunDeps, 'storeFactory'> & {
  storeFactory: () => AgentRunRerunStore & OrchestrationRunSubmitStore & AgentRunsApiStore
  runtimeConfig?: AgentRunRerunRuntimeConfigOptions
  requireLeaderForMutation?: () => Response | null
}

type RerunPayload = {
  repository: string | null
  issueNumber: number | null
  attempt: number
  prompt: string
  runId: string | null
  agentRunName: string | null
  agentRunNamespace: string | null
  agentRunUid: string | null
  deliveryId: string | null
  base: string | null
  head: string | null
  judgePrompt: string | null
  orchestrationName: string | null
  orchestrationNamespace: string | null
}

type ParentResolution = {
  run: AgentRunRecord
  parentRef: string
  agentRunName: string | null
  agentRunNamespace: string | null
  agentRunUid: string | null
}

class AgentRunRerunRequestError extends Data.TaggedError('AgentRunRerunRequestError')<{
  readonly message: string
  readonly status: 400 | 404 | 409 | 503
}> {}

class AgentRunRerunConfigError extends Data.TaggedError('AgentRunRerunConfigError')<{
  readonly message: string
}> {}

class AgentRunRerunStorageError extends Data.TaggedError('AgentRunRerunStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

type AgentRunRerunError =
  | AgentRunRerunRequestError
  | AgentRunRerunConfigError
  | AgentRunRerunStorageError
  | AgentRunStorageError
  | OrchestrationSubmitStorageError
  | OrchestrationSubmitKubeError
  | OrchestrationSubmitNotFoundError
  | OrchestrationSubmitPolicyDeniedError

const DEFAULT_RERUN_NAMESPACE = 'agents'
const DEFAULT_JUDGE_PROMPT = [
  'You are the Codex judge.',
  'Evaluate whether the PR satisfies the issue requirements with no gaps.',
  'Return a single JSON object with decision, confidence, reasons, missing_items, suggested_fixes, next_prompt, and system_suggestions.',
].join('\n')

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const normalizeString = (value: unknown) => {
  const normalized = asString(value)
  return normalized && normalized.length > 0 ? normalized : null
}

const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const normalized = normalizeString(value)
  if (!normalized) return null
  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeEnvString = (env: Record<string, string | undefined>, key: string) => normalizeString(env[key])

const parseRerunPayload = (payload: Record<string, unknown>, env: Record<string, string | undefined>): RerunPayload => {
  const attempt = normalizeNumber(payload.attempt ?? payload.rerun_attempt)
  const prompt = normalizeString(payload.prompt ?? payload.nextPrompt ?? payload.next_prompt)
  if (!attempt || attempt <= 0) {
    throw new AgentRunRerunRequestError({ message: 'attempt is required', status: 400 })
  }
  if (!prompt) {
    throw new AgentRunRerunRequestError({ message: 'prompt is required', status: 400 })
  }

  const orchestrationRef = asRecord(payload.orchestrationRef ?? payload.orchestration_ref)

  return {
    repository: normalizeString(payload.repository ?? payload.repo),
    issueNumber: normalizeNumber(payload.issueNumber ?? payload.issue_number),
    attempt,
    prompt,
    runId: normalizeString(payload.runId ?? payload.run_id),
    agentRunName: normalizeString(payload.agentRunName ?? payload.agent_run_name),
    agentRunNamespace: normalizeString(payload.agentRunNamespace ?? payload.agent_run_namespace),
    agentRunUid: normalizeString(payload.agentRunUid ?? payload.agent_run_uid),
    deliveryId: normalizeString(payload.deliveryId ?? payload.delivery_id),
    base: normalizeString(payload.base ?? payload.baseBranch ?? payload.base_branch),
    head: normalizeString(payload.head ?? payload.branch ?? payload.headBranch ?? payload.head_branch),
    judgePrompt:
      normalizeString(payload.judgePrompt ?? payload.judge_prompt) ??
      normalizeEnvString(env, 'AGENTS_CODEX_JUDGE_PROMPT') ??
      DEFAULT_JUDGE_PROMPT,
    orchestrationName:
      normalizeString(orchestrationRef?.name) ?? normalizeEnvString(env, 'AGENTS_CODEX_RERUN_ORCHESTRATION'),
    orchestrationNamespace:
      normalizeString(orchestrationRef?.namespace) ??
      normalizeEnvString(env, 'AGENTS_CODEX_RERUN_ORCHESTRATION_NAMESPACE'),
  }
}

const deriveAgentRunName = (run: AgentRunRecord, payloadName: string | null) =>
  payloadName ?? asString(readNested(run.payload, ['resource', 'metadata', 'name'])) ?? run.externalRunId

const deriveAgentRunNamespace = (run: AgentRunRecord, payloadNamespace: string | null) =>
  payloadNamespace ?? asString(readNested(run.payload, ['resource', 'metadata', 'namespace']))

const deriveAgentRunUid = (run: AgentRunRecord, payloadUid: string | null) =>
  payloadUid ?? asString(readNested(run.payload, ['resource', 'metadata', 'uid']))

const deriveParameter = (run: AgentRunRecord, keys: string[]) => {
  for (const key of keys) {
    const candidate =
      asString(readNested(run.payload, ['request', 'parameters', key])) ??
      asString(readNested(run.payload, ['resource', 'spec', 'parameters', key]))
    if (candidate) return candidate
  }
  return null
}

const resolveParent = (
  store: AgentRunRerunStore,
  parsed: RerunPayload,
): Effect.Effect<ParentResolution, AgentRunRerunRequestError | AgentRunRerunStorageError> =>
  Effect.gen(function* () {
    const runById =
      parsed.runId != null
        ? yield* Effect.tryPromise({
            try: () => store.getAgentRunById(parsed.runId ?? ''),
            catch: (cause) => new AgentRunRerunStorageError({ operation: 'get-agent-run-by-id', cause }),
          })
        : null
    const externalRunId = parsed.agentRunName ?? parsed.runId
    const run =
      runById ??
      (externalRunId != null
        ? yield* Effect.tryPromise({
            try: () => store.getAgentRunByExternalRunId(externalRunId),
            catch: (cause) => new AgentRunRerunStorageError({ operation: 'get-agent-run-by-external-run-id', cause }),
          })
        : null)

    if (!run) {
      return yield* Effect.fail(
        new AgentRunRerunRequestError({ message: 'rerun parent AgentRun not found', status: 404 }),
      )
    }

    const agentRunName = deriveAgentRunName(run, parsed.agentRunName)
    const agentRunNamespace = deriveAgentRunNamespace(run, parsed.agentRunNamespace)
    const agentRunUid = deriveAgentRunUid(run, parsed.agentRunUid)

    return {
      run,
      parentRef: `agent_runs:${run.id}`,
      agentRunName,
      agentRunNamespace,
      agentRunUid,
    }
  })

const resolveDeliveryId = (parsed: RerunPayload, parent: ParentResolution) =>
  parsed.deliveryId ?? `${parent.parentRef}:attempt-${parsed.attempt}`

const resolveOrchestrationNamespace = (parsed: RerunPayload, parent: ParentResolution) =>
  parsed.orchestrationNamespace ?? parent.agentRunNamespace ?? DEFAULT_RERUN_NAMESPACE

const buildRerunParameters = (parsed: RerunPayload, parent: ParentResolution) =>
  buildCodexOrchestrationParameters({
    repository: parsed.repository ?? deriveParameter(parent.run, ['repository', 'repo']),
    issueNumber: parsed.issueNumber ?? deriveParameter(parent.run, ['issueNumber', 'issue_number']),
    base: parsed.base ?? deriveParameter(parent.run, ['base', 'baseBranch', 'base_branch']) ?? 'main',
    head: parsed.head ?? deriveParameter(parent.run, ['head', 'headBranch', 'head_branch', 'branch']),
    prompt: parsed.prompt,
    judgePrompt: parsed.judgePrompt,
    attempt: parsed.attempt,
    parentRunUid: parent.agentRunUid ?? parent.run.id,
  })

const updateParentStatus = (
  store: AgentRunRerunStore,
  run: AgentRunRecord,
  status: string,
  rerun: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: () =>
      store.updateAgentRunDetails({
        id: run.id,
        status,
        externalRunId: run.externalRunId,
        payload: {
          ...run.payload,
          rerun,
        },
      }),
    catch: (cause) => new AgentRunRerunStorageError({ operation: 'update-parent-agent-run', cause }),
  })

const createAuditEvent = (store: AgentRunRerunStore, input: CreateAuditEventInput) =>
  Effect.tryPromise({
    try: () => store.createAuditEvent(input),
    catch: (cause) => new AgentRunRerunStorageError({ operation: 'create-audit-event', cause }),
  })

const rerunStoreEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentRunRerunStorageError({ operation, cause }),
  })

export const submitAgentRunRerunEffect = (
  agentRunId: string,
  request: Request,
  deps: AgentRunRerunsApiDependencies,
): Effect.Effect<Record<string, unknown>, AgentRunRerunError> =>
  Effect.gen(function* () {
    const runtimeConfig = yield* AgentRunRerunRuntimeConfigService
    const env = runtimeConfig.env
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new AgentRunRerunRequestError({ message: toErrorMessage(cause), status: 400 }),
    })
    const parsedBody = yield* Effect.try({
      try: () => parseRerunPayload(payload, env),
      catch: (cause) =>
        cause instanceof AgentRunRerunRequestError
          ? cause
          : new AgentRunRerunRequestError({ message: toErrorMessage(cause), status: 400 }),
    })
    const parsed = parsedBody.runId || parsedBody.agentRunName ? parsedBody : { ...parsedBody, runId: agentRunId }

    if (!parsed.orchestrationName) {
      return yield* Effect.fail(
        new AgentRunRerunConfigError({ message: 'AGENTS_CODEX_RERUN_ORCHESTRATION is required' }),
      )
    }
    const orchestrationName = parsed.orchestrationName

    const stores = yield* AgentRunStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          const store = activeStore as unknown as AgentRunRerunStore
          yield* stores.ready(activeStore)
          const parent = yield* resolveParent(store, parsed)
          const deliveryId = resolveDeliveryId(parsed, parent)
          const orchestrationNamespace = resolveOrchestrationNamespace(parsed, parent)
          const parameters = buildRerunParameters(parsed, parent)
          const enqueued = yield* rerunStoreEffect('enqueue-rerun-submission', () =>
            store.enqueueAgentRunRerunSubmission({
              parentRef: parent.parentRef,
              parentAgentRunId: parent.run.id,
              parentAgentRunName: parent.agentRunName,
              parentAgentRunNamespace: parent.agentRunNamespace,
              attempt: parsed.attempt,
              deliveryId,
              requestPayload: { ...payload, parameters },
            }),
          )
          const claimed = yield* rerunStoreEffect('claim-rerun-submission', () =>
            store.claimAgentRunRerunSubmission({
              parentRef: parent.parentRef,
              attempt: parsed.attempt,
              deliveryId,
            }),
          )
          if (!claimed) {
            return yield* Effect.fail(
              new AgentRunRerunRequestError({ message: 'rerun submission claim failed', status: 409 }),
            )
          }
          if (!claimed.shouldSubmit) {
            return {
              ok: true,
              idempotent: true,
              agentRun: parent.run,
              submission: claimed.submission,
            }
          }

          yield* updateParentStatus(store, parent.run, 'needs_iteration', {
            attempt: parsed.attempt,
            deliveryId,
            prompt: parsed.prompt,
            status: 'pending',
            submittedAt: null,
          })

          const result = yield* submitOrchestrationRunWithServicesEffect({
            deliveryId,
            orchestrationRef: { name: orchestrationName },
            namespace: orchestrationNamespace,
            parameters,
          }).pipe(
            Effect.tapError((error) =>
              rerunStoreEffect('mark-rerun-submission-failed', () =>
                store.updateAgentRunRerunSubmission({
                  id: claimed.submission.id,
                  status: 'failed',
                  responseStatus: null,
                  error: describeOrchestrationSubmitError(error),
                }),
              ).pipe(
                Effect.zipRight(
                  updateParentStatus(store, parent.run, 'needs_human', {
                    attempt: parsed.attempt,
                    deliveryId,
                    prompt: parsed.prompt,
                    status: 'failed',
                    error: describeOrchestrationSubmitError(error),
                  }),
                ),
              ),
            ),
          )

          const updatedSubmission = yield* rerunStoreEffect('mark-rerun-submission-submitted', () =>
            store.updateAgentRunRerunSubmission({
              id: claimed.submission.id,
              status: 'submitted',
              responseStatus: 201,
              error: null,
              responsePayload: {
                orchestrationRun: result.orchestrationRun,
                resource: result.resource,
                idempotent: result.idempotent,
              },
              submittedAt: new Date().toISOString(),
            }),
          )

          yield* createAuditEvent(store, {
            entityType: 'AgentRun',
            entityId: parent.run.id,
            eventType: 'agent_run.rerun_submitted',
            context: {
              source: 'v1.agent-runs.reruns',
              deliveryId,
              namespace: orchestrationNamespace,
              repository: parameters.repository,
            },
            details: {
              attempt: parsed.attempt,
              orchestrationRef: { name: orchestrationName, namespace: orchestrationNamespace },
              parentRef: parent.parentRef,
              submissionId: updatedSubmission?.id ?? enqueued.submission.id,
            },
          })

          return {
            ok: true,
            agentRun: parent.run,
            submission: updatedSubmission ?? claimed.submission,
            orchestrationRun: result.orchestrationRun,
            resource: result.resource,
            idempotent: result.idempotent,
          }
        }),
      stores.close,
    )
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeAgentRunStoreLayer(deps.storeFactory),
        makeOrchestrationSubmitLayer({ ...deps, storeFactory: deps.storeFactory }),
        makeAgentRunRerunRuntimeConfigLayer(deps.runtimeConfig),
      ),
    ),
  )

const describeRerunError = (error: AgentRunRerunError) => {
  if (error instanceof AgentRunRerunRequestError) return error.message
  if (error instanceof AgentRunRerunConfigError) return error.message
  if (error instanceof AgentRunRerunStorageError) {
    return `AgentRun rerun storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof AgentRunStorageError) return describeAgentRunSubmitError(error)
  return describeOrchestrationSubmitError(error)
}

const rerunStatus = (error: AgentRunRerunError) => {
  if (error instanceof AgentRunRerunRequestError) return error.status
  if (error instanceof AgentRunRerunConfigError) return 503
  if (error instanceof AgentRunRerunStorageError) return 503
  if (error instanceof OrchestrationSubmitNotFoundError) return 404
  if (error instanceof OrchestrationSubmitPolicyDeniedError) return 403
  if (error instanceof OrchestrationSubmitKubeError) return 502
  return 503
}

export const postAgentRunRerunsHandler = async (
  agentRunId: string,
  request: Request,
  deps: AgentRunRerunsApiDependencies,
) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitAgentRunRerunEffect(agentRunId, request, deps).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right, result.right.idempotent === true ? 200 : 201)
  return errorResponse(describeRerunError(result.left), rerunStatus(result.left))
}

export const __test__ = {
  buildRerunParameters,
  parseRerunPayload,
}
