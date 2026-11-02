import { DateTime, Result } from 'effect'
import { sourceTimestamp } from '../observations'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { contractFailure, type BrokerReadContractFailure } from './failures'
import {
  AccountConfigurationResponseSchema,
  AccountResponseSchema,
  AssetClass,
  AssetResponseSchema,
  FillActivityResponseSchema,
  FeeActivityResponseSchema,
  type FeeActivity,
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
  type Order,
  type Position,
} from './model'
import { accountConfigurationRequestMaterial, assetRequestMaterial } from './requests'

import { equityDataSession } from '../../equity-hours'
import { quantityFromDecimal } from '../../quantity'
import { decodeInstrument, instrumentMarket, MarketKind } from '../../instruments'
import { cashReportingQuantum } from './cash-reporting'

const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$|^-[1-9][0-9]*(?:\.[0-9]+)?$|^-0\.[0-9]*[1-9][0-9]*$/

const hashResult = (value: unknown, field: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.mapError(canonicalHashV1Result(value), (failure) =>
    contractFailure({
      reason: 'CANONICAL_HASH',
      message: `${field} cannot be canonically hashed: ${renderCanonicalJsonFailure(failure)}`,
      facts: {
        field,
        actual: failure.path,
      },
    }),
  )

const decimalMicrosResult = (
  value: string,
  signed: boolean,
  name: string,
  rounding: 'EXACT' | 'DOWN' | 'UP',
): Result.Result<string, BrokerReadContractFailure> => {
  if (!decimalPattern.test(value)) {
    return Result.fail(
      contractFailure({
        reason: 'DECIMAL_FORMAT',
        message: `${name} is not a canonical decimal`,
        facts: { field: name, actual: value },
      }),
    )
  }
  const negative = value.startsWith('-')
  const absolute = negative ? value.slice(1) : value
  const separator = absolute.indexOf('.')
  const whole = separator === -1 ? absolute : absolute.slice(0, separator)
  const fraction = separator === -1 ? '' : absolute.slice(separator + 1)
  const subMicroRemainder = /[1-9]/.test(fraction.slice(6))
  if (rounding === 'EXACT' && subMicroRemainder) {
    return Result.fail(
      contractFailure({
        reason: 'DECIMAL_PRECISION',
        message: `${name} cannot be represented exactly as decimal micros`,
        facts: {
          field: name,
          actual: value,
        },
      }),
    )
  }
  const micros = BigInt(whole) * 1_000_000n + BigInt((fraction.slice(0, 6) + '000000').slice(0, 6))
  const truncated = negative ? -micros : micros
  const adjustment = subMicroRemainder
    ? rounding === 'UP' && !negative
      ? 1n
      : rounding === 'DOWN' && negative
        ? -1n
        : 0n
    : 0n
  const result = truncated + adjustment
  if (!signed && result < 0n) {
    return Result.fail(
      contractFailure({
        reason: 'DECIMAL_SIGN',
        message: `${name} must be non-negative`,
        facts: { field: name, actual: value },
      }),
    )
  }
  if (signed ? result < I128_MIN || result > I128_MAX : result > U128_MAX) {
    return Result.fail(
      contractFailure({
        reason: 'DECIMAL_RANGE',
        message: `${name} exceeds the decimal micros range`,
        facts: {
          field: name,
          actual: value,
        },
      }),
    )
  }
  return Result.succeed(result.toString())
}

export const decimalToMicrosResult = (value: string, signed: boolean, name: string) =>
  decimalMicrosResult(value, signed, name, 'EXACT')

const quantityResult = (
  value: string,
  name: string,
  { signed = false, positive = true }: { readonly signed?: boolean; readonly positive?: boolean } = {},
): Result.Result<string, BrokerReadContractFailure> =>
  quantityFromDecimal(value).pipe(
    Result.mapError((cause) =>
      contractFailure({
        reason: cause.reason === 'precision' ? 'DECIMAL_PRECISION' : 'DECIMAL_FORMAT',
        message: `${name} is outside the exact quantity domain`,
        facts: { field: name, actual: value },
      }),
    ),
    Result.flatMap((quantity) =>
      (positive && quantity === 0n) ||
      (!signed && quantity < 0n) ||
      quantity > (signed ? I128_MAX : U128_MAX) ||
      quantity < I128_MIN
        ? Result.fail(
            contractFailure({
              reason: 'DECIMAL_RANGE',
              message: `${name} is outside the quantity range`,
              facts: { field: name, actual: value },
            }),
          )
        : Result.succeed(quantity.toString()),
    ),
  )

// Prices used for valuation are rounded once to USD micros. Executed fills keep exact price atoms.
const valuationPriceMicros = (value: string, name: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.flatMap(quantityResult(value, name), (atoms) => {
    const micros = (BigInt(atoms) + 500n) / 1000n
    return micros === 0n
      ? Result.fail(contractFailure({ reason: 'DECIMAL_ZERO', message: `${name} rounds to zero USD micros` }))
      : Result.succeed(micros.toString())
  })

const positiveMicrosResult = (value: string, name: string): Result.Result<string, BrokerReadContractFailure> =>
  Result.flatMap(decimalToMicrosResult(value, false, name), (micros) =>
    micros === '0'
      ? Result.fail(
          contractFailure({
            reason: 'DECIMAL_ZERO',
            message: `${name} must be positive`,
            facts: { field: name, actual: value },
          }),
        )
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
      return Result.fail(
        contractFailure({
          reason: 'DECIMAL_ZERO',
          message: `${name} must be non-zero`,
          facts: { field: name, actual: value },
        }),
      )
    }
    const magnitude = parsed < 0n ? -parsed : parsed
    const normalized = side === PositionSide.Short ? -magnitude : magnitude
    return normalized < I128_MIN || normalized > I128_MAX
      ? Result.fail(
          contractFailure({
            reason: 'DECIMAL_RANGE',
            message: `${name} exceeds the decimal micros range`,
            facts: {
              field: name,
              actual: value,
            },
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
      contractFailure({
        reason: 'ACCOUNT_BINDING',
        message: `credential resolved account ${raw.id}, expected ${expectedAccountId}`,
        facts: {
          field: 'account.id',
          expected: expectedAccountId,
          actual: raw.id,
        },
      }),
    )
  }
  return Result.gen(function* () {
    const cashMicros = yield* decimalToMicrosResult(raw.cash, true, 'account cash')
    // Marks are not cash settlement amounts. Bound current equity down and the previous close up
    // so converting provider mark precision to micros cannot understate the daily-loss guard.
    const equityMicros = yield* decimalMicrosResult(raw.equity, true, 'account equity', 'DOWN')
    const lastEquityMicros = yield* decimalMicrosResult(raw.last_equity, true, 'account last equity', 'UP')
    const buyingPowerMicros = yield* decimalToMicrosResult(raw.buying_power, true, 'account buying power')
    return {
      id: raw.id,
      status: raw.status,
      currency: raw.currency,
      cashMicros,
      cashReportingQuantumMicros: cashReportingQuantum(raw.cash),
      equityMicros,
      lastEquityMicros,
      cryptoStatus: raw.crypto_status ?? null,
      cryptoFeeTier: raw.crypto_tier ?? null,
      nonMarginableBuyingPowerMicros:
        raw.non_marginable_buying_power === undefined
          ? null
          : yield* decimalToMicrosResult(raw.non_marginable_buying_power, false, 'non-marginable buying power'),
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
  if (raw.asset_class !== AssetClass.UsEquity && raw.asset_class !== AssetClass.Crypto) {
    return Result.fail(
      contractFailure({
        reason: 'ASSET_CLASS',
        message: `unsupported position asset class ${raw.asset_class}`,
        facts: {
          field: 'position.asset_class',
          expected: AssetClass.UsEquity,
          actual: raw.asset_class,
        },
      }),
    )
  }
  const assetClass = raw.asset_class
  const symbol = raw.symbol
  if ((instrumentMarket(symbol) === MarketKind.Crypto) !== (assetClass === AssetClass.Crypto)) {
    return Result.fail(
      contractFailure({
        reason: 'ASSET_BINDING',
        message: 'position symbol and asset class must agree',
        facts: { field: 'position.symbol', actual: raw.symbol },
      }),
    )
  }
  return Result.gen(function* () {
    const rawQuantity = BigInt(yield* quantityResult(raw.qty, 'position quantity', { signed: true }))
    const magnitude = rawQuantity < 0n ? -rawQuantity : rawQuantity
    const quantityAtoms = (raw.side === PositionSide.Short ? -magnitude : magnitude).toString()
    const averageEntryPriceMicros = yield* valuationPriceMicros(raw.avg_entry_price, 'average entry price')
    const costBasisMicros = yield* positionMicrosResult(raw.cost_basis, raw.side, 'position cost basis')
    const marketPriceMicros = yield* valuationPriceMicros(raw.current_price, 'current price')
    const marketValueMicros = yield* positionMicrosResult(raw.market_value, raw.side, 'market value')
    const unrealizedPnlMicros = yield* decimalToMicrosResult(raw.unrealized_pl, true, 'unrealized PnL')
    return {
      accountId,
      assetId: raw.asset_id,
      symbol,
      exchange: raw.exchange,
      assetClass,
      side: raw.side,
      quantityAtoms,
      averageEntryPriceMicros,
      costBasisMicros,
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
      contractFailure({
        reason: 'ASSET_BINDING',
        message: `asset lookup returned symbol ${raw.symbol}, expected ${requestedSymbol}`,
        facts: {
          field: 'asset.symbol',
          expected: requestedSymbol,
          actual: raw.symbol,
        },
      }),
    )
  }
  return Result.gen(function* () {
    if (raw.class !== AssetClass.UsEquity && raw.class !== AssetClass.Crypto)
      return yield* Result.fail(
        contractFailure({ reason: 'ASSET_CLASS', message: 'unsupported instrument asset class' }),
      )
    const instrument = yield* decodeInstrument({
      symbol: raw.symbol,
      assetClass: raw.class,
      minimumOrderSize: raw.min_order_size ?? null,
      quantityIncrement: raw.min_trade_increment ?? null,
      priceIncrement: raw.price_increment ?? null,
    }).pipe(Result.mapError((cause) => contractFailure({ reason: 'ASSET_BINDING', message: cause.message })))
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
      minimumQuantityAtoms: instrument.minimumQuantityAtoms.toString(),
      quantityIncrementAtoms: instrument.quantityIncrementAtoms.toString(),
      priceIncrementAtoms: instrument.priceIncrementAtoms.toString(),
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
  if (raw.asset_class !== AssetClass.UsEquity && raw.asset_class !== AssetClass.Crypto) {
    return Result.fail(
      contractFailure({
        reason: 'ASSET_CLASS',
        message: `unsupported order asset class ${raw.asset_class}`,
        facts: {
          field: 'order.asset_class',
          expected: AssetClass.UsEquity,
          actual: raw.asset_class,
        },
      }),
    )
  }
  const assetClass = raw.asset_class
  if ((raw.qty === null) === (raw.notional === null)) {
    return Result.fail(
      contractFailure({ reason: 'ORDER_SHAPE', message: 'order must contain exactly one of qty or notional' }),
    )
  }
  if (raw.order_type !== undefined && raw.order_type !== raw.type) {
    return Result.fail(contractFailure({ reason: 'ORDER_SHAPE', message: 'deprecated order_type does not match type' }))
  }
  if (raw.order_class === OrderClass.MultiLeg) {
    return Result.fail(
      contractFailure({ reason: 'ORDER_SHAPE', message: 'multi-leg orders are outside the Bayn equity contract' }),
    )
  }
  if (raw.type === OrderType.Limit && raw.limit_price === null) {
    return Result.fail(contractFailure({ reason: 'ORDER_SHAPE', message: 'limit order is missing limit_price' }))
  }
  if (raw.type === OrderType.Stop && raw.stop_price === null) {
    return Result.fail(contractFailure({ reason: 'ORDER_SHAPE', message: 'stop order is missing stop_price' }))
  }
  if (raw.type === OrderType.StopLimit && (raw.limit_price === null || raw.stop_price === null)) {
    return Result.fail(
      contractFailure({ reason: 'ORDER_SHAPE', message: 'stop-limit order is missing limit_price or stop_price' }),
    )
  }
  if (raw.type === OrderType.TrailingStop && (raw.trail_price === null) === (raw.trail_percent === null)) {
    return Result.fail(
      contractFailure({
        reason: 'ORDER_SHAPE',
        message: 'trailing-stop order must contain exactly one trailing offset',
      }),
    )
  }

  return Result.gen(function* () {
    const quantityAtoms = raw.qty === null ? undefined : yield* quantityResult(raw.qty, 'order quantity')
    const notionalMicros =
      raw.notional === null ? undefined : yield* positiveMicrosResult(raw.notional, 'order notional')
    const filledQuantityAtoms = yield* quantityResult(raw.filled_qty, 'filled quantity', { positive: false })
    if (quantityAtoms !== undefined && BigInt(filledQuantityAtoms) > BigInt(quantityAtoms)) {
      return yield* Result.fail(
        contractFailure({ reason: 'ORDER_SHAPE', message: 'filled quantity exceeds order quantity' }),
      )
    }
    const filledAveragePriceMicros =
      raw.filled_avg_price === null
        ? undefined
        : yield* valuationPriceMicros(raw.filled_avg_price, 'filled average price')
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
      ...(quantityAtoms === undefined ? {} : { quantityAtoms }),
      ...(notionalMicros === undefined ? {} : { notionalMicros }),
      filledQuantityAtoms,
      ...(filledAveragePriceMicros === undefined ? {} : { filledAveragePriceMicros }),
      ...(raw.legs === null
        ? {}
        : {
            legs: yield* Result.all(
              raw.legs.map((leg) =>
                Result.map(normalizeOrderResult(leg, accountId, observedAt), (child) => ({
                  ...child,
                  parentBrokerOrderId: raw.id,
                })),
              ),
            ),
          }),
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
      contractFailure({
        reason: 'FILL_ACCOUNT_BINDING',
        message: `fill activity resolved account ${raw.account_id}, expected ${accountId}`,
        facts: { field: 'fill.account_id', expected: accountId, actual: raw.account_id },
      }),
    )
  }
  return Result.gen(function* () {
    const cumulativeQuantityAtoms = yield* quantityResult(raw.cum_qty, 'cumulative fill quantity', { positive: false })
    const leavesQuantityAtoms = yield* quantityResult(raw.leaves_qty, 'leaves quantity', { positive: false })
    const priceAtoms = yield* quantityResult(raw.price, 'fill price')
    const quantityAtoms = yield* quantityResult(raw.qty, 'fill quantity')
    if (BigInt(cumulativeQuantityAtoms) < BigInt(quantityAtoms)) {
      return yield* Result.fail(
        contractFailure({
          reason: 'FILL_SHAPE',
          message: 'cumulative fill quantity is smaller than this fill quantity',
        }),
      )
    }
    if (
      (raw.type === TradeActivityType.Fill && leavesQuantityAtoms !== '0') ||
      (raw.type === TradeActivityType.PartialFill && leavesQuantityAtoms === '0')
    ) {
      return yield* Result.fail(
        contractFailure({
          reason: 'FILL_SHAPE',
          message: `fill activity type ${raw.type} is inconsistent with leaves quantity`,
        }),
      )
    }
    return {
      accountId,
      activityId: raw.id,
      cumulativeQuantityAtoms,
      leavesQuantityAtoms,
      priceAtoms,
      quantityAtoms,
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
        contractFailure({
          reason: 'CALENDAR_INSTANT',
          message: `market calendar ${field} is not a valid ${marketCalendarTimeZone} wall-clock instant`,
          facts: { field: `calendar.${field}`, actual: `${date} ${time}` },
        }),
      )
    : Result.succeed(DateTime.formatIso(zoned.value))
}

export const normalizeMarketCalendarResult = (
  raw: typeof MarketCalendarResponseSchema.Type,
  query: typeof MarketCalendarQueryBase.Type,
): Result.Result<MarketCalendarObservation, BrokerReadContractFailure> =>
  Result.gen(function* () {
    const providerSessions = yield* Result.all(
      raw.map((session) => {
        if (session.date < query.start || session.date > query.end) {
          return Result.fail(
            contractFailure({
              reason: 'CALENDAR_RANGE',
              message: `market calendar session ${session.date} is outside the requested range`,
              facts: { field: 'calendar.date', expected: `${query.start}..${query.end}`, actual: session.date },
            }),
          )
        }
        return Result.gen(function* () {
          const openAt = yield* marketCalendarInstantResult(session.date, session.open, 'open')
          const closeAt = yield* marketCalendarInstantResult(session.date, session.close, 'close')
          if (openAt >= closeAt) {
            return yield* Result.fail(
              contractFailure({
                reason: 'CALENDAR_HOURS',
                message: `market calendar session ${session.date} has invalid hours`,
                facts: {
                  field: 'calendar.hours',
                  actual: `${openAt}..${closeAt}`,
                },
              }),
            )
          }
          const fullTime = (value: string) => `${value.slice(0, 2)}:${value.slice(2, 4)}`
          const sessionOpenAt = yield* marketCalendarInstantResult(session.date, fullTime(session.session_open), 'open')
          const sessionCloseAt = yield* marketCalendarInstantResult(
            session.date,
            fullTime(session.session_close),
            'close',
          )
          return { date: session.date, regularOpenAt: openAt, regularCloseAt: closeAt, sessionOpenAt, sessionCloseAt }
        })
      }),
    )
    providerSessions.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
    const sessions = yield* Result.all(
      providerSessions.map((session) =>
        equityDataSession(session).pipe(
          Result.mapError((cause) => contractFailure({ reason: 'CALENDAR_HOURS', message: cause.message })),
        ),
      ),
    )
    for (let index = 1; index < sessions.length; index += 1) {
      if (sessions[index - 1]?.date === sessions[index]?.date) {
        return yield* Result.fail(
          contractFailure({
            reason: 'CALENDAR_DUPLICATE',
            message: `market calendar contains duplicate session ${sessions[index]?.date}`,
          }),
        )
      }
    }
    const normalized = {
      schemaVersion: marketCalendarSchemaVersion,
      source: marketCalendarSource,
      requestedRange: { start: query.start, end: query.end },
      timeZone: 'UTC' as const,
      sessions,
      providerSessions,
    }
    const normalizedResponseHash = yield* hashResult(normalized, 'market calendar response')
    return { ...normalized, normalizedResponseHash }
  })

export const normalizeFeeActivitiesResult = (
  raw: readonly (typeof FeeActivityResponseSchema.Type)[],
  accountId: string,
): Result.Result<readonly FeeActivity[], BrokerReadContractFailure> =>
  Result.all(
    raw.map((activity) => {
      if (activity.account_id !== undefined && activity.account_id !== accountId)
        return Result.fail(
          contractFailure({
            reason: 'ACCOUNT_BINDING',
            message: 'fee activity account does not match the configured account',
          }),
        )
      return Result.gen(function* () {
        const netAmountMicros = yield* decimalToMicrosResult(activity.net_amount, true, 'fee net amount')
        const common = { accountId, activityId: activity.id, date: activity.date, netAmountMicros }
        if (activity.activity_type === 'FEE') return common
        const sourceCreatedAt = yield* sourceTimestamp(activity.created_at).pipe(
          Result.mapError(() =>
            contractFailure({ reason: 'FEE_SHAPE', message: 'crypto fee source timestamp is invalid' }),
          ),
        )
        if (activity.qty === undefined) {
          if (BigInt(netAmountMicros) >= 0n)
            return yield* Result.fail(
              contractFailure({ reason: 'DECIMAL_SIGN', message: 'USD crypto fee must debit cash' }),
            )
          return { ...common, sourceCreatedAt, cryptoCashFee: true as const }
        }
        if (netAmountMicros !== '0')
          return yield* Result.fail(
            contractFailure({ reason: 'DECIMAL_SIGN', message: 'coin fee must have no cash amount' }),
          )
        const symbol = activity.symbol
        if (!['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(symbol))
          return yield* Result.fail(
            contractFailure({ reason: 'ASSET_BINDING', message: 'coin fee has an unsupported instrument' }),
          )
        const quantity = yield* quantityResult(activity.qty, 'coin fee quantity', { signed: true })
        if (BigInt(quantity) >= 0n)
          return yield* Result.fail(
            contractFailure({ reason: 'DECIMAL_SIGN', message: 'coin fee must debit a positive coin quantity' }),
          )
        const priceAtoms = yield* quantityResult(activity.price, 'coin fee price')
        return {
          ...common,
          sourceCreatedAt,
          coinDebit: { symbol, quantityAtoms: (-BigInt(quantity)).toString(), priceAtoms },
        }
      })
    }),
  )
