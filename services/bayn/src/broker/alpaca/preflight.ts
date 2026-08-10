import { Data, Effect, Result } from 'effect'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { addUtcDays, currentUtcDate } from '../../time'
import type { BrokerConnection } from '../connection'
import {
  BrokerReadError,
  BrokerReadErrorKind,
  contractFailure,
  invalidResponse,
  safeCause,
  type BrokerReadContractFailure,
} from './failures'
import {
  AccountStatus,
  OrderCollection,
  SortDirection,
  marketCalendarPreflightRangeDays,
  readPreflightTimeoutMs,
  type Account,
  type AccountConfigurationObservation,
  type BrokerReadShape,
  type Order,
  type ReadPreflight,
  type ReadResult,
} from './model'
import { Pipeable } from '../../pipeable'

const missingOrderId = '00000000-0000-4000-8000-000000000000'
const missingClientOrderId = 'bayn-observe-read-proof-does-not-exist'

export type BrokerAccountPreflightFailure =
  | {
      readonly _tag: 'BrokerAccountNotActive'
      readonly status: AccountStatus
    }
  | {
      readonly _tag: 'BrokerAccountBlocked'
    }
  | {
      readonly _tag: 'BrokerTradingBlocked'
    }
  | {
      readonly _tag: 'BrokerTradingSuspendedByUser'
    }
  | {
      readonly _tag: 'BrokerFractionalTradingDisabled'
    }

export interface VerifiedBrokerAccountPermissions {
  readonly accountStatus: AccountStatus.Active
  readonly accountBlocked: false
  readonly tradingBlocked: false
  readonly tradeSuspendedByUser: false
  readonly fractionalTrading: true
}

export class BrokerAccountPreflightError extends Data.TaggedError('BrokerAccountPreflightError')<{
  readonly provider: BrokerConnection['provider']
  readonly environment: BrokerConnection['environment']
  readonly baseUrl: string
  readonly expectedAccountId: string
  readonly failure: BrokerAccountPreflightFailure
}> {}

const verifyBrokerAccountPermissionsDataFirst = (
  account: Account,
  configuration: AccountConfigurationObservation,
): Result.Result<VerifiedBrokerAccountPermissions, BrokerAccountPreflightFailure> => {
  if (account.status !== AccountStatus.Active) {
    return Result.fail({ _tag: 'BrokerAccountNotActive', status: account.status })
  }
  if (account.accountBlocked) return Result.fail({ _tag: 'BrokerAccountBlocked' })
  if (account.tradingBlocked) return Result.fail({ _tag: 'BrokerTradingBlocked' })
  if (account.tradeSuspendedByUser) return Result.fail({ _tag: 'BrokerTradingSuspendedByUser' })
  if (!configuration.fractionalTrading) return Result.fail({ _tag: 'BrokerFractionalTradingDisabled' })
  return Result.succeed({
    accountStatus: AccountStatus.Active,
    accountBlocked: false,
    tradingBlocked: false,
    tradeSuspendedByUser: false,
    fractionalTrading: true,
  })
}

export const verifyBrokerAccountPermissions = Pipeable.dual(2, verifyBrokerAccountPermissionsDataFirst)

const permissionFailure = (
  connection: BrokerConnection,
  failure: BrokerAccountPreflightFailure,
): BrokerAccountPreflightError =>
  new BrokerAccountPreflightError({
    provider: connection.provider,
    environment: connection.environment,
    baseUrl: connection.baseUrl,
    expectedAccountId: connection.expectedAccountId,
    failure,
  })

const proofHashResult = (value: unknown, field: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.mapError(canonicalHashV1Result(value), (failure) =>
    contractFailure('CANONICAL_HASH', `${field} is not canonical JSON: ${renderCanonicalJsonFailure(failure)}`, {
      field,
      actual: failure.path,
    }),
  )

const expectNotFound = (
  operation: 'order-by-id' | 'order-by-client-id',
  read: Effect.Effect<ReadResult<Order>, BrokerReadError>,
): Effect.Effect<'NOT_FOUND', BrokerReadError> =>
  read.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error.kind === BrokerReadErrorKind.NotFound ? Effect.succeed('NOT_FOUND' as const) : Effect.fail(error),
      onSuccess: (result) =>
        Effect.fail(
          invalidResponse(
            operation,
            `Alpaca ${operation} unexpectedly resolved the observe-only proof identity`,
            result.evidence,
            result.value,
          ),
        ),
    }),
  )

const verifyOrderLookup = (
  operation: 'order-by-id' | 'order-by-client-id',
  expected: Order,
  read: Effect.Effect<ReadResult<Order>, BrokerReadError>,
): Effect.Effect<'MATCHED', BrokerReadError> =>
  read.pipe(
    Effect.flatMap((result) =>
      result.value.brokerOrderId === expected.brokerOrderId && result.value.clientOrderId === expected.clientOrderId
        ? Effect.succeed('MATCHED' as const)
        : Effect.fail(
            invalidResponse(
              operation,
              `Alpaca ${operation} returned a different order during observe-only preflight`,
              result.evidence,
              result.value,
            ),
          ),
    ),
  )

const verifyReadAccessDataFirst = (
  connection: BrokerConnection,
  read: BrokerReadShape,
): Effect.Effect<ReadPreflight, BrokerReadError | BrokerAccountPreflightError> =>
  Effect.gen(function* () {
    const account = yield* read.account
    const accountConfiguration = yield* read.accountConfiguration
    const permissions = yield* Effect.fromResult(
      verifyBrokerAccountPermissions(account.value, accountConfiguration.value),
    ).pipe(Effect.mapError((failure) => permissionFailure(connection, failure)))
    const calendarStart = yield* currentUtcDate
    const calendarEnd = addUtcDays(calendarStart, marketCalendarPreflightRangeDays - 1)
    const responses = yield* Effect.all(
      {
        positions: read.positions,
        openOrders: read.orders({ status: OrderCollection.Open, limit: 1 }),
        recentOrders: read.orders({
          status: OrderCollection.All,
          limit: 1,
          direction: SortDirection.Descending,
        }),
        fills: read.fillActivities({ pageSize: 1, direction: SortDirection.Descending }),
        marketCalendar: read.marketCalendar({ start: calendarStart, end: calendarEnd }),
      },
      { concurrency: 5 },
    )
    const order = responses.recentOrders.value[0] ?? responses.openOrders.value[0]
    const lookups =
      order === undefined
        ? yield* Effect.all({
            orderById: expectNotFound('order-by-id', read.orderById(missingOrderId)),
            orderByClientId: expectNotFound('order-by-client-id', read.orderByClientId(missingClientOrderId)),
          })
        : yield* Effect.all({
            orderById: verifyOrderLookup('order-by-id', order, read.orderById(order.brokerOrderId)),
            orderByClientId: verifyOrderLookup('order-by-client-id', order, read.orderByClientId(order.clientOrderId)),
          })
    const proof = yield* Effect.fromResult(
      Result.gen(function* (): Generator<Result.Result<unknown, BrokerReadContractFailure>, ReadPreflight, never> {
        const accountHash = yield* proofHashResult(account.value, 'preflight account')
        const accountConfigurationHash = yield* proofHashResult(
          accountConfiguration.value,
          'preflight account configuration',
        )
        const positionsHash = yield* proofHashResult(responses.positions.value, 'preflight positions')
        const ordersHash = yield* proofHashResult(
          { open: responses.openOrders.value, recent: responses.recentOrders.value },
          'preflight orders',
        )
        const fillsHash = yield* proofHashResult(responses.fills.value.items, 'preflight fills')
        return {
          provider: connection.provider,
          environment: connection.environment,
          baseUrl: connection.baseUrl,
          accountId: account.value.id,
          ...permissions,
          accountHash,
          accountConfigurationHash,
          positionCount: responses.positions.value.length,
          positionsHash,
          openOrderCount: responses.openOrders.value.length,
          recentOrderCount: responses.recentOrders.value.length,
          ordersHash,
          fillCount: responses.fills.value.items.length,
          fillsHash,
          marketCalendarSessionCount: responses.marketCalendar.value.sessions.length,
          marketCalendarHash: responses.marketCalendar.value.normalizedResponseHash,
          ...lookups,
        }
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BrokerReadError({
            operation: 'preflight',
            kind: BrokerReadErrorKind.InvalidResponse,
            message: 'Alpaca observe-only preflight data is not canonical JSON',
            retryable: false,
            cause: safeCause(cause),
          }),
      ),
    )
    yield* Effect.logInfo('Alpaca observe-only read preflight passed').pipe(
      Effect.annotateLogs({
        provider: proof.provider,
        environment: proof.environment,
        baseUrl: proof.baseUrl,
        accountStatus: proof.accountStatus,
        accountBlocked: proof.accountBlocked,
        tradingBlocked: proof.tradingBlocked,
        tradeSuspendedByUser: proof.tradeSuspendedByUser,
        fractionalTrading: proof.fractionalTrading,
        accountHash: proof.accountHash,
        accountConfigurationHash: proof.accountConfigurationHash,
        positionCount: proof.positionCount,
        positionsHash: proof.positionsHash,
        openOrderCount: proof.openOrderCount,
        recentOrderCount: proof.recentOrderCount,
        ordersHash: proof.ordersHash,
        fillCount: proof.fillCount,
        fillsHash: proof.fillsHash,
        marketCalendarSessionCount: proof.marketCalendarSessionCount,
        marketCalendarHash: proof.marketCalendarHash,
        orderById: proof.orderById,
        orderByClientId: proof.orderByClientId,
      }),
    )
    return proof
  }).pipe(
    Effect.timeoutOrElse({
      duration: readPreflightTimeoutMs,
      orElse: () =>
        Effect.fail(
          new BrokerReadError({
            operation: 'preflight',
            kind: BrokerReadErrorKind.Timeout,
            message: `Alpaca observe-only read preflight exceeded its ${readPreflightTimeoutMs}ms startup deadline`,
            retryable: true,
          }),
        ),
    }),
    Effect.withLogSpan('broker.read.preflight'),
  )

export const verifyReadAccess = Pipeable.dual(2, verifyReadAccessDataFirst)
