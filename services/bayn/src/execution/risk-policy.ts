import { Effect, Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'

import { BrokerEnvironment } from '../broker/identity'
import { BrokerMode, PolicySchema, executionRiskPolicySchemaVersion } from '../risk'
import { strictParseOptions } from '../schemas'
import { OrderType, TimeInForce } from './contracts'
import { OperationalError, operationalError } from '../errors'
import { CycleExecutionModelSchema } from '../execution-model-contract'
import { loadStrategyTradingProtocol, type StrategyRuntime } from '../strategy'

const dollarsToMicros = (dollars: bigint): string => (dollars * 1_000_000n).toString()

const observeRiskLimits = {
  maxOrderNotionalMicros: dollarsToMicros(40_000n),
  maxSymbolExposureMicros: dollarsToMicros(40_000n),
  maxGrossExposureMicros: dollarsToMicros(100_000n),
  maxNetExposureMicros: dollarsToMicros(100_000n),
  maxDailyTradedNotionalMicros: dollarsToMicros(200_000n),
  maxDailyLossMicros: dollarsToMicros(5_000n),
  maxDrawdownMicros: dollarsToMicros(5_000n),
  maxIntentAgeMs: 300_000,
  maxBrokerStateAgeMs: 300_000,
  maxMarketDataAgeMs: 300_000,
  maxAdverseSlippageBps: 10,
  decisionTtlMs: 300_000,
} as const

const executionRiskLimits = (brokerEnvironment: BrokerEnvironment) => ({
  ...observeRiskLimits,
  maxDailyTradedNotionalMicros:
    brokerEnvironment === BrokerEnvironment.Sandbox
      ? dollarsToMicros(1_000_000n)
      : observeRiskLimits.maxDailyTradedNotionalMicros,
  maxDrawdownMicros:
    brokerEnvironment === BrokerEnvironment.Sandbox ? dollarsToMicros(10_000n) : observeRiskLimits.maxDrawdownMicros,
})

export const makeExecutionRiskPolicy = (
  accountId: string,
  allowedSymbols: readonly string[],
  brokerEnvironment: BrokerEnvironment = BrokerEnvironment.Live,
) =>
  Schema.decodeUnknownResult(
    PolicySchema,
    strictParseOptions,
  )({
    schemaVersion: executionRiskPolicySchemaVersion,
    accountId,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: [...allowedSymbols].sort(),
    allowedOrderTypes: [OrderType.Limit, OrderType.StopLimit],
    allowedTimeInForce: [TimeInForce.Day, TimeInForce.GoodUntilCanceled, TimeInForce.ImmediateOrCancel],
    maxOpenOrders: allowedSymbols.length,
    ...executionRiskLimits(brokerEnvironment),
  })

export const approvedExecutionRiskPolicyHashes = (accountId: string, allowedSymbols: readonly string[]) =>
  Result.all(
    [BrokerEnvironment.Live, BrokerEnvironment.Sandbox].map((environment) =>
      Result.flatMap(makeExecutionRiskPolicy(accountId, allowedSymbols, environment), canonicalHashV1Result),
    ),
  )

export const decodeStrategyExecutionModel = (strategy: StrategyRuntime) =>
  Result.mapError(
    loadStrategyTradingProtocol(strategy).pipe(
      Result.flatMap((protocol) =>
        Schema.decodeUnknownResult(CycleExecutionModelSchema, strictParseOptions)(protocol.executionModel),
      ),
    ),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'strategy execution model is invalid',
        cause,
      }),
  )

export const loadStrategyExecutionRiskPolicy = (
  accountId: string,
  strategy: StrategyRuntime,
  brokerEnvironment: BrokerEnvironment = BrokerEnvironment.Live,
  riskPolicyHash?: string,
) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(decodeStrategyExecutionModel(strategy))
    const symbols = (yield* Effect.fromResult(loadStrategyTradingProtocol(strategy))).universe
    const retainedPolicy = yield* Effect.fromResult(makeExecutionRiskPolicy(accountId, symbols))
    if (
      riskPolicyHash === undefined ||
      riskPolicyHash === (yield* Effect.fromResult(canonicalHashV1Result(retainedPolicy)))
    )
      return retainedPolicy
    if (brokerEnvironment === BrokerEnvironment.Sandbox) {
      const paperPolicy = yield* Effect.fromResult(
        makeExecutionRiskPolicy(accountId, symbols, BrokerEnvironment.Sandbox),
      )
      if (riskPolicyHash === (yield* Effect.fromResult(canonicalHashV1Result(paperPolicy)))) return paperPolicy
    }
    return yield* operationalError({
      component: 'strategy',
      operation: 'risk-policy',
      message: 'bound execution risk policy is not approved for this broker environment',
    })
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OperationalError
        ? cause
        : operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled execution risk policy is invalid',
            cause,
          }),
    ),
  )
