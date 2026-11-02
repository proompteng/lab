import { Data, Result, Schema } from 'effect'

import { AutonomousCycleSchema } from './cycle/model'
import { makeExecutionCalendarObservation } from './cycle/construction'
import { ExecutionModelV6Schema } from './execution-model-contract'
import { canonicalHashV1Result } from './hash'
import { continuousExecutionPolicy, isContinuousMarket, marketHoursAreCanonical } from './market-hours'
import { SnapshotCalendarSchema } from './market-data/streaming/manifest-schema'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'

const PlanningBrokerStateSchema = Schema.Struct({ observedAt: UtcInstantSchema, contentHash: Sha256Schema })
const SessionSchema = Schema.Struct({ date: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema })
const OffsetMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 }))
const BindingBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-session-binding.v3'),
  planningBrokerState: PlanningBrokerStateSchema,
  calendar: SnapshotCalendarSchema,
  executionSession: SessionSchema,
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  decisionAfterOpenMs: OffsetMs,
  submissionCutoffAfterOpenMs: OffsetMs,
  bindingHash: Sha256Schema,
})

const bindingIssues = (binding: typeof BindingBase.Type): Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const { bindingHash, ...material } = binding
  const hash = canonicalHashV1Result(material)
  if (Result.isFailure(hash) || hash.success !== bindingHash)
    issues.push({ path: ['bindingHash'], issue: 'must match the canonical execution binding' })
  const session = binding.executionSession
  const open = Date.parse(session.openAt)
  const close = Date.parse(session.closeAt)
  const observed = Date.parse(binding.planningBrokerState.observedAt)
  const expectedOpen = Math.max(open + binding.decisionAfterOpenMs, observed)
  if (
    open >= close ||
    binding.submissionOpenAt !== new Date(expectedOpen).toISOString() ||
    Date.parse(binding.submissionCutoffAt) !== open + binding.submissionCutoffAfterOpenMs ||
    binding.submissionOpenAt >= binding.submissionCutoffAt ||
    binding.submissionCutoffAt > session.closeAt
  )
    issues.push({
      path: ['executionSession'],
      issue: 'must reproduce a finite, nonempty window within the market bound',
    })
  if (isContinuousMarket(binding.calendar)) {
    if (
      session.date !== session.openAt.slice(0, 10) ||
      binding.decisionAfterOpenMs !== 0 ||
      binding.submissionCutoffAfterOpenMs !== continuousExecutionPolicy.entryValidityMs ||
      close - open !==
        continuousExecutionPolicy.entryValidityMs +
          continuousExecutionPolicy.maximumHoldingMs +
          continuousExecutionPolicy.closeRecoveryMs
    )
      issues.push({ path: ['executionSession'], issue: 'continuous execution must use the reviewed finite lease' })
  } else {
    const calendar = binding.calendar
    const { normalizedResponseHash, ...calendarMaterial } = calendar
    const calendarHash = canonicalHashV1Result(calendarMaterial)
    if (
      !marketHoursAreCanonical(calendar) ||
      Result.isFailure(calendarHash) ||
      calendarHash.success !== normalizedResponseHash ||
      !calendar.sessions.some(
        (entry) => entry.date === session.date && entry.openAt === session.openAt && entry.closeAt === session.closeAt,
      )
    )
      issues.push({ path: ['calendar'], issue: 'must bind the exact authoritative exchange session' })
    let previous = ''
    for (const entry of calendar.sessions) {
      if (
        entry.date <= previous ||
        entry.date < calendar.requestedRange.start ||
        entry.date > calendar.requestedRange.end ||
        !entry.openAt.startsWith(entry.date) ||
        !entry.closeAt.startsWith(entry.date) ||
        entry.openAt >= entry.closeAt
      )
        issues.push({
          path: ['calendar'],
          issue: 'exchange sessions must be ordered within the observed calendar range',
        })
      previous = entry.date
    }
  }
  return issues
}

export const ExecutionSessionBindingSchema = BindingBase.check(Schema.makeFilter(bindingIssues))
export type ExecutionSessionBinding = typeof ExecutionSessionBindingSchema.Type

export class ExecutionSessionBindingFailure extends Data.TaggedError('ExecutionSessionBindingFailure')<{
  readonly operation: 'bind-cycle'
  readonly reason: 'decode' | 'hash' | 'cycle-calendar' | 'cycle-policy' | 'cycle-window'
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}

const failure = (reason: ExecutionSessionBindingFailure['reason'], message: string, cause?: unknown) =>
  new ExecutionSessionBindingFailure({
    operation: 'bind-cycle',
    reason,
    message,
    facts: {},
    ...(cause === undefined ? {} : { cause }),
  })

const InputSchema = Schema.Struct({
  cycle: AutonomousCycleSchema,
  executionSessionDate: IsoDateSchema,
  planningBrokerState: PlanningBrokerStateSchema,
  calendar: SnapshotCalendarSchema,
  executionModel: ExecutionModelV6Schema,
})

export interface BindCycleExecutionSessionInput {
  readonly cycle: typeof AutonomousCycleSchema.Type
  readonly executionSessionDate: string
  readonly planningBrokerState: { readonly observedAt: string; readonly contentHash: string }
  readonly calendar: import('./market-hours').MarketHours
  readonly executionModel: import('./execution-model-contract').CycleExecutionModel
}

export const bindCycleExecutionSession = (
  input: unknown,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> =>
  Result.gen(function* () {
    const request = yield* Schema.decodeUnknownResult(
      InputSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) =>
        failure('decode', 'execution binding requires the current cycle and execution model', cause),
      ),
    )
    const { cycle, calendar, executionModel, planningBrokerState } = request
    if (
      cycle.schemaVersion !== 'bayn.autonomous-cycle.v4' ||
      cycle.identity.schemaVersion !== 'bayn.autonomous-cycle-identity.v4' ||
      cycle.window.schemaVersion !== 'bayn.autonomous-cycle-window.v3' ||
      cycle.identity.executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3'
    )
      return yield* Result.fail(failure('cycle-policy', 'retired cycles are not executable'))
    const policy = cycle.identity.executionPolicy
    const modelHash = yield* canonicalHashV1Result(executionModel).pipe(
      Result.mapError((cause) => failure('hash', 'execution model is not canonical', cause)),
    )
    if (
      modelHash !== policy.strategyExecutionModelHash ||
      executionModel.order.warmupAfterOpenMs !== policy.warmupAfterOpenMs ||
      executionModel.order.submissionCutoffBeforeCloseMs !== policy.submissionCutoffBeforeCloseMs
    )
      return yield* Result.fail(
        new ExecutionSessionBindingFailure({
          operation: 'bind-cycle',
          reason: 'cycle-policy',
          message: 'execution model differs from the durable cycle policy',
          facts: { field: 'strategyExecutionModelHash' },
        }),
      )
    const session = {
      date: cycle.identity.executionSessionDate,
      openAt: cycle.window.executionOpenAt,
      closeAt: cycle.window.executionCloseAt,
    }
    if (!isContinuousMarket(calendar)) {
      const observed = calendar.sessions.find((entry) => entry.date === session.date)
      if (observed === undefined || observed.openAt !== session.openAt || observed.closeAt !== session.closeAt)
        return yield* Result.fail(
          new ExecutionSessionBindingFailure({
            operation: 'bind-cycle',
            reason: 'cycle-calendar',
            message: 'authoritative exchange hours differ from the durable cycle',
            facts: { field: observed?.openAt !== session.openAt ? 'executionOpenAt' : 'executionCloseAt' },
          }),
        )
    }
    const selected = yield* makeExecutionCalendarObservation({
      schemaVersion: calendar.schemaVersion,
      source: calendar.source,
      ...session,
    }).pipe(
      Result.mapError((cause) => failure('cycle-calendar', 'market hours do not bind this execution window', cause)),
    )
    if (
      request.executionSessionDate !== session.date ||
      selected.executionCalendarHash !== cycle.identity.executionCalendarHash
    )
      return yield* Result.fail(failure('cycle-calendar', 'market hours differ from the durable cycle'))
    const open = Date.parse(session.openAt)
    const material = {
      schemaVersion: 'bayn.execution-session-binding.v3' as const,
      planningBrokerState,
      calendar,
      executionSession: session,
      submissionOpenAt: new Date(
        Math.max(Date.parse(cycle.window.submissionOpenAt), Date.parse(planningBrokerState.observedAt)),
      ).toISOString(),
      submissionCutoffAt: cycle.window.submissionCutoffAt,
      decisionAfterOpenMs: Date.parse(cycle.window.submissionOpenAt) - open,
      submissionCutoffAfterOpenMs: Date.parse(cycle.window.submissionCutoffAt) - open,
    }
    const bindingHash = yield* canonicalHashV1Result(material).pipe(
      Result.mapError((cause) => failure('hash', 'execution window is not canonical', cause)),
    )
    return yield* Schema.decodeUnknownResult(
      ExecutionSessionBindingSchema,
      strictParseOptions,
    )({ ...material, bindingHash }).pipe(
      Result.mapError((cause) => failure('cycle-window', 'execution window does not reproduce', cause)),
    )
  })
