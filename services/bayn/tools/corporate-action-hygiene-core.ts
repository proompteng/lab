import { Data, Redacted, Result, Schema, SchemaIssue } from 'effect'

import { EquityShortEligibilitySchema, equityShortIsEligible } from '../src/execution/equity-short'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  SignalRowSymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../src/schemas'
import { AccountId, BarAdjustment } from './macro-canary-runner/alpaca'

export enum Sleeve {
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
}

export enum OvernightGapUse {
  UsedForAlpha = 'used-for-alpha',
  Excluded = 'excluded',
}

const Split = Schema.Struct({ fromShares: PositiveIntegerSchema, toShares: PositiveIntegerSchema }).check(
  Schema.makeFilter(({ fromShares, toShares }) => fromShares !== toShares, { expected: 'a change in share units' }),
)
const CorporateActions = Schema.Struct({
  symbol: SignalRowSymbolSchema,
  session: IsoDateSchema,
  split: Schema.NullOr(Split),
  cashDividendMicros: NonNegativeIntegerSchema,
})
const ShortEntry = Schema.Struct({
  decisionAt: UtcInstantSchema,
  eligibility: Schema.NullOr(EquityShortEligibilitySchema),
})
const Window = {
  symbol: SignalRowSymbolSchema,
  previousSession: IsoDateSchema,
  session: IsoDateSchema,
  rawPreviousCloseMicros: PositiveIntegerSchema,
  rawOpenMicros: PositiveIntegerSchema,
}
const Intraday = Schema.Struct({
  ...Window,
  sleeve: Schema.Literal(Sleeve.B0),
  accountId: AccountId,
  overnightGapUse: Schema.Enum(OvernightGapUse),
  shortEntries: Schema.Array(ShortEntry),
})
const Signal = Schema.Struct({
  basis: Schema.Enum(BarAdjustment),
  previousCloseMicros: PositiveIntegerSchema,
  openMicros: PositiveIntegerSchema,
  closeMicros: PositiveIntegerSchema,
})
const Sizing = Schema.Struct({
  basis: Schema.Enum(BarAdjustment),
  priceMicros: PositiveIntegerSchema,
  rawCloseMicros: PositiveIntegerSchema,
  referenceSession: IsoDateSchema,
  executionSession: IsoDateSchema,
})
const Daily = Schema.Struct({
  ...Window,
  sleeve: Schema.Enum(Sleeve).pipe(Schema.refine((sleeve) => sleeve !== Sleeve.B0)),
  signal: Signal,
  sizing: Sizing,
})
const Evidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.corporate-action-hygiene-evidence.v1'),
  calendar: Schema.Array(IsoDateSchema).check(
    Schema.isMinLength(2),
    Schema.makeFilter((dates) => dates.every((date, i) => i === 0 || dates[i - 1] < date), {
      expected: 'strictly increasing regular sessions',
    }),
  ),
  corporateActions: Schema.Array(CorporateActions),
  observations: Schema.NonEmptyArray(Schema.Union([Daily, Intraday])),
})
export type CorporateActionHygieneEvidence = typeof Evidence.Type

const evidenceFields = new Set(
  [
    Evidence,
    Daily,
    Intraday,
    Signal,
    Sizing,
    CorporateActions,
    Split,
    ShortEntry,
    EquityShortEligibilitySchema,
  ].flatMap((schema) => Object.keys(schema.fields)),
)
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => issue._tag,
  checkHook: (issue) => issue.issue._tag,
})

export enum HygieneErrorCode {
  InvalidArguments = 'InvalidArguments',
  ReadEvidenceFailed = 'ReadEvidenceFailed',
  InvalidEvidence = 'InvalidEvidence',
  RejectedEvidence = 'RejectedEvidence',
}

class CorporateActionHygieneError extends Data.TaggedError('CorporateActionHygieneError')<{
  readonly code: HygieneErrorCode
  readonly cause: Redacted.Redacted<unknown>
  readonly details?: object
}> {
  override get message(): string {
    return this.code
  }
}

export const hygieneError = (code: HygieneErrorCode, cause: unknown, details?: object) =>
  new CorporateActionHygieneError({ code, cause: Redacted.make(cause), ...(details === undefined ? {} : { details }) })

export const decodeCorporateActionHygieneEvidence = (json: string) =>
  Schema.decodeUnknownResult(
    Schema.fromJsonString(Evidence),
    strictParseOptions,
  )(json).pipe(
    Result.mapError((cause) =>
      hygieneError(HygieneErrorCode.InvalidEvidence, cause, {
        issues: formatIssue(cause.issue).issues.map(({ message: kind, path = [] }) => ({
          kind,
          path: path.map((key) =>
            typeof key === 'number' || (typeof key === 'string' && evidenceFields.has(key)) ? key : '[redacted]',
          ),
        })),
      }),
    ),
  )

export enum HygieneStatus {
  Pass = 'PASS',
  Fail = 'FAIL',
}

export enum Flag {
  ExDividendGap = 'ExDividendGap',
  SplitGap = 'SplitGap',
}

export enum Anomaly {
  InvalidCorporateActionSession = 'InvalidCorporateActionSession',
  DuplicateCorporateActionEvidence = 'DuplicateCorporateActionEvidence',
  InvalidSessionPair = 'InvalidSessionPair',
  DuplicateObservation = 'DuplicateObservation',
  MissingCorporateActionEvidence = 'MissingCorporateActionEvidence',
  InvalidCorporateAction = 'InvalidCorporateAction',
  OvernightDiscontinuity = 'OvernightDiscontinuity',
  SignalPriceBasisMismatch = 'SignalPriceBasisMismatch',
  SignalAdjustmentMismatch = 'SignalAdjustmentMismatch',
  SizingPriceBasisMismatch = 'SizingPriceBasisMismatch',
  InvalidSizingSession = 'InvalidSizingSession',
  MissingNextOpenCorporateActionEvidence = 'MissingNextOpenCorporateActionEvidence',
  NextOpenSplit = 'NextOpenSplit',
  CorporateActionGapUsedForAlpha = 'CorporateActionGapUsedForAlpha',
  InvalidShortDecisionSession = 'InvalidShortDecisionSession',
  MissingShortEligibility = 'MissingShortEligibility',
  IneligibleShort = 'IneligibleShort',
}

type Finding<Code> = { readonly observation: number; readonly code: Code; readonly shortEntry?: number }
type ActionFinding = {
  readonly corporateAction: number
  readonly code: Anomaly.InvalidCorporateActionSession | Anomaly.DuplicateCorporateActionEvidence
}

const jumpsOver20Percent = (priorClose: bigint, open: bigint) =>
  open * 5n < priorClose * 4n || open * 5n > priorClose * 6n

const matchesReturn = (signalFrom: bigint, signalTo: bigint, rawFrom: bigint, rawTo: bigint) => {
  // Comparing returns cancels the common adjustment scale. Each signal mark may round by half a microdollar.
  const delta = 2n * (signalTo * rawFrom - signalFrom * rawTo)
  const rounding = rawFrom + rawTo
  return -rounding <= delta && delta <= rounding
}

const actionKey = (symbol: string, session: string) => `${symbol}/${session}`

export const verifyCorporateActionHygiene = ({
  calendar,
  corporateActions,
  observations,
}: CorporateActionHygieneEvidence) => {
  const sessionIndexes = new Map(calendar.map((session, i) => [session, i]))
  const actionsByOpen = new Map<string, typeof CorporateActions.Type>()
  const counts = { [Sleeve.B0]: 0, [Sleeve.F4]: 0, [Sleeve.O1]: 0 }
  const seen = new Set<string>()
  const flags: Finding<Flag>[] = []
  const anomalies: (Finding<Anomaly> | ActionFinding)[] = []

  for (const [corporateAction, action] of corporateActions.entries()) {
    const key = actionKey(action.symbol, action.session)
    if (!sessionIndexes.has(action.session))
      anomalies.push({ corporateAction, code: Anomaly.InvalidCorporateActionSession })
    if (actionsByOpen.has(key)) anomalies.push({ corporateAction, code: Anomaly.DuplicateCorporateActionEvidence })
    else actionsByOpen.set(key, action)
  }

  for (const [observation, row] of observations.entries()) {
    const { sleeve, symbol, previousSession, session } = row
    const reject = (code: Anomaly) => anomalies.push({ observation, code })
    const sessionIndex = sessionIndexes.get(session)
    const key = `${sleeve}/${symbol}/${session}`
    counts[sleeve]++
    if (seen.has(key)) reject(Anomaly.DuplicateObservation)
    seen.add(key)
    if (sessionIndex === undefined || calendar[sessionIndex - 1] !== previousSession) reject(Anomaly.InvalidSessionPair)

    const rawPreviousClose = BigInt(row.rawPreviousCloseMicros)
    const rawOpen = BigInt(row.rawOpenMicros)
    const action = actionsByOpen.get(actionKey(symbol, session))
    const split = action?.split ?? null
    const dividend = action?.cashDividendMicros ?? 0
    if (dividend > 0) flags.push({ observation, code: Flag.ExDividendGap })
    if (split !== null) flags.push({ observation, code: Flag.SplitGap })

    // Work in post-action share units. Scale both marks by the denominator to keep the comparison exact.
    const toShares = BigInt(split?.toShares ?? 1)
    const adjustedClose = rawPreviousClose * BigInt(split?.fromShares ?? 1) - BigInt(dividend) * toShares
    const adjustedOpen = rawOpen * toShares
    const validAction = adjustedClose > 0n
    if (action === undefined) reject(Anomaly.MissingCorporateActionEvidence)
    else if (!validAction) reject(Anomaly.InvalidCorporateAction)
    let discontinuity = validAction
      ? jumpsOver20Percent(adjustedClose, adjustedOpen)
      : jumpsOver20Percent(rawPreviousClose, rawOpen)

    if (sleeve === Sleeve.B0) {
      if ((split !== null || dividend > 0) && row.overnightGapUse === OvernightGapUse.UsedForAlpha)
        reject(Anomaly.CorporateActionGapUsedForAlpha)
      for (const [shortEntry, { decisionAt, eligibility }] of row.shortEntries.entries()) {
        if (decisionAt.slice(0, 10) !== session)
          anomalies.push({ observation, shortEntry, code: Anomaly.InvalidShortDecisionSession })
        if (eligibility === null) anomalies.push({ observation, shortEntry, code: Anomaly.MissingShortEligibility })
        else if (!equityShortIsEligible(eligibility, row.accountId, symbol, decisionAt))
          anomalies.push({ observation, shortEntry, code: Anomaly.IneligibleShort })
      }
    } else {
      const { signal, sizing } = row
      if (signal.basis !== BarAdjustment.All) reject(Anomaly.SignalPriceBasisMismatch)
      if (sizing.basis !== BarAdjustment.Raw || sizing.priceMicros !== sizing.rawCloseMicros)
        reject(Anomaly.SizingPriceBasisMismatch)
      if (
        sizing.referenceSession !== session ||
        sessionIndex === undefined ||
        calendar[sessionIndex + 1] !== sizing.executionSession
      )
        reject(Anomaly.InvalidSizingSession)
      const nextOpen = actionsByOpen.get(actionKey(symbol, sizing.executionSession))
      if (nextOpen === undefined) reject(Anomaly.MissingNextOpenCorporateActionEvidence)
      // The batch is sized at the prior raw close, in pre-split shares. It cannot validate a post-split order.
      else if (nextOpen.split !== null) reject(Anomaly.NextOpenSplit)

      const signalPreviousClose = BigInt(signal.previousCloseMicros)
      const signalOpen = BigInt(signal.openMicros)
      discontinuity ||= jumpsOver20Percent(signalPreviousClose, signalOpen)
      if (
        !matchesReturn(signalOpen, BigInt(signal.closeMicros), rawOpen, BigInt(sizing.rawCloseMicros)) ||
        (action !== undefined &&
          validAction &&
          !matchesReturn(signalPreviousClose, signalOpen, adjustedClose, adjustedOpen))
      )
        reject(Anomaly.SignalAdjustmentMismatch)
    }
    if (discontinuity) reject(Anomaly.OvernightDiscontinuity)
  }

  return {
    schemaVersion: 'bayn.corporate-action-hygiene-report.v1',
    status: anomalies.length === 0 ? HygieneStatus.Pass : HygieneStatus.Fail,
    checkedBySleeve: counts,
    flags,
    anomalies,
  } as const
}
