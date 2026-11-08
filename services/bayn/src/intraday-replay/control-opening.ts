import { Effect, FileSystem, Path, Result, Schema } from 'effect'

import { BrokerEnvironment } from '../broker/identity'
import type { AuthorityState } from '../execution/contracts'
import { canonicalHashV1Result, sha256 } from '../hash'
import { JevPurpose } from '../jev/portfolio'
import type { ReconciliationPassResult } from '../reconciler'
import { strictParseOptions } from '../schemas'
import { ControlStudyOpeningSchema, ControlStudyPlanSchema } from './control-binding'
import { ControlStudyFailure } from './control-portfolio'

type Plan = typeof ControlStudyPlanSchema.Type
type Opening = typeof ControlStudyOpeningSchema.Type
type ControlOpeningRuntime = Pick<Opening, 'broker' | 'requestHash' | 'build'> & {
  readonly policy: Opening['inputs']['policy']
}

export const verifyControlOpeningRuntime = (plan: Plan, runtime: ControlOpeningRuntime) =>
  Result.gen(function* () {
    if (
      runtime.broker.environment !== BrokerEnvironment.Sandbox ||
      runtime.broker.identityHash !== plan.candidate.broker.identityHash ||
      runtime.requestHash !== plan.candidate.requestHash ||
      (yield* canonicalHashV1Result(runtime.build)) !==
        (yield* canonicalHashV1Result(plan.controlTemplate.backtest.build)) ||
      (yield* canonicalHashV1Result(runtime.policy)) !== (yield* canonicalHashV1Result(plan.candidate.riskPolicy))
    )
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Frozen plan differs from the deployed sandbox runtime' }),
      )
  })

/** Normal reconciliation may retain accounting and restrict authority; it has no broker mutation capability. */
export const captureControlStudyOpening = <E1, R1, E2, R2>(
  plan: Plan,
  runtime: ControlOpeningRuntime,
  dependencies: {
    readonly readAuthority: Effect.Effect<AuthorityState, E1, R1>
    readonly reconcile: Effect.Effect<ReconciliationPassResult, E2, R2>
    readonly now: Effect.Effect<string>
  },
) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(verifyControlOpeningRuntime(plan, runtime))
    const before = yield* dependencies.readAuthority
    if (before.generationHash !== plan.candidate.authorityGenerationHash)
      return yield* new ControlStudyFailure({ message: 'Current authority differs from the frozen candidate' })
    const pass = yield* dependencies.reconcile
    const { riskContext, brokerState, report } = pass
    if (
      brokerState.account.accountId !== runtime.broker.accountId ||
      riskContext.authority?.generationHash !== plan.candidate.authorityGenerationHash
    )
      return yield* new ControlStudyFailure({ message: 'Reconciliation changed the candidate account or authority' })
    // Preserve the pass verbatim, including used budgets and restrictions. Binding decides whether it is admissible.
    return yield* Schema.decodeUnknownEffect(
      ControlStudyOpeningSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.control-study-opening.v1',
      broker: runtime.broker,
      requestHash: runtime.requestHash,
      build: runtime.build,
      dailyTradedNotionalMicros: riskContext.dailyTradedNotionalMicros,
      inputs: {
        schemaVersion: 'bayn.account-protection-inputs.v1',
        observedAt: yield* dependencies.now,
        portfolio: { purpose: JevPurpose.Entry, brokerState },
        policy: runtime.policy,
        authority: riskContext.authority,
        authorityObservedAt: riskContext.authorityObservedAt,
        reconciliation: report.reconciliation,
        accountingExact: report.metrics.accountingExact,
        tradingDate: riskContext.tradingDate,
        unknownMutationCount: riskContext.unknownMutationCount,
        dayStartEquityMicros: riskContext.dayStartEquityMicros,
        peakEquityMicros: riskContext.peakEquityMicros,
      },
    })
  })

export const retainControlStudyOpening = <E, R>(
  outputPath: string,
  planSha256: string,
  capture: Effect.Effect<Opening, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Claim the directory before reconciliation so a repeated output cannot repeat financial work.
    yield* fs.makeDirectory(outputPath, { mode: 0o700 })
    const opening = yield* capture
    const text = `${JSON.stringify(opening, null, 2)}\n`
    const openingSha256 = sha256(text)
    yield* fs.writeFileString(path.join(outputPath, 'opening.json'), text, { flag: 'wx', mode: 0o600 })
    const receipt = {
      schemaVersion: 'bayn.control-study-opening-receipt.v1',
      planSha256,
      openingSha256,
      observedAt: opening.inputs.observedAt,
      claims: 'Native reconciliation capture only; binding must verify pre-open freshness and admissibility',
    }
    const temporary = path.join(outputPath, 'opening-receipt.json.tmp')
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    yield* fs.rename(temporary, path.join(outputPath, 'opening-receipt.json'))
    return { outputPath, openingSha256 }
  })
