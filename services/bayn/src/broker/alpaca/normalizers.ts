import { DateTime, Result } from 'effect'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { contractFailure, type BrokerReadContractFailure } from './failures'
import {
  AccountConfigurationResponseSchema,
  AccountResponseSchema,
  AssetClass,
  AssetResponseSchema,
  FillActivityResponseSchema,
  I128_MAX,
  I128_MIN,
  MarketCalendarQueryBase,
  MarketCalendarResponseSchema,
  OrderClass,
  OrderResponseSchema,
  OrderType,
  PositionResponseSchema,
  PositionSide,
  TradeActivityType,
  U128_MAX,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  assetObservationSchemaVersion,
  assetObservationSource,
  marketCalendarSchemaVersion,
  marketCalendarSource,
  marketCalendarTimeZone,
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type FillActivity,
  type MarketCalendarObservation,
  type MarketCalendarSession,
  type Order,
  type Position,
} from './model'
import { accountConfigurationRequestMaterial, assetRequestMaterial } from './requests'

const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$|^-[1-9][0-9]*(?:\.[0-9]+)?$/

const hashResult = (value: unknown, field: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.mapError(canonicalHashV1Result(value), (failure) =>
    contractFailure('CANONICAL_HASH', `${field} cannot be canonically hashed: ${renderCanonicalJsonFailure(failure)}`, {
      field,
      actual: failure.path,
    }),
  )

export const decimalToMicrosResult = (
  value: string,
  signed: boolean,
  name: string,
): Result.Result<string, BrokerReadContractFailure> => {
  if (!decimalPattern.test(value)) {
    return Result.fail(
      contractFailure('DECIMAL_FORMAT', `${name} is not a canonical decimal`, { field: name, actual: value }),
    )
  }
  const negative = value.startsWith('-')
  const absolute = negative ? value.slice(1) : value
  const separator = absolute.indexOf('.')
  const whole = separator === -1 ? absolute : absolute.slice(0, separator)
  const fraction = separator === -1 ? '' : absolute.slice(separator + 1)
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    return Result.fail(
      contractFailure('DECIMAL_PRECISION', `${name} cannot be represented exactly as decimal micros`, {
        field: name,
        actual: value,
      }),
    )
  }
  const micros = BigInt(whole) * 1_000_000n + BigInt((fraction.slice(0, 6) + '000000').slice(0, 6))
  const result = negative ? -micros : micros
  if (!signed && result < 0n) {
    return Result.fail(contractFailure('DECIMAL_SIGN', `${name} must be non-negative`, { field: name, actual: value }))
  }
  if (signed ? result < I128_MIN || result > I128_MAX : result > U128_MAX) {
    return Result.fail(
      contractFailure('DECIMAL_RANGE', `${name} exceeds the decimal micros range`, {
        field: name,
        actual: value,
      }),
    )
  }
  return Result.succeed(result.toString())
}

const positiveMicrosResult = (value: string, name: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.flatMap(decimalToMicrosResult(value, false, name), (micros) =>
    micros === '0'
      ? Result.fail(contractFailure('DECIMAL_ZERO', `${name} must be positive`, { field: name, actual: value }))
      : Result.succeed(micros),
  )

const optionalMicrosResult = (
  value: string | null,
  signed: boolean,
  name: string,
): Result.Result<string | undefined, BrokerReadContractFailure> =>
  value === null ? Result.succeed(undefined) : decimalToMicrosResult(value, signed, name)

const positionMicrosResult = (
  value: string,
  side: PositionSide,
  name: string,
): Result.Result<string, BrokerReadContractFailure> =>
  Result.flatMap(decimalToMicrosResult(value, true, name), (decoded) => {
    const parsed = BigInt(decoded)
    if (parsed === 0n) {
      return Result.fail(contractFailure('DECIMAL_ZERO', `${name} must be non-zero`, { field: name, actual: value }))
    }
    const magnitude = parsed < 0n ? -parsed : parsed
    const normalized = side === PositionSide.Short ? -magnitude : magnitude
    return normalized < I128_MIN || normalized > I128_MAX
      ? Result.fail(
          contractFailure('DECIMAL_RANGE', `${name} exceeds the decimal micros range`, {
            field: name,
            actual: value,
          }),
        )
      : Result.succeed(normalized.toString())
  })

export const normalizeAccountResult = (
  raw: typeof AccountResponseSchema.Type,
  expectedAccountId: string,
  observedAt: string,
): Result.Result<Account, BrokerReadContractFailure> => {
  if (raw.id !== expectedAccountId) {
    return Result.fail(
      contractFailure('ACCOUNT_BINDING', `credential resolved account ${raw.id}, expected ${expectedAccountId}`, {
        field: 'account.id',
        expected: expectedAccountId,
        actual: raw.id,
      }),
    )
  }
  return Result.gen(function* () {
    const cashMicros = yield* decimalToMicrosResult(raw.cash, true, 'account cash')
    const equityMicros = yield* decimalToMicrosResult(raw.equity, true, 'account equity')
    const lastEquityMicros = yield* decimalToMicrosResult(raw.last_equity, true, 'account last equity')
    const buyingPowerMicros = yield* decimalToMicrosResult(raw.buying_power, true, 'account buying power')
    return {
      id: raw.id,
      status: raw.status,
      currency: raw.currency,
      cashMicros,
      equityMicros,
      lastEquityMicros,
      buyingPowerMicros,
      accountBlocked: raw.account_blocked,
      tradingBlocked: raw.trading_blocked,
      tradeSuspendedByUser: raw.trade_suspended_by_user,
      observedAt,
    }
  })
}

export const normalizeAccountConfigurationResult = (
  raw: typeof AccountConfigurationResponseSchema.Type,
  observedAt: string,
): Result.Result<AccountConfigurationObservation, BrokerReadContractFailure> =>
  Result.gen(function* () {
    const requestHash = yield* hashResult(accountConfigurationRequestMaterial, 'account configuration request')
    const normalized = {
      schemaVersion: accountConfigurationObservationSchemaVersion,
      source: accountConfigurationObservationSource,
      requestHash,
      fractionalTrading: raw.fractional_trading,
    }
    const normalizedResponseHash = yield* hashResult(normalized, 'account configuration response')
    return { ...normalized, observedAt, normalizedResponseHash }
  })

export const normalizePositionResult = (
  raw: typeof PositionResponseSchema.Type,
  accountId: string,
  observedAt: string,
): Result.Result<Position, BrokerReadContractFailure> => {
  if (raw.asset_class !== AssetClass.UsEquity) {
    return Result.fail(
      contractFailure('ASSET_CLASS', `unsupported position asset class ${raw.asset_class}`, {
        field: 'position.asset_class',
        expected: AssetClass.UsEquity,
        actual: raw.asset_class,
      }),
    )
  }
  const assetClass = raw.asset_class
  return Result.gen(function* () {
    const quantityMicros = yield* positionMicrosResult(raw.qty, raw.side, 'position quantity')
    const averageEntryPriceMicros = yield* positiveMicrosResult(raw.avg_entry_price, 'average entry price')
    const marketPriceMicros = yield* positiveMicrosResult(raw.current_price, 'current price')
    const marketValueMicros = yield* positionMicrosResult(raw.market_value, raw.side, 'market value')
    const unrealizedPnlMicros = yield* decimalToMicrosResult(raw.unrealized_pl, true, 'unrealized PnL')
    return {
      accountId,
      assetId: raw.asset_id,
      symbol: raw.symbol,
      exchange: raw.exchange,
      assetClass,
      side: raw.side,
      quantityMicros,
      averageEntryPriceMicros,
      marketPriceMicros,
      marketValueMicros,
      unrealizedPnlMicros,
      observedAt,
    }
  })
}

export const normalizePositionsResult = (
  raw: readonly (typeof PositionResponseSchema.Type)[],
  accountId: string,
  observedAt: string,
): Result.Result<readonly Position[], BrokerReadContractFailure> =>
  Result.all(raw.map((position) => normalizePositionResult(position, accountId, observedAt)))

export const normalizeAssetResult = (
  raw: typeof AssetResponseSchema.Type,
  requestedSymbol: string,
  observedAt: string,
): Result.Result<AssetObservation, BrokerReadContractFailure> => {
  if (raw.symbol !== requestedSymbol) {
    return Result.fail(
      contractFailure('ASSET_BINDING', `asset lookup returned symbol ${raw.symbol}, expected ${requestedSymbol}`, {
        field: 'asset.symbol',
        expected: requestedSymbol,
        actual: raw.symbol,
      }),
    )
  }
  return Result.gen(function* () {
    const requestHash = yield* hashResult(assetRequestMaterial(requestedSymbol), 'asset request')
    const normalized = {
      schemaVersion: assetObservationSchemaVersion,
      source: assetObservationSource,
      requestedSymbol,
      requestHash,
      assetId: raw.id,
      symbol: raw.symbol,
      assetClass: raw.class,
      exchange: raw.exchange,
      status: raw.status,
      tradable: raw.tradable,
      fractionable: raw.fractionable,
      attributes: [...new Set(raw.attributes ?? [])].sort(),
    }
    const normalizedResponseHash = yield* hashResult(normalized, 'asset response')
    return { ...normalized, observedAt, normalizedResponseHash }
  })
}

export const normalizeOrderResult = (
  raw: typeof OrderResponseSchema.Type,
  accountId: string,
  observedAt: string,
): Result.Result<Order, BrokerReadContractFailure> => {
  if (raw.asset_class !== AssetClass.UsEquity) {
    return Result.fail(
      contractFailure('ASSET_CLASS', `unsupported order asset class ${raw.asset_class}`, {
        field: 'order.asset_class',
        expected: AssetClass.UsEquity,
        actual: raw.asset_class,
      }),
    )
  }
  const assetClass = raw.asset_class
  if ((raw.qty === null) === (raw.notional === null)) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'order must contain exactly one of qty or notional'))
  }
  if (raw.order_type !== undefined && raw.order_type !== raw.type) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'deprecated order_type does not match type'))
  }
  if (raw.order_class === OrderClass.MultiLeg) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'multi-leg orders are outside the Bayn equity contract'))
  }
  if (raw.type === OrderType.Limit && raw.limit_price === null) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'limit order is missing limit_price'))
  }
  if (raw.type === OrderType.Stop && raw.stop_price === null) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'stop order is missing stop_price'))
  }
  if (raw.type === OrderType.StopLimit && (raw.limit_price === null || raw.stop_price === null)) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'stop-limit order is missing limit_price or stop_price'))
  }
  if (raw.type === OrderType.TrailingStop && (raw.trail_price === null) === (raw.trail_percent === null)) {
    return Result.fail(contractFailure('ORDER_SHAPE', 'trailing-stop order must contain exactly one trailing offset'))
  }

  return Result.gen(function* () {
    const quantityMicros = raw.qty === null ? undefined : yield* positiveMicrosResult(raw.qty, 'order quantity')
    const notionalMicros =
      raw.notional === null ? undefined : yield* positiveMicrosResult(raw.notional, 'order notional')
    const filledQuantityMicros = yield* decimalToMicrosResult(raw.filled_qty, false, 'filled quantity')
    if (quantityMicros !== undefined && BigInt(filledQuantityMicros) > BigInt(quantityMicros)) {
      return yield* Result.fail(contractFailure('ORDER_SHAPE', 'filled quantity exceeds order quantity'))
    }
    const filledAveragePriceMicros = yield* optionalMicrosResult(raw.filled_avg_price, false, 'filled average price')
    const limitPriceMicros = yield* optionalMicrosResult(raw.limit_price, false, 'limit price')
    const stopPriceMicros = yield* optionalMicrosResult(raw.stop_price, false, 'stop price')
    const trailPercentMicros = yield* optionalMicrosResult(raw.trail_percent, false, 'trail percent')
    const trailPriceMicros = yield* optionalMicrosResult(raw.trail_price, false, 'trail price')
    const highWaterMarkMicros = yield* optionalMicrosResult(raw.hwm, false, 'high water mark')

    return {
      accountId,
      brokerOrderId: raw.id,
      clientOrderId: raw.client_order_id,
      createdAt: raw.created_at,
      ...(raw.updated_at == null ? {} : { updatedAt: raw.updated_at }),
      ...(raw.submitted_at == null ? {} : { submittedAt: raw.submitted_at }),
      ...(raw.filled_at === null ? {} : { filledAt: raw.filled_at }),
      ...(raw.expired_at === null ? {} : { expiredAt: raw.expired_at }),
      ...(raw.canceled_at === null ? {} : { canceledAt: raw.canceled_at }),
      ...(raw.failed_at === null ? {} : { failedAt: raw.failed_at }),
      ...(raw.replaced_at === null ? {} : { replacedAt: raw.replaced_at }),
      ...(raw.replaced_by === null ? {} : { replacedBy: raw.replaced_by }),
      ...(raw.replaces === null ? {} : { replaces: raw.replaces }),
      assetId: raw.asset_id,
      symbol: raw.symbol,
      assetClass,
      ...(quantityMicros === undefined ? {} : { quantityMicros }),
      ...(notionalMicros === undefined ? {} : { notionalMicros }),
      filledQuantityMicros,
      ...(filledAveragePriceMicros === undefined ? {} : { filledAveragePriceMicros }),
      orderClass: raw.order_class === '' ? OrderClass.Simple : raw.order_class,
      orderType: raw.type,
      side: raw.side,
      timeInForce: raw.time_in_force,
      ...(limitPriceMicros === undefined ? {} : { limitPriceMicros }),
      ...(stopPriceMicros === undefined ? {} : { stopPriceMicros }),
      status: raw.status,
      extendedHours: raw.extended_hours,
      ...(trailPercentMicros === undefined ? {} : { trailPercentMicros }),
      ...(trailPriceMicros === undefined ? {} : { trailPriceMicros }),
      ...(highWaterMarkMicros === undefined ? {} : { highWaterMarkMicros }),
      observedAt,
    }
  })
}

export const normalizeOrdersResult = (
  raw: readonly (typeof OrderResponseSchema.Type)[],
  accountId: string,
  observedAt: string,
): Result.Result<readonly Order[], BrokerReadContractFailure> =>
  Result.all(raw.map((order) => normalizeOrderResult(order, accountId, observedAt)))

export const normalizeFillActivityResult = (
  raw: typeof FillActivityResponseSchema.Type,
  accountId: string,
): Result.Result<FillActivity, BrokerReadContractFailure> => {
  if (raw.account_id !== undefined && raw.account_id !== accountId) {
    return Result.fail(
      contractFailure(
        'FILL_ACCOUNT_BINDING',
        `fill activity resolved account ${raw.account_id}, expected ${accountId}`,
        { field: 'fill.account_id', expected: accountId, actual: raw.account_id },
      ),
    )
  }
  return Result.gen(function* () {
    const cumulativeQuantityMicros = yield* decimalToMicrosResult(raw.cum_qty, false, 'cumulative fill quantity')
    const leavesQuantityMicros = yield* decimalToMicrosResult(raw.leaves_qty, false, 'leaves quantity')
    const priceMicros = yield* positiveMicrosResult(raw.price, 'fill price')
    const quantityMicros = yield* positiveMicrosResult(raw.qty, 'fill quantity')
    if (BigInt(cumulativeQuantityMicros) < BigInt(quantityMicros)) {
      return yield* Result.fail(
        contractFailure('FILL_SHAPE', 'cumulative fill quantity is smaller than this fill quantity'),
      )
    }
    if (
      (raw.type === TradeActivityType.Fill && leavesQuantityMicros !== '0') ||
      (raw.type === TradeActivityType.PartialFill && leavesQuantityMicros === '0')
    ) {
      return yield* Result.fail(
        contractFailure('FILL_SHAPE', `fill activity type ${raw.type} is inconsistent with leaves quantity`),
      )
    }
    return {
      accountId,
      activityId: raw.id,
      cumulativeQuantityMicros,
      leavesQuantityMicros,
      priceMicros,
      quantityMicros,
      side: raw.side,
      symbol: raw.symbol,
      transactionTime: raw.transaction_time,
      brokerOrderId: raw.order_id,
      type: raw.type,
      ...(raw.order_status === undefined ? {} : { orderStatus: raw.order_status }),
    }
  })
}

export const normalizeFillActivitiesResult = (
  raw: readonly (typeof FillActivityResponseSchema.Type)[],
  accountId: string,
): Result.Result<readonly FillActivity[], BrokerReadContractFailure> =>
  Result.all(raw.map((activity) => normalizeFillActivityResult(activity, accountId)))

const marketCalendarInstantResult = (
  date: string,
  time: string,
  field: 'open' | 'close',
): Result.Result<string, BrokerReadContractFailure> => {
  const zoned = DateTime.makeZoned(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3, 5)),
      second: 0,
      millisecond: 0,
    },
    {
      timeZone: marketCalendarTimeZone,
      adjustForTimeZone: true,
      disambiguation: 'reject',
    },
  )
  return zoned._tag === 'None'
    ? Result.fail(
        contractFailure(
          'CALENDAR_INSTANT',
          `market calendar ${field} is not a valid ${marketCalendarTimeZone} wall-clock instant`,
          { field: `calendar.${field}`, actual: `${date} ${time}` },
        ),
      )
    : Result.succeed(DateTime.formatIso(zoned.value))
}

export const normalizeMarketCalendarResult = (
  raw: typeof MarketCalendarResponseSchema.Type,
  query: typeof MarketCalendarQueryBase.Type,
): Result.Result<MarketCalendarObservation, BrokerReadContractFailure> =>
  Result.gen(function* () {
    const sessions = yield* Result.all(
      raw.map((session): Result.Result<MarketCalendarSession, BrokerReadContractFailure> => {
        if (session.date < query.start || session.date > query.end) {
          return Result.fail(
            contractFailure(
              'CALENDAR_RANGE',
              `market calendar session ${session.date} is outside the requested range`,
              { field: 'calendar.date', expected: `${query.start}..${query.end}`, actual: session.date },
            ),
          )
        }
        return Result.gen(function* () {
          const openAt = yield* marketCalendarInstantResult(session.date, session.open, 'open')
          const closeAt = yield* marketCalendarInstantResult(session.date, session.close, 'close')
          if (openAt >= closeAt) {
            return yield* Result.fail(
              contractFailure('CALENDAR_HOURS', `market calendar session ${session.date} has invalid hours`, {
                field: 'calendar.hours',
                actual: `${openAt}..${closeAt}`,
              }),
            )
          }
          return { date: session.date, openAt, closeAt }
        })
      }),
    )
    sessions.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
    for (let index = 1; index < sessions.length; index += 1) {
      if (sessions[index - 1]?.date === sessions[index]?.date) {
        return yield* Result.fail(
          contractFailure('CALENDAR_DUPLICATE', `market calendar contains duplicate session ${sessions[index]?.date}`),
        )
      }
    }
    const normalized = {
      schemaVersion: marketCalendarSchemaVersion,
      source: marketCalendarSource,
      requestedRange: { start: query.start, end: query.end },
      timeZone: 'UTC' as const,
      sessions,
    }
    const normalizedResponseHash = yield* hashResult(normalized, 'market calendar response')
    return { ...normalized, normalizedResponseHash }
  })
