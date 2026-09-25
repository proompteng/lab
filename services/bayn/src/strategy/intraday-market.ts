import { Schema } from 'effect'

import type { ExecutionModel } from '../execution-model-contract'
import { sha256 } from '../hash'
import {
  MarketFeatureContract,
  MarketFeatureDefinition,
  marketFeatureClockSkewAllowanceMs,
  rollingFeatureDefinitionMaterial,
} from '../market-data/features/contract'
import { kafkaBootstrapDeadlineMs, KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { defaultExecutionModel } from './execution-model/model'

export const intradayUniverse = {
  id: 'torghut-core-equity-v2',
  symbols: [
    'AAPL',
    'AMD',
    'AMZN',
    'AVGO',
    'COHR',
    'CRDO',
    'IWM',
    'LITE',
    'MRVL',
    'MU',
    'NVDA',
    'QQQ',
    'SMH',
    'SNDK',
    'SPY',
    'WDC',
  ],
  symbolHash: '12d8e7ad3e0087e85c39f47896e77adde6bb8e029724a70aae1ef5fd393bddf1',
} as const

export const intradaySourceTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
} as const)

export const intradayExecutionModel: Extract<ExecutionModel, { readonly schemaVersion: 'bayn.execution-model.v5' }> =
  Object.freeze({
    ...defaultExecutionModel,
    schemaVersion: 'bayn.execution-model.v5',
    order: Object.freeze({
      type: 'limit',
      timeInForce: 'ioc',
      extendedHours: false,
      planAfter: 'verified-intraday-window',
      submitAfter: 'plan-committed',
      submitBefore: 'intraday-entry-cutoff',
      planningPriceReference: 'verified-adverse-top-of-book',
      planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
      fillPriceReference: 'limit-or-better',
      buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
      warmupAfterOpenMs: 0,
      submissionCutoffBeforeCloseMs: 5 * 60_000,
    }),
    precision: Object.freeze({
      ...defaultExecutionModel.precision,
      quantityIncrementMicros: '1000000',
    }),
  })

export const intradayFeatureTopic = 'torghut.market-features.v1' as const
export const intradayStreamingContract = Object.freeze({
  schemaVersion: 'bayn.streaming-strategy-input.v1',
  snapshotSchemaVersion: 'bayn.streaming-market-snapshot.v1',
  featureTopic: intradayFeatureTopic,
  featureSchemaVersion: MarketFeatureContract.V1,
  requiredDefinitionId: MarketFeatureDefinition.RollingPrice30m,
  requiredDefinitionHash: sha256(JSON.stringify(rollingFeatureDefinitionMaterial)),
  clockSkewAllowanceMs: marketFeatureClockSkewAllowanceMs,
  bootstrapTimestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  bootstrapDeadlineMs: kafkaBootstrapDeadlineMs,
  freshness: 'exact-completed-window-and-matching-raw-inputs',
} as const)
export const IntradayStreamingInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(intradayStreamingContract.schemaVersion),
  snapshotSchemaVersion: Schema.Literal(intradayStreamingContract.snapshotSchemaVersion),
  featureTopic: Schema.Literal(intradayFeatureTopic),
  featureSchemaVersion: Schema.Literal(MarketFeatureContract.V1),
  requiredDefinitionId: Schema.Literal(MarketFeatureDefinition.RollingPrice30m),
  requiredDefinitionHash: Schema.Literal(intradayStreamingContract.requiredDefinitionHash),
  clockSkewAllowanceMs: Schema.Literal(marketFeatureClockSkewAllowanceMs),
  bootstrapTimestampPolicy: Schema.Literal(KafkaBootstrapTimestampPolicy.ProducerClock),
  bootstrapDeadlineMs: Schema.Literal(kafkaBootstrapDeadlineMs),
  freshness: Schema.Literal(intradayStreamingContract.freshness),
})
