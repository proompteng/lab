import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import type { ReadPreflight } from '../broker/alpaca'
import { AccountStatus } from '../broker/alpaca/model'
import { BrokerProvider } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import {
  makePaperActivationRequest,
  makeResearchPaperActivationRequest,
  makeResearchPaperPlanHash,
  researchPaperActivationRequestSchemaVersion,
  researchPaperPlanSchemaVersion,
  type PaperActivationRevisionBinding,
  type QualifiedPaperActivationRequest,
  type ResearchPaperActivationRequest,
} from '../execution/configuration'
import { Authority, makeCapitalGrantGenerationResult, type CapitalGrantGeneration } from '../execution/contracts'
import {
  bindQualifiedPaperGeneration,
  closedCycleReceiptEmissionAllowed,
  paperReceiptFinalizationWindowOpen,
  parseCurrentPaperActivation,
  parseResearchPaperPreflight,
  type PaperActivationRuntimeFacts,
} from './decisions'

const sha = (label: string): string => createHash('sha256').update(label).digest('hex')
const revision = (char: string): string => char.repeat(40)
const imageDigest = (label: string): string => `sha256:${sha(label)}`

const successOfResult = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(String(result.failure))
  return result.success
}

const activation: PaperActivationRevisionBinding = {
  sourceRevision: revision('a'),
  imageRepository: 'registry.example/bayn',
  imageDigest: imageDigest('activation-image'),
}

const strategy = {
  name: 'risk-balanced-trend',
  behaviorHash: sha('strategy-behavior'),
  parameterHash: sha('strategy-parameters'),
  parameterSchemaVersion: 'bayn.strategy-parameters.v1',
  protocolHash: sha('strategy-protocol'),
} as const

const sourceAuthorityGenerationHash = sha('observe-generation')
const accountId = 'paper-account'
const brokerIdentityHash = sha('broker-identity')
const riskPolicyHash = sha('paper-risk-policy')

const facts = (evidence: PaperActivationRuntimeFacts['evidence'] = null): PaperActivationRuntimeFacts => ({
  sourceAuthorityGenerationHash,
  build: activation,
  strategy,
  strategyProtocolHash: strategy.protocolHash,
  broker: {
    expectedAccountId: accountId,
    identityHash: brokerIdentityHash,
  },
  evidence,
})

const qualifiedRequest = (): QualifiedPaperActivationRequest =>
  successOfResult(
    makePaperActivationRequest({
      schemaVersion: 'bayn.paper-activation-request.v1',
      qualification: {
        runId: sha('qualification-run'),
        lockId: sha('qualification-lock'),
        resultHash: sha('qualification-result'),
        sourceRevision: revision('b'),
        imageRepository: 'registry.example/bayn-qualified',
        imageDigest: imageDigest('qualification-image'),
      },
      activation,
      strategy,
      limits: { maxOpenOrders: 0, maxPositions: 0 },
      cutoffAt: '2026-08-12T13:30:00.000Z',
      expiresAt: '2026-08-12T20:00:00.000Z',
    }),
  )

const researchRequest = (): ResearchPaperActivationRequest => {
  const material = {
    activation,
    strategy,
    broker: {
      environment: BrokerEnvironment.Sandbox,
      accountId,
      identityHash: brokerIdentityHash,
    },
    riskPolicyHash,
    limits: { maxOpenOrders: 0, maxPositions: 0 },
    cutoffAt: '2026-08-12T13:30:00.000Z',
    expiresAt: '2026-08-12T20:00:00.000Z',
    maximumCloseSessions: 3,
  } as const
  const planHash = successOfResult(
    makeResearchPaperPlanHash({ schemaVersion: researchPaperPlanSchemaVersion, ...material }),
  )
  return successOfResult(
    makeResearchPaperActivationRequest({
      schemaVersion: researchPaperActivationRequestSchemaVersion,
      grant: { _tag: 'Research', planHash },
      ...material,
    }),
  )
}

const generationFor = (request: QualifiedPaperActivationRequest): CapitalGrantGeneration =>
  successOfResult(
    makeCapitalGrantGenerationResult({
      schemaVersion: 'bayn.paper-authority-generation.v2',
      maximum: Authority.Paper,
      previousGenerationHash: sourceAuthorityGenerationHash,
      qualificationRunId: request.qualification.runId,
      qualificationLockId: request.qualification.lockId,
      qualificationResultHash: request.qualification.resultHash,
      protocolHash: request.strategy.protocolHash,
      qualificationExecutionPolicyHash: sha('qualification-execution-policy'),
      qualificationSourceRevision: request.qualification.sourceRevision,
      qualificationImageRepository: request.qualification.imageRepository,
      qualificationImageDigest: request.qualification.imageDigest,
      activationSourceRevision: activation.sourceRevision,
      activationImageRepository: activation.imageRepository,
      activationImageDigest: activation.imageDigest,
      strategyName: strategy.name,
      strategyBehaviorHash: strategy.behaviorHash,
      strategyParameterHash: strategy.parameterHash,
      strategyParameterSchemaVersion: strategy.parameterSchemaVersion,
      accountId,
      riskPolicyHash,
      proofPlanHash: sha('proof-plan'),
      reconciliationId: sha('reconciliation-id'),
      reconciliationContentHash: sha('reconciliation-content'),
    }),
  )

const preflightFor = (request: ResearchPaperActivationRequest): ReadPreflight => ({
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  baseUrl: 'https://paper-api.alpaca.markets',
  accountId: request.broker.accountId,
  accountStatus: AccountStatus.Active,
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  accountHash: sha('account'),
  fractionalTrading: true,
  accountConfigurationHash: sha('account-configuration'),
  positionCount: 0,
  positionsHash: sha('positions'),
  openOrderCount: 0,
  recentOrderCount: 0,
  ordersHash: sha('orders'),
  fillCount: 0,
  fillsHash: sha('fills'),
  marketCalendarSessionCount: 3,
  marketCalendarHash: sha('calendar'),
  orderById: 'NOT_FOUND',
  orderByClientId: 'NOT_FOUND',
})

describe('paper activation decisions', () => {
  test('parses a current research PAPER request into a durable current-request value', () => {
    const request = researchRequest()
    const parsed = parseCurrentPaperActivation({
      request,
      facts: facts(),
      observedAt: '2026-08-12T13:00:00.000Z',
    })

    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.request.requestHash).toBe(request.requestHash)
      expect(parsed.success.observedAt).toBe('2026-08-12T13:00:00.000Z')
    }
  })

  test('rejects current request parsing before callers can forget strategy drift', () => {
    const request = researchRequest()
    const driftedFacts: PaperActivationRuntimeFacts = {
      ...facts(),
      strategy: { ...strategy, parameterHash: sha('different-parameters') },
    }

    const parsed = parseCurrentPaperActivation({
      request,
      facts: driftedFacts,
      observedAt: '2026-08-12T13:00:00.000Z',
    })

    expect(Result.isFailure(parsed)).toBe(true)
    if (Result.isFailure(parsed)) {
      expect(parsed.failure).toBe('paper activation request strategy identity does not match the current strategy')
    }
  })

  test('binds a qualified PAPER generation into a typed request-generation pair', () => {
    const request = qualifiedRequest()
    const generation = generationFor(request)
    const bound = bindQualifiedPaperGeneration({ request, facts: facts(), generation })

    expect(Result.isSuccess(bound)).toBe(true)
    if (Result.isSuccess(bound)) {
      expect(bound.success.request.requestHash).toBe(request.requestHash)
      expect(bound.success.generation.generationHash).toBe(generation.generationHash)
    }
  })

  test('parses research preflight into a typed empty sandbox preflight proof', () => {
    const request = researchRequest()
    const parsed = parseResearchPaperPreflight({ request, preflight: preflightFor(request) })

    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.preflight.accountId).toBe(accountId)
    }
  })

  test('keeps receipt-window decisions in the pure PAPER domain', () => {
    expect(
      closedCycleReceiptEmissionAllowed({
        cutoffAt: '2026-08-12T13:30:00.000Z',
        observedAt: '2026-08-12T13:29:59.999Z',
      }),
    ).toBe(false)
    expect(
      closedCycleReceiptEmissionAllowed({
        cutoffAt: '2026-08-12T13:30:00.000Z',
        observedAt: '2026-08-12T13:30:00.000Z',
      }),
    ).toBe(true)
    expect(
      paperReceiptFinalizationWindowOpen({
        authorityExpiresAt: '2026-08-12T20:00:00.000Z',
        observedAt: '2026-08-12T20:15:00.000Z',
      }),
    ).toBe(true)
  })
})
