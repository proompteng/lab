import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Config, Console, Effect, FileSystem, Layer, Logger, Result, Schema, type PlatformError } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { MacroEtfCoreEvidenceError } from '../src/strategy/macro-etf-core/policy'
import { makeAlpaca, paperOrigin, type Alpaca } from './macro-canary-runner/alpaca'
import { RebalanceFailure as BrokerFailure, TimeInForce } from './macro-canary-runner/contract'
import {
  hashEvidence,
  newPrivateFile,
  readSnapshot,
  submitPaperRebalance,
  writeRecord,
} from './macro-canary-runner/paper-rebalance'
import { RebalanceFailure as CoreFailure } from './macro-etf-core-runner/contract'
import {
  CanaryProfile,
  DailySleeveFailure,
  decodeCanaryEvidence,
  decodeManifest,
  makePortfolioReceipt,
  SleeveMode,
  type DailySleeve,
  type FailureDetail,
  type SleeveOutcome,
  type VerifiedCanaryEvidenceInput,
} from './multi-account-daily-sleeves/contract'
import { prepareCanaryRebalance } from './multi-account-daily-sleeves/macro-canary'
import { orderPrefix } from './macro-etf-core-runner/planner'
import { prepareMacroEtfCoreRebalance } from './macro-etf-core-runner/rebalance'

const usage =
  'Usage: bun services/bayn/tools/run-multi-account-daily-sleeves.ts --manifest <file.json> --output <new-receipt.json>\n' +
  '  [--canary-evidence <verified-evidence.json>] [--confirm-paper-submit]'

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            manifest: { type: 'string' },
            output: { type: 'string' },
            'canary-evidence': { type: 'string' },
            'confirm-paper-submit': { type: 'boolean', default: false },
          },
          tokens: true,
        }),
      catch: () => new DailySleeveFailure({ stage: 'arguments', code: 'InvalidOptions' }),
    })
    if (
      new Set(tokens.map((token) => (token.kind === 'option' ? token.name : ''))).size !== tokens.length ||
      values.manifest === undefined ||
      values.manifest.trim() === '' ||
      values.output === undefined ||
      values.output.trim() === '' ||
      values['canary-evidence']?.trim() === ''
    )
      return yield* Result.fail(new DailySleeveFailure({ stage: 'arguments', code: 'InvalidOptions' }))
    return {
      manifest: values.manifest,
      output: values.output,
      evidence: values['canary-evidence'],
      confirmPaperSubmit: values['confirm-paper-submit'],
    }
  })

const fileFailure = (stage: string) => (cause: PlatformError.PlatformError) =>
  new DailySleeveFailure({
    stage,
    code: 'FileOperationFailed',
    cause: { kind: cause.reason._tag },
  })

const brokerCauseSchema = Schema.Union([
  Schema.Struct({ status: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literals([
      'Composite',
      'AnyOf',
      'InvalidType',
      'InvalidValue',
      'Filter',
      'Pointer',
      'Encoding',
      'AccountMismatch',
    ]),
  }),
  Schema.Literals([
    'TransportError',
    'EncodeError',
    'ResponseError',
    'DecodeError',
    'StatusCodeError',
    'EmptyBodyError',
  ]),
])
const redactedCause = (cause: unknown): object => {
  if (cause instanceof MacroEtfCoreEvidenceError) return { kind: cause._tag, cause: redactedCause(cause.cause) }
  if (cause instanceof BrokerFailure || cause instanceof CoreFailure)
    return { kind: cause._tag, operation: cause.stage, cause: redactedCause(cause.cause) }
  if (Schema.is(brokerCauseSchema)(cause)) {
    if (typeof cause === 'string') return { kind: cause }
    return 'status' in cause ? { status: cause.status } : { kind: cause.kind }
  }
  return { kind: 'DetailsRedacted' }
}
const operationalFailure = (stage: string) => (cause: BrokerFailure | CoreFailure | MacroEtfCoreEvidenceError) =>
  new DailySleeveFailure({ stage, code: cause._tag, cause: redactedCause(cause) })

const describeFailure = ({ stage, code, cause }: DailySleeveFailure): FailureDetail => ({
  stage,
  code,
  ...(cause === undefined ? {} : { cause }),
})

const accountClient = (sleeve: DailySleeve) =>
  Effect.gen(function* () {
    // This runner has no configurable trading origin or unprefixed credential fallback.
    const credentials = yield* Config.all({
      key: Config.Redacted(`${sleeve.credentialsEnvPrefix}_ALPACA_KEY_ID`),
      secret: Config.Redacted(`${sleeve.credentialsEnvPrefix}_ALPACA_SECRET_KEY`),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DailySleeveFailure({
            stage: 'credentials',
            code: 'MissingOrInvalidCredentials',
            cause: { kind: cause._tag },
          }),
      ),
    )
    return yield* makeAlpaca(paperOrigin, credentials.key, credentials.secret).pipe(
      Effect.mapError(operationalFailure('credentials')),
    )
  })

const prepare = Effect.fn('multi-account-daily-sleeves.prepare')(function* (
  sleeve: DailySleeve,
  alpaca: Alpaca,
  snapshot: Effect.Success<ReturnType<typeof readSnapshot>>,
  evidence: VerifiedCanaryEvidenceInput | undefined,
) {
  const snapshotSha256 = yield* hashEvidence(snapshot).pipe(Effect.mapError(operationalFailure('reconcile')))
  if (sleeve.profile === CanaryProfile.O1) {
    const { plan, window, targetExposure } = yield* prepareCanaryRebalance(
      alpaca,
      snapshot,
      snapshotSha256,
      sleeve,
      evidence,
    ).pipe(
      Effect.mapError((cause) => (cause instanceof DailySleeveFailure ? cause : operationalFailure('plan')(cause))),
    )
    return { window, targetExposure, receipt: plan, orders: plan.orders, planSha256: plan.planSha256 }
  }
  const { material, window, timestamp } = yield* prepareMacroEtfCoreRebalance(alpaca, snapshot, {
    profile: sleeve.profile,
    excludeSymbols: sleeve.excludeSymbols,
    capitalBudgetCents: sleeve.capitalBudgetCents,
    tif: TimeInForce.Open,
  }).pipe(Effect.mapError(operationalFailure('plan')))
  if (material.plan.blocked !== null && sleeve.mode === SleeveMode.PaperSubmit)
    return yield* new DailySleeveFailure({
      stage: 'plan',
      code: 'CoreBrokerStateBlocked',
      cause: { reason: material.plan.blocked },
    })

  const planEvidence = {
    ...material,
    schemaVersion: 'bayn.macro-etf-core-next-open-sleeve-receipt.v1',
    snapshotSha256,
  }
  const planSha256 = yield* hashEvidence(planEvidence).pipe(Effect.mapError(operationalFailure('receipt')))
  const targetExposure =
    material.allocation.targets
      ?.filter(({ symbol }) => sleeve.activeSymbols.some((active) => active === symbol))
      .map(({ symbol, weight }) => ({ symbol, targetCents: Math.floor(weight * material.plan.budgetCents) })) ?? null
  return {
    window,
    targetExposure,
    receipt: { ...planEvidence, mode: sleeve.mode, timestamp, planSha256 },
    orders: material.plan.orders,
    planSha256,
  }
})

export const runDailySleeves = Effect.fn('multi-account-daily-sleeves.run')(function* (args: readonly string[]) {
  const options = yield* Effect.fromResult(parseOptions(args))
  const fs = yield* FileSystem.FileSystem
  const manifestJson = yield* fs.readFileString(options.manifest).pipe(Effect.mapError(fileFailure('manifest')))
  const manifest = yield* Effect.fromResult(decodeManifest(manifestJson, options.confirmPaperSubmit))
  const evidence =
    options.evidence === undefined
      ? undefined
      : yield* fs.readFileString(options.evidence).pipe(
          Effect.mapError(fileFailure('evidence')),
          Effect.flatMap((json) => Effect.fromResult(decodeCanaryEvidence(json))),
        )
  // Reserve the requested path before network or mutation. A duplicate output never authorizes another run.
  const output = yield* fs.open(options.output, newPrivateFile).pipe(Effect.mapError(fileFailure('receipt')))
  const directory = yield* fs.open(dirname(options.output), { flag: 'r' }).pipe(Effect.mapError(fileFailure('receipt')))
  yield* directory.sync.pipe(Effect.mapError(fileFailure('receipt')))

  const outcomes: SleeveOutcome[] = []
  const pending: Array<{
    outcome: SleeveOutcome
    submit: Effect.Effect<void, DailySleeveFailure, FileSystem.FileSystem | import('effect/Scope').Scope>
  }> = []
  let sessions: { signalSession: string; executionSession: string } | undefined
  const writers = new Set<string>()
  for (const sleeve of manifest.sleeves) {
    const binding = { sleeveId: sleeve.sleeveId, accountId: sleeve.accountId }
    const reconciled = yield* Effect.result(
      Effect.gen(function* () {
        const alpaca = yield* accountClient(sleeve)
        const snapshot = yield* readSnapshot(alpaca, sleeve.accountId).pipe(
          Effect.mapError(operationalFailure('reconcile')),
        )
        return { alpaca, snapshot }
      }),
    )
    if (Result.isFailure(reconciled)) {
      outcomes.push({
        ...binding,
        verifiedAccountId: null,
        disposition: 'failed',
        plan: null,
        error: describeFailure(reconciled.failure),
      })
      continue
    }

    const { alpaca, snapshot } = reconciled.success
    const verified = { ...binding, verifiedAccountId: snapshot.account.id }
    const prepared = yield* Effect.result(prepare(sleeve, alpaca, snapshot, evidence))
    if (Result.isFailure(prepared)) {
      outcomes.push({ ...verified, disposition: 'failed', plan: null, error: describeFailure(prepared.failure) })
      continue
    }

    const { window, targetExposure, receipt, orders, planSha256 } = prepared.success
    const { lastDate: signalSession, executionDate: executionSession } = window
    const plan = { signalSession, executionSession, targetExposure, receipt }
    const mutates = sleeve.mode === SleeveMode.PaperSubmit && orders.length > 0
    const error =
      sessions !== undefined &&
      (sessions.signalSession !== signalSession || sessions.executionSession !== executionSession)
        ? { stage: 'calendar', code: 'PortfolioSessionsDiffer' }
        : mutates && writers.has(sleeve.accountId)
          ? { stage: 'isolation', code: 'MultipleMutatingSleevesForAccount' }
          : null
    if (error !== null) {
      outcomes.push({ ...verified, disposition: 'failed', plan: null, error })
      continue
    }
    sessions = { signalSession, executionSession }
    if (mutates) writers.add(sleeve.accountId)
    const outcome = {
      ...verified,
      plan,
      error: null,
      disposition: sleeve.mode === SleeveMode.Shadow ? 'shadow' : mutates ? 'withheld' : 'no-orders',
    } as const
    outcomes.push(outcome)
    if (mutates)
      pending.push({
        outcome,
        submit: submitPaperRebalance({
          alpaca,
          snapshot,
          window,
          orders,
          planSha256,
          output: options.output,
          journalPlan: { ...verified, ...plan },
          // The Wave 9C fence is account/session-wide for both portfolio strategies.
          journalPrefix: orderPrefix(snapshot.account.id, window.executionDate),
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof BrokerFailure
              ? operationalFailure('paper-submit')(cause)
              : fileFailure('paper-submit')(cause),
          ),
        ),
      })
  }

  // Plan and verify the entire portfolio before mutating any account. A failed dispatch withholds later writers;
  // orders already acknowledged on an independent account are not rolled back.
  if (outcomes.every(({ error }) => error === null)) {
    for (const { outcome, submit } of pending) {
      const result = yield* Effect.result(Effect.scoped(submit))
      const index = outcomes.indexOf(outcome)
      if (Result.isFailure(result)) {
        outcomes[index] = { ...outcome, disposition: 'failed', error: describeFailure(result.failure) }
        break
      }
      outcomes[index] = { ...outcome, disposition: 'submitted' }
    }
  }

  const receipt = yield* Effect.fromResult(makePortfolioReceipt(manifest, outcomes)).pipe(
    Effect.mapError(
      (cause) => new DailySleeveFailure({ stage: 'receipt', code: 'CannotHashPortfolio', cause: { kind: cause._tag } }),
    ),
  )
  yield* writeRecord(output, receipt).pipe(
    Effect.mapError((cause) =>
      cause instanceof BrokerFailure ? operationalFailure('receipt')(cause) : fileFailure('receipt')(cause),
    ),
  )
  if (!receipt.aggregateTargetExposure.complete)
    return yield* new DailySleeveFailure({
      stage: 'portfolio',
      code: 'SleeveFailed',
      cause: {
        portfolioSha256: receipt.portfolioSha256,
        errors: outcomes.flatMap(({ sleeveId, error }) => (error === null ? [] : [{ sleeveId, ...error }])),
      },
    })
  return receipt
})

const runtime = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer, Logger.layer([Logger.consoleJson]))
if (import.meta.main) {
  const args = process.argv.slice(2)
  NodeRuntime.runMain(
    args.length === 1 && args[0] === '--help'
      ? Console.log(usage)
      : runDailySleeves(args).pipe(
          Effect.scoped,
          Effect.flatMap(({ portfolioSha256 }) => Effect.logInfo('Daily sleeves receipt written', { portfolioSha256 })),
          // @effect-diagnostics-next-line strictEffectProvide:off -- entry point owns HTTP and receipt files
          Effect.provide(runtime),
        ),
  )
}
