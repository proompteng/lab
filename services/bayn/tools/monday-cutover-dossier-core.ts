import { Data, Redacted, Result, Schema } from 'effect'

import { AccountStatus } from '../src/broker/alpaca/model'
import { OrderSide } from '../src/execution/contracts'
import {
  compareIntradayInstants as compareAt,
  intradayAgeNanos,
  millisecondsAsNanos,
} from '../src/market-data/intraday/time'
import { quantityFromDecimal, quantityScale } from '../src/quantity'
import {
  NonNegativeIntegerSchema as Count,
  Sha256Schema,
  UtcSourceTimestampSchema as At,
  strictParseOptions,
} from '../src/schemas'
import { AuditInput } from './live-profitability-audit-core'
import { AccountId } from './macro-canary-runner/alpaca'
import { TimeInForce } from './macro-canary-runner/contract'
import { AlpacaEndpoint, CheckStatus, Phase } from './monday-cutover-verifier'
import { SleeveMode } from './multi-account-daily-sleeves/contract'
import { Disposition, verifyPortfolio, WeeklyAttributionInput } from './weekly-attribution-receipts'

export enum DossierDecision {
  Authorize = 'AUTHORIZE_PR_16395_MERGE',
  Hold = 'HOLD_PR_16395',
}

export enum Block {
  EvidenceUnavailable = 'EVIDENCE_UNAVAILABLE',
  InvalidEvidence = 'INVALID_EVIDENCE',
  PreOpenVerification = 'PRE_OPEN_VERIFICATION',
  OpeningCarry = 'OPENING_CARRY',
  PostFlattenVerification = 'POST_FLATTEN_VERIFICATION',
  AccountCollision = 'ACCOUNT_COLLISION',
  AccountMismatch = 'ACCOUNT_MISMATCH',
  FlattenFill = 'FLATTEN_FILL',
  AccountingReceipt = 'ACCOUNTING_RECEIPT',
  ReconciliationReceipt = 'RECONCILIATION_RECEIPT',
  NonFlat = 'NON_FLAT',
  StaleEvidence = 'STALE_EVIDENCE',
  ShadowReadiness = 'SHADOW_READINESS',
}

export class DossierInputError extends Data.TaggedError('DossierInputError')<{
  readonly code: Block
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const session = '2026-11-30'
const dayStart = `${session}T05:00:00.000Z`
const open = `${session}T14:30:00.000Z`
const endOpeningMinute = `${session}T14:31:00.000Z`
const close = `${session}T21:00:00.000Z`
const signalSession = '2026-11-27'
const signalClose = `${signalSession}T18:00:00.000Z`
const shadowReadyAt = '2026-11-28T01:15:00.000Z' // Friday 20:15 ET, after the half-day close.
const shadowCutoff = `${session}T14:28:00.000Z`
const maxAge = millisecondsAsNanos(60_000) // Match the reviewed v2 settlement gate's freshness limit.
const shares = 103n * quantityScale

const { fills, openingPositions, reconciliation } = AuditInput.fields.sessions.value.fields
const { id, symbol, side, at, quantityAtoms } = fills.value.fields
const { positions: _positions, ...reconciliationFields } = reconciliation.members[0].fields
const Settlement = Schema.Struct({
  accountId: AccountId,
  capturedAt: At,
  openingPositions,
  fills: Schema.Array(
    Schema.Struct({
      id,
      symbol,
      side,
      at,
      quantityAtoms,
      brokerEventId: Sha256Schema,
      accountingReceipt: Schema.NullOr(
        Schema.Struct({ id: Sha256Schema, brokerEventId: Sha256Schema, recordedAt: At }),
      ),
    }),
  ),
  reconciliation: Schema.NullOr(
    Schema.Struct({ ...reconciliationFields, id: Sha256Schema, positionSnapshotId: Sha256Schema }),
  ),
  nonFlatLedgerSymbols: Count,
})
const Accounts = Schema.Struct({ intraday: AccountId, core: AccountId, canary: AccountId })
const DossierEvidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.monday-cutover-dossier-evidence.v1'),
  preOpen: Schema.optionalKey(Schema.Struct({ accountId: AccountId, completedAt: At, report: Schema.Unknown })),
  postFlatten: Schema.optionalKey(Schema.Struct({ accounts: Accounts, startedAt: At, report: Schema.Unknown })),
  settlement: Schema.optionalKey(Settlement),
  shadowReadiness: Schema.optionalKey(Schema.NullOr(WeeklyAttributionInput.fields.sleeveReceipts.value)),
})
type DossierEvidence = typeof DossierEvidence.Type

export const decodeDossierEvidence = (json: string) =>
  Schema.decodeUnknownResult(
    Schema.fromJsonString(DossierEvidence),
    strictParseOptions,
  )(json).pipe(
    Result.mapError(
      (cause) =>
        new DossierInputError({
          code: Block.InvalidEvidence,
          message: 'Evidence must match bayn.monday-cutover-dossier-evidence.v1.',
          cause: Redacted.make(cause),
        }),
    ),
  )

// The verifier has advisory and diagnostic fields that do not participate in this gate.
const brokerCheck = <S extends Schema.Decoder<unknown>>(evidence: S) =>
  Schema.Struct({
    status: Schema.Enum(CheckStatus),
    evidence: Schema.optionalKey(evidence),
    failures: Schema.optionalKey(Schema.Array(Schema.String)),
  })
const ActiveStatus = Schema.Enum(AccountStatus)
const SleeveAccount = Schema.Struct({ accountStatus: ActiveStatus, endpoint: Schema.Enum(AlpacaEndpoint) })
const decodeVerifier = Schema.decodeUnknownResult(
  Schema.Struct({
    phase: Schema.Enum(Phase),
    verdict: Schema.Enum(CheckStatus),
    checks: Schema.Struct({
      intraday: brokerCheck(
        Schema.Struct({
          accountStatus: ActiveStatus,
          positionCount: Count,
          openOrderCount: Count,
          googlQuantities: Schema.Array(Schema.String.check(Schema.isMaxLength(64))),
          googlOpenOrders: Count,
        }),
      ),
      macroAccounts: brokerCheck(Schema.Struct({ core: SleeveAccount, canary: SleeveAccount })),
      postgres: brokerCheck(Schema.Struct({ standby: Schema.Boolean })),
    }),
  }),
)

const readVerifier = (raw: unknown, phase: Phase) => {
  const decoded = decodeVerifier(raw)
  if (Result.isFailure(decoded)) return null
  const { verdict, phase: observedPhase, checks } = decoded.success
  const { intraday, macroAccounts, postgres } = checks
  const sleeves = macroAccounts.evidence
  return {
    intraday: intraday.evidence,
    passed:
      observedPhase === phase &&
      verdict === CheckStatus.Pass &&
      [intraday, macroAccounts, postgres].every(
        ({ status, failures }) => status === CheckStatus.Pass && failures?.length === 0,
      ) &&
      intraday.evidence?.accountStatus === AccountStatus.Active &&
      sleeves !== undefined &&
      [sleeves.core, sleeves.canary].every(
        ({ accountStatus, endpoint }) => accountStatus === AccountStatus.Active && endpoint === AlpacaEndpoint.Paper,
      ) &&
      postgres.evidence?.standby === true,
  }
}

const before = (a: string, b: string) => compareAt(a, b) < 0
const within = (value: string, start: string, end: string) => !before(value, start) && before(value, end)
const fresh = (value: string, asOf: string) => !before(asOf, value) && intradayAgeNanos(asOf, value) <= maxAge
const unique = (items: readonly string[]) => new Set(items).size === items.length

type BlockingReason = { readonly code: Block; readonly message: string }
export const dossierReport = (asOf: string, blockingReasons: readonly BlockingReason[]) => ({
  schemaVersion: 'bayn.monday-cutover-dossier.v1',
  session,
  asOf,
  decision: blockingReasons.length === 0 ? DossierDecision.Authorize : DossierDecision.Hold,
  blockingReasons,
})

export const evaluateDossier = (
  { preOpen, postFlatten, settlement, shadowReadiness }: DossierEvidence,
  asOf: string,
) => {
  const reasons: BlockingReason[] = []
  const block = (code: Block, message: string) => reasons.push({ code, message })
  const opening = readVerifier(preOpen?.report, Phase.PreOpen)
  const flat = readVerifier(postFlatten?.report, Phase.PostFlatten)
  const accounts = postFlatten?.accounts

  if (preOpen === undefined || opening?.passed !== true)
    block(
      Block.PreOpenVerification,
      'A passing pre-open verifier report with all three accounts and standby is required.',
    )
  if (postFlatten === undefined || flat?.passed !== true)
    block(
      Block.PostFlattenVerification,
      'A passing post-flatten verifier report with all three accounts and standby is required.',
    )
  if (preOpen !== undefined && !within(preOpen.completedAt, dayStart, open))
    block(Block.StaleEvidence, 'The opening broker read must complete on Monday before 09:30 ET.')
  const [carry, ...otherCarry] = opening?.intraday?.googlQuantities ?? []
  const [ledgerCarry, ...otherLedgerCarry] =
    settlement?.openingPositions.filter(({ symbol }) => symbol === 'GOOGL') ?? []
  if (
    carry === undefined ||
    otherCarry.length !== 0 ||
    Result.getOrUndefined(quantityFromDecimal(carry)) !== -shares ||
    ledgerCarry === undefined ||
    otherLedgerCarry.length !== 0 ||
    BigInt(ledgerCarry.quantityAtoms) !== -shares
  )
    block(Block.OpeningCarry, 'Both the pre-open broker read and Monday opening ledger must show exactly GOOGL −103.')

  if (accounts !== undefined) {
    if (!unique([accounts.intraday, accounts.core, accounts.canary]))
      block(Block.AccountCollision, 'Accounts #1, #2 (F4), and #3 (O1) must have pairwise distinct UUIDs.')
    if (preOpen?.accountId !== accounts.intraday || settlement?.accountId !== accounts.intraday)
      block(
        Block.AccountMismatch,
        'The opening broker read and settlement must bind to the same Account #1 as the closing broker read.',
      )
  }

  const fillRows = settlement?.fills ?? []
  if (
    !unique(fillRows.map(({ id }) => id)) ||
    !unique(fillRows.map(({ brokerEventId }) => brokerEventId)) ||
    fillRows.some(
      (fill) => fill.symbol !== 'GOOGL' || fill.side !== OrderSide.Buy || !within(fill.at, open, endOpeningMinute),
    ) ||
    fillRows.reduce((total, fill) => total + BigInt(fill.quantityAtoms), 0n) !== shares
  )
    block(Block.FlattenFill, 'Unique GOOGL buy fills in the 09:30 ET opening minute must total exactly 103 shares.')

  const cut = settlement?.reconciliation
  const positionsAt = cut?.positionsAt
  if (
    cut == null ||
    positionsAt == null ||
    !cut.exact ||
    !cut.coversActivity ||
    before(cut.at, positionsAt) ||
    fillRows.some((fill) => before(positionsAt, fill.at))
  )
    block(
      Block.ReconciliationReceipt,
      'An exact reconciliation receipt and bound broker snapshot covering the fills and latest activity are required.',
    )

  const receiptIds = fillRows.flatMap(({ accountingReceipt }) =>
    accountingReceipt === null ? [] : [accountingReceipt.id],
  )
  if (
    !unique(receiptIds) ||
    fillRows.some(
      ({ accountingReceipt, brokerEventId, at }) =>
        accountingReceipt === null ||
        accountingReceipt.brokerEventId !== brokerEventId ||
        before(accountingReceipt.recordedAt, at) ||
        (cut != null && before(cut.at, accountingReceipt.recordedAt)),
    )
  )
    block(
      Block.AccountingReceipt,
      'Every flatten fill requires its own event-bound accounting receipt recorded by the reconciliation cut.',
    )

  if (
    flat?.intraday?.positionCount !== 0 ||
    flat.intraday.googlQuantities.length !== 0 ||
    flat.intraday.openOrderCount !== 0 ||
    flat.intraday.googlOpenOrders !== 0 ||
    cut?.positionCount !== 0 ||
    settlement?.nonFlatLedgerSymbols !== 0
  )
    block(
      Block.NonFlat,
      'The fresh broker and ledger evidence must show zero positions, no working broker orders, and flat inventory and basis.',
    )

  // Missing cuts are blocked above; the cuts that exist must still be ordered and current.
  const postOpenCuts = [positionsAt, cut?.at, settlement?.capturedAt, postFlatten?.startedAt].filter((at) => at != null)
  if (
    !within(asOf, open, close) ||
    postOpenCuts.some((at, i) => before(at, postOpenCuts[i - 1] ?? open) || !fresh(at, asOf))
  )
    block(
      Block.StaleEvidence,
      'The post-open cuts must be ordered (snapshot, reconciliation, settlement, broker verification) and at most 60 seconds old during Monday’s regular session.',
    )

  if (shadowReadiness == null) block(Block.ShadowReadiness, 'The $10k F4/O1 shadow portfolio receipt is missing.')
  else {
    const verified = verifyPortfolio(shadowReadiness, 0)
    if (Result.isFailure(verified)) block(Block.ShadowReadiness, verified.failure.message)
    else {
      const { intradayAccountId, core, canary } = verified.success
      if (
        accounts !== undefined &&
        (intradayAccountId !== accounts.intraday ||
          core.binding.accountId !== accounts.core ||
          canary.binding.accountId !== accounts.canary)
      )
        block(Block.AccountMismatch, 'The F4/O1 shadow portfolio UUIDs must match all three broker-verified accounts.')
      const validPlan = ({ binding, outcome }: typeof core | typeof canary) =>
        binding.mode === SleeveMode.Shadow &&
        outcome.disposition === Disposition.Shadow &&
        outcome.error === null &&
        outcome.plan?.signalSession === signalSession &&
        outcome.plan.executionSession === session
      if (
        !validPlan(core) ||
        !validPlan(canary) ||
        core.plan === undefined ||
        canary.plan === undefined ||
        core.plan.plan.blocked !== null ||
        core.plan.tif !== TimeInForce.Open ||
        core.plan.plan.budgetCents === 0 ||
        canary.plan.budgetCents === 0 ||
        compareAt(core.plan.signalCloseAt, signalClose) !== 0 ||
        compareAt(core.plan.executionOpenAt, open) !== 0 ||
        !within(core.plan.timestamp, shadowReadyAt, shadowCutoff) ||
        !within(canary.plan.observedAt, shadowReadyAt, shadowCutoff)
      )
        block(
          Block.ShadowReadiness,
          'Both $10k sleeves need unblocked Shadow plans for Friday’s signal and Monday’s next open, captured before 09:28 ET.',
        )
    }
  }

  return dossierReport(asOf, reasons)
}
