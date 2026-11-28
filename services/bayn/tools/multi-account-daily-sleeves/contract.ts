import { Data, Result, Schema, SchemaIssue } from 'effect'

import { canonicalHashV1Result } from '../../src/hash'
import { IsoDateSchema, Sha256Schema, strictParseOptions } from '../../src/schemas'
import { macroCanaryEtfs } from '../../src/strategy/macro-canary-etf/policy'
import { universe } from '../../src/strategy/macro-etf-core/policy'
import { AccountId } from '../macro-canary-runner/alpaca'
import { overnightCapCents } from '../macro-canary-runner/planner'
import { intradaySymbols, RunnerProfile } from '../macro-etf-core-runner/contract'

export enum Strategy {
  MacroEtfCore = 'MacroEtfCore',
  MacroCanaryEtf = 'MacroCanaryEtf',
}

export enum CanaryProfile {
  O1 = 'O1',
}

export enum SleeveMode {
  Shadow = 'Shadow',
  PaperSubmit = 'PaperSubmit',
}

const Symbol = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,14}$/))
const Sleeve = Schema.Struct({
  sleeveId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  strategy: Schema.Enum(Strategy),
  profile: Schema.Union([Schema.Enum(RunnerProfile), Schema.Enum(CanaryProfile)]),
  accountId: AccountId,
  credentialsEnvPrefix: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/)),
  capitalBudgetUsd: Schema.Finite.check(
    Schema.makeFilter((value) => {
      const cents = Math.round(value * 100)
      return cents > 0 && cents <= overnightCapCents && cents / 100 === value
    }),
  ),
  excludeSymbols: Schema.optionalKey(Schema.Array(Symbol)),
  mode: Schema.optionalKey(Schema.Enum(SleeveMode)),
})
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-account-daily-sleeves-config.v1'),
  intradayAccountId: AccountId,
  allowSharedAccount: Schema.optionalKey(Schema.Boolean),
  sleeves: Schema.NonEmptyArray(Sleeve),
})
const AccountEvidence = Schema.Struct({
  accountId: AccountId,
  snapshotSha256: Sha256Schema,
  remainingOneWayTurnoverBps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const CanaryEvidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.macro-canary-next-open-evidence.v1'),
  signalSession: IsoDateSchema,
  executionSession: IsoDateSchema,
  marketSha256: Sha256Schema,
  accounts: Schema.Array(AccountEvidence),
})

const schemaFields = new Set([
  ...Object.keys(Manifest.fields),
  ...Object.keys(Sleeve.fields),
  ...Object.keys(CanaryEvidence.fields),
  ...Object.keys(AccountEvidence.fields),
])
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => issue._tag,
  checkHook: (issue) => issue.issue._tag,
})
const redactedSchemaCause = ({ issue }: Schema.SchemaError) =>
  formatIssue(issue).issues.map(({ message, path }) => ({
    kind: message,
    path: (path ?? []).map((segment) =>
      typeof segment === 'number' || (typeof segment === 'string' && schemaFields.has(segment))
        ? segment
        : '[redacted]',
    ),
  }))

export type FailureDetail = Readonly<{
  stage: string
  code: string
  cause?: object
}>
export class DailySleeveFailure extends Data.TaggedError('DailySleeveFailure')<FailureDetail> {
  override get message(): string {
    return `${this.stage}: ${this.code}`
  }
}

export const decodeCanaryEvidence = (json: string) =>
  Schema.decodeUnknownResult(
    Schema.fromJsonString(CanaryEvidence),
    strictParseOptions,
  )(json).pipe(
    Result.mapError(
      (cause) =>
        new DailySleeveFailure({
          stage: 'configuration',
          code: 'InvalidCanaryEvidence',
          cause: { issues: redactedSchemaCause(cause) },
        }),
    ),
    Result.flatMap((evidence) =>
      new Set(evidence.accounts.map(({ accountId }) => accountId)).size === evidence.accounts.length
        ? Result.succeed(evidence)
        : Result.fail(new DailySleeveFailure({ stage: 'configuration', code: 'DuplicateCanaryEvidenceAccount' })),
    ),
  )
export type VerifiedCanaryEvidenceInput = Result.Result.Success<ReturnType<typeof decodeCanaryEvidence>>

export const decodeManifest = (json: string, confirmPaperSubmit: boolean) =>
  Result.gen(function* () {
    const manifest = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(Manifest),
      strictParseOptions,
    )(json).pipe(
      Result.mapError(
        (cause) =>
          new DailySleeveFailure({
            stage: 'configuration',
            code: 'InvalidManifest',
            cause: { issues: redactedSchemaCause(cause) },
          }),
      ),
    )
    const allowSharedAccount = manifest.allowSharedAccount ?? false
    const sleeveIds = new Set<string>()
    const accounts = new Map<string, Map<string, string>>()
    const sleeves = []
    for (const [index, raw] of manifest.sleeves.entries()) {
      const reject = (code: string, cause: object = {}) =>
        Result.fail(new DailySleeveFailure({ stage: 'isolation', code, cause: { index, ...cause } }))
      if (sleeveIds.has(raw.sleeveId)) return yield* reject('DuplicateSleeveId')
      sleeveIds.add(raw.sleeveId)
      const canary = raw.profile === CanaryProfile.O1
      if (canary !== (raw.strategy === Strategy.MacroCanaryEtf)) return yield* reject('IncompatibleStrategyProfile')
      const mode = raw.mode ?? SleeveMode.Shadow
      if (mode === SleeveMode.PaperSubmit && !confirmPaperSubmit) return yield* reject('PaperSubmitNotConfirmed')
      const excluded = new Set(raw.excludeSymbols)
      const activeSymbols = (canary ? macroCanaryEtfs : universe).filter((symbol) => !excluded.has(symbol)).sort()
      if (activeSymbols.length === 0) return yield* reject('EmptyActiveUniverse')
      if (
        raw.accountId === manifest.intradayAccountId &&
        (!allowSharedAccount || intradaySymbols.some((s) => !excluded.has(s)))
      )
        return yield* reject('IntradayAccountNotIsolated')
      const registered = accounts.get(raw.accountId)
      if (registered !== undefined) {
        if (!allowSharedAccount) return yield* reject('DuplicateAccount')
        for (const symbol of activeSymbols) {
          if (registered.has(symbol)) return yield* reject('SharedAccountSymbolOverlap', { symbol })
        }
      }
      const ownerBySymbol = registered ?? new Map<string, string>()
      for (const symbol of activeSymbols) ownerBySymbol.set(symbol, raw.sleeveId)
      accounts.set(raw.accountId, ownerBySymbol)
      sleeves.push({
        ...raw,
        mode,
        excludeSymbols: [...excluded].sort(),
        activeSymbols,
        capitalBudgetCents: Math.round(raw.capitalBudgetUsd * 100),
      })
    }
    return {
      intradayAccountId: manifest.intradayAccountId,
      allowSharedAccount,
      sleeves: sleeves.toSorted((a, b) => a.sleeveId.localeCompare(b.sleeveId)),
    }
  })

export type DailyManifest = Result.Result.Success<ReturnType<typeof decodeManifest>>
export type DailySleeve = DailyManifest['sleeves'][number]
export type Exposure = Readonly<{ symbol: string; targetCents: number }>

export type SleeveOutcome = Readonly<{
  sleeveId: string
  accountId: string
  verifiedAccountId: string | null
  disposition: 'shadow' | 'submitted' | 'no-orders' | 'withheld' | 'failed'
  plan: {
    readonly signalSession: string
    readonly executionSession: string
    readonly targetExposure: readonly Exposure[] | null
    readonly receipt: object
  } | null
  error: FailureDetail | null
}>

export const makePortfolioReceipt = (manifest: DailyManifest, outcomes: readonly SleeveOutcome[]) =>
  Result.gen(function* () {
    const exposure = new Map<string, number>()
    for (const outcome of outcomes)
      for (const { symbol, targetCents } of outcome.plan?.targetExposure ?? [])
        exposure.set(symbol, (exposure.get(symbol) ?? 0) + targetCents)
    const material = {
      schemaVersion: 'bayn.multi-account-daily-sleeves-receipt.v1',
      isolation: {
        intradayAccountId: manifest.intradayAccountId,
        intradayReservedSymbols: intradaySymbols,
        allowSharedAccount: manifest.allowSharedAccount,
        manifestValidated: true,
        allBrokerAccountsVerified: outcomes.every(
          ({ accountId, verifiedAccountId }) => accountId === verifiedAccountId,
        ),
        bindings: manifest.sleeves.map(
          ({ sleeveId, accountId, strategy, profile, activeSymbols, excludeSymbols, mode, capitalBudgetCents }) => ({
            sleeveId,
            accountId,
            strategy,
            profile,
            activeSymbols,
            excludeSymbols,
            mode,
            capitalBudgetCents,
          }),
        ),
      },
      aggregateTargetExposure: {
        // Off-cadence sleeves give no actionable target; this is neither actual positions nor order notional.
        targetCentsBySymbol: Object.fromEntries(exposure),
        complete: outcomes.every(({ error }) => error === null),
        includedSleeveIds: outcomes
          .filter(({ plan }) => plan !== null && plan.targetExposure !== null)
          .map(({ sleeveId }) => sleeveId),
      },
      sleeves: outcomes,
    }
    const portfolioSha256 = yield* canonicalHashV1Result(material)
    return { ...material, portfolioSha256 }
  })
