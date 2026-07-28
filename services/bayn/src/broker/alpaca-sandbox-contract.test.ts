import { expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Redacted, Result } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  BrokerEnvironment,
  ExecutionAccess,
  disabledCapitalAccess,
  makeExecutionAuthority,
} from '../execution/authority'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../paper'
import { BrokerMutationError, MutationFailure, makeMutation } from './alpaca-mutations'
import {
  BrokerProvider,
  OrderStatus,
  alpacaLiveBaseUrl,
  alpacaSandboxBaseUrl,
  acquireBrokerSession,
  decodeBrokerConnection,
} from './alpaca'

const enabled = Bun.env.BAYN_ALPACA_SANDBOX_CONTRACT === '1'
const receiptPath = Bun.env.BAYN_ALPACA_SANDBOX_RECEIPT_PATH

const required = (name: string): string => {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be present and free of surrounding whitespace`)
  }
  return value
}

const redact = (value: string): string => canonicalHashV1({ value }).slice(0, 16)

test.skipIf(!enabled)('proves the bounded Alpaca sandbox contract through the production adapter', async () => {
  const expectedAccountId = required('BAYN_ALPACA_ACCOUNT_ID')
  const key = required('BAYN_ALPACA_KEY_ID')
  const secret = required('BAYN_ALPACA_SECRET_KEY')
  const configuredOrigin = required('BAYN_ALPACA_BASE_URL')

  expect(configuredOrigin).toBe(alpacaSandboxBaseUrl)
  expect(configuredOrigin).not.toBe(alpacaLiveBaseUrl)

  const decoded = decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: configuredOrigin,
    expectedAccountId,
    key: Redacted.make(key),
    secret: Redacted.make(secret),
    // The credentialed CI proof supplies a direct Node client. This value remains
    // validated because it is part of the same production BrokerConnection.
    proxyUrl: 'http://127.0.0.1:1',
    operationTimeoutMs: 30_000,
    retryAttempts: 0,
  })
  if (Result.isFailure(decoded)) throw new Error(`sandbox connection rejected: ${decoded.failure._tag}`)
  const connection = decoded.success
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))

  // Acquisition performs the real account/configuration/read preflight before
  // mutation capability can exist. Account identifiers never enter the receipt.
  const session = await run(acquireBrokerSession(connection))
  expect(session.preflight.accountId).toBe(expectedAccountId)
  expect(session.preflight.environment).toBe(BrokerEnvironment.Sandbox)
  expect(session.preflight.baseUrl).toBe(alpacaSandboxBaseUrl)

  const authority = makeExecutionAuthority(
    BrokerEnvironment.Sandbox,
    ExecutionAccess.SubmitOrders,
    disabledCapitalAccess,
  )
  const mutation = await run(makeMutation(session, authority))
  const runId = required('GITHUB_RUN_ID')
  const runAttempt = required('GITHUB_RUN_ATTEMPT')
  const identity = canonicalHashV1({ runId, runAttempt, head: required('GITHUB_SHA') })
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
    symbol: 'AAPL',
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: '1',
    notionalLimitMicros: '1000000',
    state: IntentState.IoStarted,
    createdAt: new Date().toISOString(),
  }

  let brokerOrderId: string | undefined
  let submitStatus: OrderStatus | undefined
  let cancelStatus: OrderStatus | undefined
  let cleanupStatus = 'not-required'
  let submitEvidence: { readonly status: number; readonly request: string; readonly content: string } | undefined
  let cancelEvidence: { readonly status: number; readonly request: string; readonly content: string } | undefined

  try {
    const submit = await run(mutation.submit(intent))
    brokerOrderId = submit.order.brokerOrderId
    submitEvidence = {
      status: submit.evidence.status,
      request: redact(submit.evidence.requestId),
      content: submit.evidence.contentHash,
    }

    // Model the interruption window by discarding the acknowledged outcome and
    // recovering solely from the deterministic client ID. No second POST occurs.
    const recoveredSubmit = await run(mutation.orderByClientId!(clientOrderId))
    expect(recoveredSubmit.value.brokerOrderId).toBe(brokerOrderId)
    expect(recoveredSubmit.value.clientOrderId).toBe(clientOrderId)
    expect(recoveredSubmit.value.quantityMicros).toBe('1')
    submitStatus = recoveredSubmit.value.status

    try {
      const cancel = await run(mutation.cancel(brokerOrderId))
      cancelEvidence = {
        status: cancel.evidence.status,
        request: redact(cancel.evidence.requestId),
        content: cancel.evidence.contentHash,
      }
    } catch (cause) {
      if (!(cause instanceof BrokerMutationError) || cause.failure !== MutationFailure.Unknown) throw cause
    }

    // Both a lost 204 and an ambiguous DELETE are recovered by the same GET path.
    const recoveredCancel = await run(mutation.orderById!(brokerOrderId))
    expect(recoveredCancel.value.brokerOrderId).toBe(brokerOrderId)
    cancelStatus = recoveredCancel.value.status
    expect([OrderStatus.Canceled, OrderStatus.Filled, OrderStatus.PendingCancel]).toContain(cancelStatus)

    const fills = await run(session.read.fillActivities({ pageSize: 100 }))
    const matchingFills = fills.value.items.filter((fill) => fill.brokerOrderId === brokerOrderId)
    for (const fill of matchingFills) expect(fill.brokerOrderId).toBe(brokerOrderId)
  } finally {
    if (brokerOrderId === undefined) {
      try {
        const recovered = await run(mutation.orderByClientId!(clientOrderId))
        brokerOrderId = recovered.value.brokerOrderId
        cleanupStatus = 'recovered-after-submit-failure'
      } catch {
        cleanupStatus = 'no-order-found-after-submit-failure'
      }
    }
    if (brokerOrderId !== undefined) {
      try {
        await run(mutation.cancel(brokerOrderId))
        cleanupStatus = 'cancel-acknowledged'
      } catch {
        const observed = await run(mutation.orderById!(brokerOrderId))
        cleanupStatus = `idempotent-${observed.value.status.toLowerCase()}`
      }
    }
  }

  const receipt = {
    schemaVersion: 'bayn.alpaca-sandbox-contract-receipt.v1',
    head: required('GITHUB_SHA'),
    endpoint: alpacaSandboxBaseUrl,
    accountBinding: redact(session.preflight.accountHash),
    preflight: {
      accountStatus: session.preflight.accountStatus,
      accountBlocked: session.preflight.accountBlocked,
      tradingBlocked: session.preflight.tradingBlocked,
      readLookups: [session.preflight.orderById, session.preflight.orderByClientId],
    },
    order: {
      clientOrderBinding: redact(clientOrderId),
      brokerOrderBinding: brokerOrderId === undefined ? undefined : redact(brokerOrderId),
      quantityMicros: '1',
      submitStatus,
      cancelStatus,
    },
    evidence: { submit: submitEvidence, cancel: cancelEvidence },
    cleanup: cleanupStatus,
    duplicateSubmitCount: 0,
    liveEndpointUsed: false,
    residualOmissions: [
      'Alpaca cannot deterministically inject a lost POST or DELETE response; real acknowledgement-loss recovery is represented by discarding the acknowledgement before production GET recovery.',
      'A fill is decoded and reconciled only if the minimum fractional market order fills before cancellation.',
    ],
  }
  expect(JSON.stringify(receipt)).not.toContain(expectedAccountId)
  expect(JSON.stringify(receipt)).not.toContain(key)
  expect(JSON.stringify(receipt)).not.toContain(secret)
  if (receiptPath === undefined) throw new Error('BAYN_ALPACA_SANDBOX_RECEIPT_PATH is required')
  await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
})
