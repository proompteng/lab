import { expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { Data, Duration, Effect, Exit, Redacted, References, Result, Schedule } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  BrokerEnvironment,
  ExecutionAccess,
  disabledCapitalAccess,
  makeExecutionAuthority,
} from '../execution/authority'
import { IntentState, MutationOutcome, OrderSide, OrderType, TimeInForce, type Intent } from '../paper'
import { currentUtcDate, currentUtcInstant } from '../time'
import {
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  makeMutation,
  type BrokerMutationShape,
} from './alpaca-mutations'
import {
  AssetStatus,
  BrokerProvider,
  BrokerReadError,
  BrokerReadErrorKind,
  BrokerSessionAcquisitionError,
  BrokerSessionAcquisitionStage,
  OrderCollection,
  OrderStatus,
  alpacaSandboxBaseUrl,
  acquireBrokerSession,
  decodeBrokerConnection,
  type BrokerSessionShape,
  type Order,
  type ReadResult,
} from './alpaca'

const enabled = Bun.env.BAYN_ALPACA_SANDBOX_CONTRACT === '1'
const receiptPath = Bun.env.BAYN_ALPACA_SANDBOX_RECEIPT_PATH
const proofSymbol = 'AAPL'
const proofQuantityMicros = '10000'
const brokerOperationTimeoutMs = 5_000
const lookupRetryCount = 2
const terminalPollCount = 5
const retryDelayMs = 1_000
const mutationPhaseDeadlineMs = 2 * 60_000
const cleanupDeadlineMs = 3 * 60_000
const retryDelay = Duration.millis(retryDelayMs)
const mutationPhaseDeadline = Duration.millis(mutationPhaseDeadlineMs)
const cleanupDeadline = Duration.millis(cleanupDeadlineMs)
const maximumRetryReadMs = (lookupRetryCount + 1) * brokerOperationTimeoutMs + lookupRetryCount * retryDelayMs
const maximumCleanupNetworkMs =
  maximumRetryReadMs +
  brokerOperationTimeoutMs +
  (terminalPollCount + 1) * maximumRetryReadMs +
  terminalPollCount * retryDelayMs +
  maximumRetryReadMs

const required = (name: string): string => {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be present and free of surrounding whitespace`)
  }
  return value
}

const hashIdentity = (value: string): string => canonicalHashV1({ value })

type ProofStage =
  | 'CONFIGURATION'
  | 'SESSION_PREFLIGHT'
  | 'CLOCK_PREFLIGHT'
  | 'ASSET_PREFLIGHT'
  | 'SUBMIT'
  | 'LOOKUP_BY_CLIENT_ID'
  | 'CANCEL'
  | 'TERMINAL_LOOKUP'
  | 'CLEANUP'

class SandboxContractProofError extends Data.TaggedError('SandboxContractProofError')<{
  readonly stage: ProofStage
  readonly failure: string
}> {}

interface SanitizedFailure {
  readonly stage: ProofStage
  readonly tag: string
  readonly failure: string
  readonly acquisitionStage?: string
  readonly causeTag?: string
  readonly causeFailure?: string
  readonly operation?: string
  readonly status?: number
  readonly retryable?: boolean
}

interface LifecycleEvent {
  readonly stage: string
  readonly observedAt: string
  readonly status?: string | number
  readonly requestBinding?: string
  readonly contentHash?: string
}

interface ProofState {
  startedAt?: string
  completedAt?: string
  preflightCompletedAt?: string
  clock?: {
    readonly observedAt: string
    readonly marketOpen: false
    readonly sessionCount: number
    readonly calendarHash: string
  }
  asset?: {
    readonly status: AssetStatus.Active
    readonly tradable: true
    readonly fractionable: true
    readonly observationHash: string
  }
  submitOutcome: 'NOT_ATTEMPTED' | 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN'
  brokerOrderId?: string
  acceptedOrderContractMismatch: boolean
  finalStatus?: OrderStatus
  cancelAttempts: number
  cancelAcknowledged: boolean
  lifecycle: LifecycleEvent[]
  cleanup: {
    result: 'NOT_RUN' | 'CONFIRMED_NOT_CREATED' | 'VERIFIED_TERMINAL' | 'FAILED'
    verifiedAt?: string
    residualOpenOrderCount?: number
  }
  failure?: SanitizedFailure
  cleanupFailure?: SanitizedFailure
}

const proofFailure = (stage: ProofStage, failure: string): SandboxContractProofError =>
  new SandboxContractProofError({ stage, failure })

const sanitizeFailure = (stage: ProofStage, error: unknown): SanitizedFailure => {
  if (error instanceof BrokerSessionAcquisitionError) {
    const cause = error.cause
    if (cause instanceof BrokerReadError) {
      return {
        stage: 'SESSION_PREFLIGHT',
        tag: error._tag,
        failure: error.stage,
        acquisitionStage: error.stage,
        causeTag: cause._tag,
        causeFailure: cause.kind,
        operation: cause.operation,
        status: cause.status,
        retryable: cause.retryable,
      }
    }
    return {
      stage: 'SESSION_PREFLIGHT',
      tag: error._tag,
      failure: error.stage,
      acquisitionStage: error.stage,
      causeTag: cause._tag,
      causeFailure: cause.failure._tag,
      retryable: false,
    }
  }
  if (error instanceof BrokerReadError) {
    return {
      stage,
      tag: error._tag,
      failure: error.kind,
      operation: error.operation,
      status: error.status,
      retryable: error.retryable,
    }
  }
  if (error instanceof BrokerMutationError) {
    return {
      stage,
      tag: error._tag,
      failure: error.failure,
      operation: error.operation,
      status: error.evidence?.status,
      retryable: error.failure === MutationFailure.Unknown,
    }
  }
  if (error instanceof SandboxContractProofError) {
    return { stage: error.stage, tag: error._tag, failure: error.failure, retryable: false }
  }
  return { stage, tag: 'UnexpectedFailure', failure: 'UNCLASSIFIED', retryable: false }
}

const failureStage = (error: unknown): ProofStage => {
  if (error instanceof SandboxContractProofError) return error.stage
  if (error instanceof BrokerSessionAcquisitionError) return 'SESSION_PREFLIGHT'
  if (error instanceof BrokerMutationError) return error.operation === 'CANCEL' ? 'CANCEL' : 'SUBMIT'
  if (error instanceof BrokerReadError) {
    switch (error.operation) {
      case 'market-calendar':
        return 'CLOCK_PREFLIGHT'
      case 'asset-by-symbol':
        return 'ASSET_PREFLIGHT'
      case 'order-by-client-id':
        return 'LOOKUP_BY_CLIENT_ID'
      case 'order-by-id':
      case 'orders':
        return 'CLEANUP'
      case 'configuration':
      case 'proxy':
        return 'CONFIGURATION'
      case 'preflight':
      case 'account':
      case 'account-configuration':
      case 'positions':
      case 'fill-activities':
        return 'SESSION_PREFLIGHT'
    }
  }
  return 'CONFIGURATION'
}

const terminalOrderStatuses: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Rejected,
])

const isOpenStatus = (status: OrderStatus): boolean => !terminalOrderStatuses.has(status)

const retryRead = <A>(
  effect: Effect.Effect<A, BrokerReadError>,
  retryNotFound = false,
): Effect.Effect<A, BrokerReadError> =>
  effect.pipe(
    Effect.retry({
      times: lookupRetryCount,
      schedule: Schedule.spaced(retryDelay),
      while: (error) => error.retryable || (retryNotFound && error.kind === BrokerReadErrorKind.NotFound),
    }),
  )

const mutationEvidence = (
  stage: string,
  evidence: { status: number; requestId: string; contentHash: string; observedAt: string },
): LifecycleEvent => ({
  stage,
  observedAt: evidence.observedAt,
  status: evidence.status,
  requestBinding: hashIdentity(evidence.requestId),
  contentHash: evidence.contentHash,
})

const readEvidence = (stage: string, result: ReadResult<Order>): LifecycleEvent => ({
  stage,
  observedAt: result.evidence.observedAt,
  status: result.value.status,
  requestBinding: hashIdentity(result.evidence.requestId),
  contentHash: result.evidence.contentHash,
})

const requireOrderBinding = (
  order: Order,
  clientOrderId: string,
  brokerOrderId: string,
  allowAcceptedContractMismatch: boolean,
  stage: ProofStage,
): Effect.Effect<void, SandboxContractProofError> =>
  order.brokerOrderId === brokerOrderId && (allowAcceptedContractMismatch || order.clientOrderId === clientOrderId)
    ? Effect.succeed(undefined)
    : Effect.fail(proofFailure(stage, 'ORDER_BINDING_MISMATCH'))

const waitForTerminalOrder = (
  orderById: (brokerOrderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>,
  brokerOrderId: string,
  clientOrderId: string,
  allowAcceptedContractMismatch: boolean,
  state: ProofState,
  attempt = 0,
): Effect.Effect<ReadResult<Order>, BrokerReadError | SandboxContractProofError> =>
  retryRead(orderById(brokerOrderId)).pipe(
    Effect.flatMap((result) =>
      requireOrderBinding(
        result.value,
        clientOrderId,
        brokerOrderId,
        allowAcceptedContractMismatch,
        'TERMINAL_LOOKUP',
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.lifecycle.push(readEvidence('TERMINAL_LOOKUP', result))
            state.finalStatus = result.value.status
          }),
        ),
        Effect.andThen(
          !isOpenStatus(result.value.status)
            ? Effect.succeed(result)
            : attempt >= terminalPollCount
              ? Effect.fail(proofFailure('TERMINAL_LOOKUP', 'ORDER_REMAINED_OPEN'))
              : Effect.sleep(retryDelay).pipe(
                  Effect.andThen(
                    waitForTerminalOrder(
                      orderById,
                      brokerOrderId,
                      clientOrderId,
                      allowAcceptedContractMismatch,
                      state,
                      attempt + 1,
                    ),
                  ),
                ),
        ),
      ),
    ),
  )

const cancelIfOpen = (
  mutation: BrokerMutationShape,
  order: Order,
  state: ProofState,
): Effect.Effect<void, BrokerMutationError> => {
  if (!isOpenStatus(order.status)) return Effect.succeed(undefined)
  state.cancelAttempts += 1
  return mutation.cancel(order.brokerOrderId).pipe(
    Effect.tap((receipt) =>
      Effect.sync(() => {
        state.cancelAcknowledged = true
        state.lifecycle.push(mutationEvidence('CANCEL', receipt.evidence))
      }),
    ),
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.gen(function* () {
        const observedAt = error.evidence?.observedAt ?? (yield* currentUtcInstant)
        state.lifecycle.push({
          stage: 'CANCEL_UNKNOWN',
          observedAt,
          status: error.evidence?.status,
          requestBinding: error.evidence?.requestId === undefined ? undefined : hashIdentity(error.evidence.requestId),
          contentHash: error.evidence?.contentHash,
        })
        if (error.failure !== MutationFailure.Unknown) return yield* Effect.fail(error)
      }),
    ),
  )
}

const verifyNoOpenProofOrder = (
  session: BrokerSessionShape,
  clientOrderId: string,
  state: ProofState,
): Effect.Effect<void, BrokerReadError | SandboxContractProofError> =>
  retryRead(session.read.orders({ status: OrderCollection.Open, limit: 500 })).pipe(
    Effect.flatMap((result) => {
      const residual = result.value.filter(
        (order) =>
          order.clientOrderId === clientOrderId ||
          (state.brokerOrderId !== undefined && order.brokerOrderId === state.brokerOrderId),
      )
      state.cleanup.residualOpenOrderCount = residual.length
      state.lifecycle.push({
        stage: 'OPEN_ORDER_VERIFICATION',
        observedAt: result.evidence.observedAt,
        status: residual.length,
        requestBinding: hashIdentity(result.evidence.requestId),
        contentHash: result.evidence.contentHash,
      })
      return residual.length === 0
        ? Effect.succeed(undefined)
        : Effect.fail(proofFailure('CLEANUP', 'RESIDUAL_OPEN_ORDER'))
    }),
  )

const cleanupOrder = (
  session: BrokerSessionShape,
  mutation: BrokerMutationShape,
  clientOrderId: string,
  state: ProofState,
): Effect.Effect<void, BrokerReadError | BrokerMutationError | SandboxContractProofError> => {
  const orderById = mutation.orderById
  const orderByClientId = mutation.orderByClientId
  if (orderById === undefined || orderByClientId === undefined) {
    return Effect.fail(proofFailure('CLEANUP', 'RECOVERY_LOOKUP_UNAVAILABLE'))
  }

  return Effect.gen(function* () {
    let brokerOrderId = state.brokerOrderId
    let observed: ReadResult<Order> | undefined

    if (brokerOrderId === undefined) {
      const lookup = yield* retryRead(orderByClientId(clientOrderId), true).pipe(
        Effect.map((result) => ({ _tag: 'Found' as const, result })),
        Effect.catch((error) => Effect.succeed({ _tag: 'Failed' as const, error })),
      )
      if (lookup._tag === 'Failed') {
        if (lookup.error.kind === BrokerReadErrorKind.NotFound && state.submitOutcome === 'REJECTED') {
          yield* verifyNoOpenProofOrder(session, clientOrderId, state)
          state.cleanup.result = 'CONFIRMED_NOT_CREATED'
          state.cleanup.verifiedAt = yield* currentUtcInstant
          return
        }
        if (lookup.error.kind === BrokerReadErrorKind.NotFound) {
          return yield* Effect.fail(proofFailure('CLEANUP', 'UNKNOWN_SUBMIT_NOT_RESOLVED'))
        }
        return yield* Effect.fail(lookup.error)
      }
      observed = lookup.result
      brokerOrderId = lookup.result.value.brokerOrderId
      state.brokerOrderId = brokerOrderId
      state.lifecycle.push(readEvidence('CLEANUP_LOOKUP_BY_CLIENT_ID', lookup.result))
    }

    if (observed === undefined) observed = yield* retryRead(orderById(brokerOrderId))
    yield* requireOrderBinding(
      observed.value,
      clientOrderId,
      brokerOrderId,
      state.acceptedOrderContractMismatch,
      'CLEANUP',
    )
    yield* cancelIfOpen(mutation, observed.value, state)
    const terminal = yield* waitForTerminalOrder(
      orderById,
      brokerOrderId,
      clientOrderId,
      state.acceptedOrderContractMismatch,
      state,
    )
    yield* verifyNoOpenProofOrder(session, clientOrderId, state)
    state.finalStatus = terminal.value.status
    state.cleanup.result = 'VERIFIED_TERMINAL'
    state.cleanup.verifiedAt = yield* currentUtcInstant
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        state.cleanup.result = 'FAILED'
        state.cleanupFailure = sanitizeFailure('CLEANUP', error)
      }),
    ),
  )
}

const recordSubmitFailure = (state: ProofState, error: BrokerMutationError): void => {
  state.submitOutcome = error.failure === MutationFailure.Rejected ? 'REJECTED' : 'UNKNOWN'
  if (error.brokerOrderId !== undefined) {
    state.brokerOrderId = error.brokerOrderId
    state.acceptedOrderContractMismatch = true
  }
}

test('treats every Alpaca nonterminal status as open for cleanup', () => {
  for (const status of Object.values(OrderStatus)) {
    expect(isOpenStatus(status)).toBe(!terminalOrderStatuses.has(status))
  }
  expect(isOpenStatus(OrderStatus.DoneForDay)).toBeTrue()
  expect(isOpenStatus(OrderStatus.Calculated)).toBeTrue()
  expect(isOpenStatus(OrderStatus.Stopped)).toBeTrue()
  expect(isOpenStatus(OrderStatus.Suspended)).toBeTrue()
})

test('keeps the cleanup network bound below its explicit deadline', () => {
  expect(maximumCleanupNetworkMs).toBeLessThan(cleanupDeadlineMs)
  expect(mutationPhaseDeadlineMs + cleanupDeadlineMs).toBeLessThan(15 * 60_000)
})

test('preserves typed session acquisition evidence in the sanitized failure', () => {
  const cause = new BrokerReadError({
    operation: 'account',
    kind: BrokerReadErrorKind.Authentication,
    message: 'Alpaca account request was rejected',
    retryable: false,
    status: 401,
  })
  const error = new BrokerSessionAcquisitionError({
    stage: BrokerSessionAcquisitionStage.Account,
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: 'not-in-receipt',
    cause,
  })

  expect(sanitizeFailure(failureStage(error), error)).toEqual({
    stage: 'SESSION_PREFLIGHT',
    tag: 'BrokerSessionAcquisitionError',
    failure: BrokerSessionAcquisitionStage.Account,
    acquisitionStage: BrokerSessionAcquisitionStage.Account,
    causeTag: 'BrokerReadError',
    causeFailure: BrokerReadErrorKind.Authentication,
    operation: 'account',
    status: 401,
    retryable: false,
  })
})

test('retains an accepted mismatched broker ID for exact cleanup', () => {
  const state: ProofState = {
    submitOutcome: 'NOT_ATTEMPTED',
    acceptedOrderContractMismatch: false,
    cancelAttempts: 0,
    cancelAcknowledged: false,
    lifecycle: [],
    cleanup: { result: 'NOT_RUN' },
  }
  recordSubmitFailure(
    state,
    new BrokerMutationError({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      message: 'accepted order did not match the request',
      brokerOrderId: '00000000-0000-4000-8000-000000000001',
    }),
  )

  expect(state.submitOutcome).toBe('UNKNOWN')
  expect(state.brokerOrderId).toBe('00000000-0000-4000-8000-000000000001')
  expect(state.acceptedOrderContractMismatch).toBeTrue()
})

test.skipIf(!enabled)('proves the bounded Alpaca sandbox contract through the production adapter', async () => {
  const expectedAccountId = required('BAYN_ALPACA_ACCOUNT_ID')
  const key = required('BAYN_ALPACA_KEY_ID')
  const secret = required('BAYN_ALPACA_SECRET_KEY')
  const configuredOrigin = required('BAYN_ALPACA_BASE_URL')
  const sourceSha = required('GITHUB_SHA')
  const runId = required('GITHUB_RUN_ID')
  const runAttempt = required('GITHUB_RUN_ATTEMPT')
  const imageIdentity = required('BAYN_ALPACA_SANDBOX_IMAGE_IDENTITY')
  const imageTag = required('BAYN_ALPACA_SANDBOX_IMAGE_TAG')
  const imageBuildRunId = required('BAYN_ALPACA_SANDBOX_IMAGE_BUILD_RUN_ID')

  if (configuredOrigin !== alpacaSandboxBaseUrl) throw new Error('sandbox endpoint guard failed')
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('GITHUB_SHA must be an exact lowercase commit SHA')
  if (!/^[0-9]+$/.test(imageBuildRunId)) throw new Error('image build run ID must be numeric')
  if (!/^registry\.ide-newton\.ts\.net\/lab\/bayn@sha256:[0-9a-f]{64}$/.test(imageIdentity)) {
    throw new Error('image identity must be the verified Bayn multi-architecture digest reference')
  }
  if (imageTag !== `registry.ide-newton.ts.net/lab/bayn:sha-${sourceSha}`) {
    throw new Error('image tag is not bound to the exact proof source SHA')
  }
  if (receiptPath === undefined || receiptPath !== '/tmp/alpaca-sandbox-contract-receipt.json') {
    throw new Error('BAYN_ALPACA_SANDBOX_RECEIPT_PATH must use the protected temporary receipt path')
  }

  const decoded = decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: configuredOrigin,
    expectedAccountId,
    key: Redacted.make(key),
    secret: Redacted.make(secret),
    proxyUrl: 'http://127.0.0.1:1',
    operationTimeoutMs: brokerOperationTimeoutMs,
    retryAttempts: 0,
  })
  if (Result.isFailure(decoded)) throw new Error('sandbox broker connection guard rejected the protected binding')
  const connection = decoded.success
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(References.MinimumLogLevel, 'None'),
        Effect.provide(NodeHttpClient.layerNodeHttp),
      ),
    )

  const identity = canonicalHashV1({ runId, runAttempt, sourceSha, imageIdentity })
  const clientOrderId = `b1_${identity.slice(0, 43)}`
  const intent: Intent = {
    schemaVersion: 'bayn.paper-intent.v3',
    intentId: canonicalHashV1({ identity, kind: 'intent' }),
    authorityGenerationHash: canonicalHashV1({ identity, kind: 'authority' }),
    riskDecisionId: canonicalHashV1({ identity, kind: 'risk' }),
    strategyName: 'alpaca-sandbox-contract-proof',
    cycleId: canonicalHashV1({ identity, kind: 'cycle' }),
    decisionHash: canonicalHashV1({ identity, kind: 'decision' }),
    policyHash: canonicalHashV1({ identity, kind: 'policy' }),
    accountId: expectedAccountId,
    clientOrderId,
    symbol: proofSymbol,
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: proofQuantityMicros,
    notionalLimitMicros: '5000000',
    state: IntentState.IoStarted,
    createdAt: await run(currentUtcInstant),
  }
  const state: ProofState = {
    submitOutcome: 'NOT_ATTEMPTED',
    acceptedOrderContractMismatch: false,
    cancelAttempts: 0,
    cancelAcknowledged: false,
    lifecycle: [],
    cleanup: { result: 'NOT_RUN' },
  }

  const proof = Effect.gen(function* () {
    state.startedAt = yield* currentUtcInstant
    const session = yield* acquireBrokerSession(connection)
    if (
      session.preflight.accountId !== expectedAccountId ||
      session.preflight.environment !== BrokerEnvironment.Sandbox ||
      session.preflight.baseUrl !== alpacaSandboxBaseUrl
    ) {
      return yield* Effect.fail(proofFailure('SESSION_PREFLIGHT', 'VERIFIED_SESSION_BINDING_MISMATCH'))
    }
    state.preflightCompletedAt = yield* currentUtcInstant

    const today = yield* currentUtcDate
    const clockObservedAt = yield* currentUtcInstant
    const calendar = yield* session.read.marketCalendar({ start: today, end: today })
    const marketOpen = calendar.value.sessions.some(
      (marketSession) => clockObservedAt >= marketSession.openAt && clockObservedAt < marketSession.closeAt,
    )
    if (marketOpen) return yield* Effect.fail(proofFailure('CLOCK_PREFLIGHT', 'REGULAR_MARKET_IS_OPEN'))
    state.clock = {
      observedAt: clockObservedAt,
      marketOpen: false,
      sessionCount: calendar.value.sessions.length,
      calendarHash: calendar.value.normalizedResponseHash,
    }

    const asset = yield* session.read.assetBySymbol(proofSymbol)
    if (asset.value.status !== AssetStatus.Active || !asset.value.tradable || !asset.value.fractionable) {
      return yield* Effect.fail(proofFailure('ASSET_PREFLIGHT', 'PROOF_ASSET_NOT_SAFE'))
    }
    state.asset = {
      status: AssetStatus.Active,
      tradable: true,
      fractionable: true,
      observationHash: asset.value.normalizedResponseHash,
    }

    const authority = makeExecutionAuthority(
      BrokerEnvironment.Sandbox,
      ExecutionAccess.SubmitOrders,
      disabledCapitalAccess,
    )
    const mutation = yield* makeMutation(session, authority)
    const orderByClientId = mutation.orderByClientId
    if (orderByClientId === undefined) {
      return yield* Effect.fail(proofFailure('CONFIGURATION', 'CLIENT_ORDER_LOOKUP_UNAVAILABLE'))
    }

    return yield* Effect.acquireUseRelease(
      Effect.succeed(undefined),
      () =>
        Effect.gen(function* () {
          const submit = yield* mutation.submit(intent).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                recordSubmitFailure(state, error)
              }),
            ),
          )
          state.submitOutcome = 'ACKNOWLEDGED'
          state.brokerOrderId = submit.order.brokerOrderId
          state.lifecycle.push(mutationEvidence('SUBMIT', submit.evidence))

          const recoveredSubmit = yield* retryRead(orderByClientId(clientOrderId), true)
          yield* requireOrderBinding(
            recoveredSubmit.value,
            clientOrderId,
            submit.order.brokerOrderId,
            false,
            'LOOKUP_BY_CLIENT_ID',
          )
          if (recoveredSubmit.value.quantityMicros !== proofQuantityMicros) {
            return yield* Effect.fail(proofFailure('LOOKUP_BY_CLIENT_ID', 'ORDER_QUANTITY_MISMATCH'))
          }
          state.lifecycle.push(readEvidence('LOOKUP_BY_CLIENT_ID', recoveredSubmit))
          yield* cancelIfOpen(mutation, recoveredSubmit.value, state)
        }).pipe(
          Effect.timeoutOrElse({
            duration: mutationPhaseDeadline,
            orElse: () => Effect.fail(proofFailure('SUBMIT', 'MUTATION_PHASE_DEADLINE_EXCEEDED')),
          }),
        ),
      () =>
        cleanupOrder(session, mutation, clientOrderId, state).pipe(
          Effect.timeoutOrElse({
            duration: cleanupDeadline,
            orElse: () => Effect.fail(proofFailure('CLEANUP', 'CLEANUP_DEADLINE_EXCEEDED')),
          }),
          Effect.tapError((error) =>
            Effect.sync(() => {
              state.cleanup.result = 'FAILED'
              state.cleanupFailure = sanitizeFailure('CLEANUP', error)
            }),
          ),
        ),
    )
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (state.failure === undefined) state.failure = sanitizeFailure(failureStage(error), error)
      }),
    ),
  )

  const proofExit = await run(Effect.exit(proof))
  state.completedAt = await run(currentUtcInstant)
  const receiptBody = {
    schemaVersion: 'bayn.alpaca-sandbox-contract-receipt.v2',
    proofStatus: Exit.isSuccess(proofExit) ? 'SUCCESS' : 'FAILURE',
    sourceSha,
    repository: required('GITHUB_REPOSITORY'),
    workflow: {
      runId,
      runAttempt,
    },
    image: {
      buildRunId: imageBuildRunId,
      tag: imageTag,
      identity: imageIdentity,
    },
    timestamps: {
      startedAt: state.startedAt,
      preflightCompletedAt: state.preflightCompletedAt,
      completedAt: state.completedAt,
    },
    endpointClass: 'ALPACA_PAPER',
    endpoint: alpacaSandboxBaseUrl,
    accountIdentityHash: hashIdentity(expectedAccountId),
    credentialBindingHash: canonicalHashV1({
      identity,
      endpoint: configuredOrigin,
      accountId: expectedAccountId,
      key,
      secret,
    }),
    preflight: {
      accountStatus: state.preflightCompletedAt === undefined ? undefined : 'ACTIVE',
      paperEnvironment: true,
      liveCapitalAccess: false,
      clock: state.clock,
      asset: state.asset,
    },
    order: {
      clientOrderId,
      brokerOrderIdentityHash: state.brokerOrderId === undefined ? undefined : hashIdentity(state.brokerOrderId),
      symbol: proofSymbol,
      quantityMicros: proofQuantityMicros,
      submitOutcome: state.submitOutcome,
      acceptedOrderContractMismatch: state.acceptedOrderContractMismatch,
      finalStatus: state.finalStatus,
    },
    orderLifecycle: state.lifecycle,
    cleanup: {
      ...state.cleanup,
      cancelAttempts: state.cancelAttempts,
      cancelAcknowledged: state.cancelAcknowledged,
    },
    duplicateSubmitCount: 0,
    liveEndpointUsed: false,
    failure: state.failure,
    cleanupFailure: state.cleanupFailure,
  }
  const receipt = { ...receiptBody, receiptHash: canonicalHashV1(receiptBody) }
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`
  if ([expectedAccountId, key, secret].some((sensitive) => serialized.includes(sensitive))) {
    throw new Error('sanitized receipt secret-leak guard failed')
  }
  await Bun.write(receiptPath, serialized)

  if (Exit.isFailure(proofExit)) {
    throw new Error('Alpaca sandbox contract proof failed; inspect the sanitized receipt artifact')
  }
  if (state.cleanup.result !== 'VERIFIED_TERMINAL' || state.cleanup.residualOpenOrderCount !== 0) {
    throw new Error('Alpaca sandbox cleanup was not proven terminal and residual-free')
  }
})
