import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'

import { BrokerEnvironment } from '../broker/identity'
import { BrokerMode, PolicySchema, executionRiskPolicySchemaVersion } from '../risk'
import { strictParseOptions } from '../schemas'
import { OrderType, TimeInForce } from './contracts'
import { OperationalError, operationalError } from '../errors'
import { strategyTradingProtocol, type StrategyRuntime } from '../strategy'

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

export const strategyExecutionRiskPolicy = (
  accountId: string,
  strategy: StrategyRuntime,
  brokerEnvironment: BrokerEnvironment = BrokerEnvironment.Live,
  riskPolicyHash?: string,
) =>
  Result.gen(function* () {
    const symbols = strategyTradingProtocol(strategy).universe
    const retainedPolicy = yield* makeExecutionRiskPolicy(accountId, symbols)
    if (riskPolicyHash === undefined || riskPolicyHash === (yield* canonicalHashV1Result(retainedPolicy)))
      return retainedPolicy
    if (brokerEnvironment === BrokerEnvironment.Sandbox) {
      const paperPolicy = yield* makeExecutionRiskPolicy(accountId, symbols, BrokerEnvironment.Sandbox)
      if (riskPolicyHash === (yield* canonicalHashV1Result(paperPolicy))) return paperPolicy
    }
    return yield* Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'risk-policy',
        message: 'bound execution risk policy is not approved for this broker environment',
      }),
    )
  }).pipe(
    Result.mapError((cause) =>
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
