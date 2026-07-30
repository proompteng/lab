import { Result, Schema } from 'effect'

import { AccountStatus, AssetClass, AssetExchange, AssetStatus } from '../broker/alpaca'
import { Authority, OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { DiscoveryReceiptSchema, type ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery/model'
import { canonicalHashV1OrThrow } from '../hash'
import { strictParseOptions } from '../schemas'

export interface ExecutionPrepareDiscoveryFixtureInput {
  readonly sourceRevision: ExecutionCandidateDiscoveryReceipt['binding']['runtime']['sourceRevision']
  readonly imageRepository: ExecutionCandidateDiscoveryReceipt['binding']['runtime']['image']['repository']
  readonly imageDigest: ExecutionCandidateDiscoveryReceipt['binding']['runtime']['image']['digest']
  readonly strategy: ExecutionCandidateDiscoveryReceipt['binding']['runtime']['strategy']
  readonly strategyProtocolHash: string
  readonly qualificationRunId: string
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly policyHash: string
  readonly reconciliationId: string
  readonly reconciliationContentHash: string
  readonly cycleId?: string
  readonly decisionHash?: string
  readonly observedPlanIntentId?: string
}

const hash = (label: string): string => canonicalHashV1OrThrow({ executionPrepareFixture: label })
const observedAt = '2099-07-24T12:00:00.000Z'

export const makeExecutionPrepareDiscoveryReceiptFixture = (
  input: ExecutionPrepareDiscoveryFixtureInput,
): ExecutionCandidateDiscoveryReceipt => {
  const cycleId = input.cycleId ?? hash('cycle')
  const decisionHash = input.decisionHash ?? hash('decision')
  const observedPlanIntentId = input.observedPlanIntentId ?? hash('observed-plan-intent')
  const binding = {
    schemaVersion: 'bayn.paper-candidate-discovery-binding.v1' as const,
    runtime: {
      sourceRevision: input.sourceRevision,
      image: { repository: input.imageRepository, digest: input.imageDigest },
      strategy: input.strategy,
      strategyProtocolHash: input.strategyProtocolHash,
      qualificationRunId: input.qualificationRunId,
      accountId: input.accountId,
      authorityGenerationHash: input.authorityGenerationHash,
      policyHash: input.policyHash,
    },
    cycle: {
      cycleId,
      signalSessionDate: '2099-07-23',
      executionSessionDate: '2099-07-24',
      snapshotId: hash('snapshot'),
      decisionHash,
      submissionCutoffAt: '2099-07-24T13:15:00.000Z',
      terminalAt: '2099-07-23T20:10:00.000Z',
    },
    document: {
      contentHash: hash('document'),
      snapshotContentHash: hash('snapshot-content'),
      snapshotFinalizedAt: '2099-07-23T20:01:00.000Z',
      strategyDecisionHash: hash('strategy-decision'),
      policyHash: input.policyHash,
      planningBrokerStateHash: hash('planning-broker-state'),
      reconciliationId: input.reconciliationId,
      reconciliationHash: input.reconciliationContentHash,
      targetPlanInputHash: hash('target-plan-input'),
      targetPlanOutputHash: hash('target-plan-output'),
      createdAt: '2099-07-23T20:05:00.000Z',
      expiresAt: '2099-07-24T13:15:00.000Z',
    },
  }
  const immutableBindingHash = canonicalHashV1OrThrow(binding)
  const requestHash = hash('asset-request')
  const normalizedResponseHash = hash('asset-response')
  const candidateFacts = {
    schemaVersion: 'bayn.paper-candidate-facts.v1' as const,
    immutableBindingHash,
    account: {
      id: input.accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: '1000000000',
      equityMicros: '2000000000',
      buyingPowerMicros: '1000000000',
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
    },
    accountConfiguration: {
      schemaVersion: 'bayn.alpaca-account-configuration-observation.v1' as const,
      source: 'alpaca-v2-account-configurations' as const,
      requestHash: hash('account-configuration-request'),
      fractionalTrading: true,
      normalizedResponseHash: hash('account-configuration-response'),
    },
    candidates: [
      {
        ordinal: 0,
        observedPlanIntentId,
        symbol: 'SPY',
        side: OrderSide.Buy,
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
        observedPlannedQuantityMicros: '1000000',
        observedReferencePriceMicros: '500000000',
        observedNotionalLimitMicros: '500000000',
        observedEvaluatedOrderNotionalMicros: '500000000',
        observedTargetWeight: 0.5,
        observedCurrentQuantityMicros: '0',
        observedTargetQuantityMicros: '1000000',
        observedRiskDecisionId: hash('risk-decision'),
        observedRiskInputHash: hash('risk-input'),
        asset: {
          schemaVersion: 'bayn.alpaca-asset-observation.v1' as const,
          source: 'alpaca-v2-asset' as const,
          requestedSymbol: 'SPY',
          requestHash,
          assetId: 'fixture-spy-asset',
          symbol: 'SPY',
          assetClass: AssetClass.UsEquity,
          exchange: AssetExchange.Arca,
          status: AssetStatus.Active,
          tradable: true,
          fractionable: true,
          attributes: [],
          normalizedResponseHash,
        },
        assetEligibility: { eligible: true, reasons: [] },
        fractionalTradingEligible: true,
      },
    ],
    consistencyDelayMs: { status: 'REQUIRED_UNBOUND' as const },
  }
  const candidateFactsHash = canonicalHashV1OrThrow(candidateFacts)
  const material = {
    schemaVersion: 'bayn.paper-candidate-discovery.v2' as const,
    operation: 'PAPER_CANDIDATE_DISCOVERY' as const,
    authority: Authority.Observe,
    dispatchable: false as const,
    binding,
    immutableBindingHash,
    candidateFacts,
    candidateFactsHash,
    observations: {
      account: {
        value: {
          id: input.accountId,
          status: AccountStatus.Active,
          currency: 'USD' as const,
          cashMicros: '1000000000',
          equityMicros: '2000000000',
          lastEquityMicros: '2000000000',
          buyingPowerMicros: '1000000000',
          accountBlocked: false,
          tradingBlocked: false,
          tradeSuspendedByUser: false,
          observedAt,
        },
        evidence: {
          requestId: 'fixture-account-request',
          status: 200,
          contentHash: hash('account-evidence'),
          observedAt,
        },
      },
      accountConfiguration: {
        value: {
          schemaVersion: 'bayn.alpaca-account-configuration-observation.v1' as const,
          source: 'alpaca-v2-account-configurations' as const,
          requestHash: candidateFacts.accountConfiguration.requestHash,
          fractionalTrading: true,
          observedAt,
          normalizedResponseHash: candidateFacts.accountConfiguration.normalizedResponseHash,
        },
        evidence: {
          requestId: 'fixture-account-configuration-request',
          status: 200,
          contentHash: hash('account-configuration-evidence'),
          observedAt,
        },
      },
      assets: [
        {
          ordinal: 0,
          value: {
            schemaVersion: 'bayn.alpaca-asset-observation.v1' as const,
            source: 'alpaca-v2-asset' as const,
            requestedSymbol: 'SPY',
            requestHash,
            assetId: 'fixture-spy-asset',
            symbol: 'SPY',
            assetClass: AssetClass.UsEquity,
            exchange: AssetExchange.Arca,
            status: AssetStatus.Active,
            tradable: true,
            fractionable: true,
            attributes: [],
            observedAt,
            normalizedResponseHash,
          },
          evidence: {
            requestId: 'fixture-asset-request',
            status: 200,
            contentHash: hash('asset-evidence'),
            observedAt,
          },
        },
      ],
    },
    capturedAt: observedAt,
    observationReceiptSchemaVersion: 'bayn.paper-candidate-observation-receipt.v1' as const,
  }
  const receipt = {
    ...material,
    observationReceiptHash: canonicalHashV1OrThrow(material),
  }
  return Result.getOrThrow(Schema.decodeUnknownResult(DiscoveryReceiptSchema, strictParseOptions)(receipt))
}
