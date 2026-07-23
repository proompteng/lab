import { Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import { makeExecutionCalendarObservation, type AutonomousCycle } from './cycle'
import { canonicalHashV1 } from './hash'
import type { ExecutionModel } from './protocol'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions as StrictParseOptions } from './schemas'

const CalendarIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  requestedRange: Schema.Struct({
    start: IsoDateSchema,
    end: IsoDateSchema,
  }),
  timeZone: Schema.Literal('UTC'),
  sessions: Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      openAt: UtcInstantSchema,
      closeAt: UtcInstantSchema,
    }),
  ).check(Schema.isMinLength(1)),
  normalizedResponseHash: Sha256Schema,
})

const ExecutionSessionBindingBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-session-binding.v1'),
  signal: Schema.Struct({
    sessionDate: IsoDateSchema,
    finalizedAt: UtcInstantSchema,
    contentHash: Sha256Schema,
  }),
  planningBrokerState: Schema.Struct({
    observedAt: UtcInstantSchema,
    contentHash: Sha256Schema,
  }),
  calendar: CalendarIdentitySchema,
  executionSession: Schema.Struct({
    date: IsoDateSchema,
    openAt: UtcInstantSchema,
    closeAt: UtcInstantSchema,
  }),
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  submissionCutoffLeadMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
  bindingHash: Sha256Schema,
})

export const ExecutionSessionBindingSchema = ExecutionSessionBindingBase.check(
  Schema.makeFilter((binding: typeof ExecutionSessionBindingBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    if (binding.signal.sessionDate >= binding.executionSession.date) {
      issues.push({ path: ['executionSession', 'date'], issue: 'must follow the finalized signal session' })
    }
    if (binding.calendar.requestedRange.start > binding.signal.sessionDate) {
      issues.push({
        path: ['calendar', 'requestedRange', 'start'],
        issue: 'must be on or before the signal session',
      })
    }
    for (let index = 0; index < binding.calendar.sessions.length; index += 1) {
      const session = binding.calendar.sessions[index]
      if (
        session.date < binding.calendar.requestedRange.start ||
        session.date > binding.calendar.requestedRange.end ||
        session.openAt.slice(0, 10) !== session.date ||
        session.closeAt.slice(0, 10) !== session.date ||
        session.openAt >= session.closeAt
      ) {
        issues.push({
          path: ['calendar', 'sessions', index],
          issue: 'must have valid hours on its declared UTC session date within the requested range',
        })
      }
      if (index > 0 && binding.calendar.sessions[index - 1].date >= session.date) {
        issues.push({
          path: ['calendar', 'sessions', index],
          issue: 'must be unique and strictly ordered',
        })
      }
    }
    const calendarMaterial = {
      schemaVersion: binding.calendar.schemaVersion,
      source: binding.calendar.source,
      requestedRange: binding.calendar.requestedRange,
      timeZone: binding.calendar.timeZone,
      sessions: binding.calendar.sessions,
    }
    if (binding.calendar.normalizedResponseHash !== canonicalHashV1(calendarMaterial)) {
      issues.push({
        path: ['calendar', 'normalizedResponseHash'],
        issue: 'must match the complete normalized calendar observation',
      })
    }
    const selectedSession = binding.calendar.sessions.find((session) => session.date > binding.signal.sessionDate)
    if (
      selectedSession === undefined ||
      canonicalHashV1(selectedSession) !== canonicalHashV1(binding.executionSession)
    ) {
      issues.push({
        path: ['executionSession'],
        issue: 'must be the first post-signal session in the normalized calendar observation',
      })
    }
    if (binding.executionSession.openAt >= binding.executionSession.closeAt) {
      issues.push({ path: ['executionSession', 'closeAt'], issue: 'must follow the execution open' })
    }
    if (
      binding.signal.finalizedAt > binding.submissionOpenAt ||
      binding.planningBrokerState.observedAt > binding.submissionOpenAt
    ) {
      issues.push({
        path: ['submissionOpenAt'],
        issue: 'must not precede finalized signal data or reconciled planning broker state',
      })
    }
    if (
      binding.submissionOpenAt >= binding.submissionCutoffAt ||
      binding.submissionCutoffAt >= binding.executionSession.openAt
    ) {
      issues.push({
        path: ['submissionCutoffAt'],
        issue: 'must produce submissionOpenAt < submissionCutoffAt < executionSession.openAt',
      })
    }
    const expectedSubmissionCutoffAt = new Date(
      Date.parse(binding.executionSession.openAt) - binding.submissionCutoffLeadMinutes * 60_000,
    ).toISOString()
    if (binding.submissionCutoffAt !== expectedSubmissionCutoffAt) {
      issues.push({
        path: ['submissionCutoffAt'],
        issue: 'must equal execution open minus the declared fixed cutoff lead',
      })
    }
    const { bindingHash, ...material } = binding
    if (bindingHash !== canonicalHashV1(material)) {
      issues.push({ path: ['bindingHash'], issue: 'must match the causal execution-session material' })
    }
    return issues
  }),
)
export type ExecutionSessionBinding = typeof ExecutionSessionBindingSchema.Type

export interface BindExecutionSessionInput {
  readonly signal: {
    readonly sessionDate: string
    readonly finalizedAt: string
    readonly contentHash: string
  }
  readonly planningBrokerState: {
    readonly observedAt: string
    readonly contentHash: string
  }
  readonly calendar: MarketCalendarObservation
  readonly executionModel: ExecutionModel
}

export interface BindCycleExecutionSessionInput extends BindExecutionSessionInput {
  readonly cycle: AutonomousCycle
}

const decodeBinding = Schema.decodeUnknownSync(ExecutionSessionBindingSchema, StrictParseOptions)

const observationMaterial = (observation: MarketCalendarObservation) => ({
  schemaVersion: observation.schemaVersion,
  source: observation.source,
  requestedRange: observation.requestedRange,
  timeZone: observation.timeZone,
  sessions: observation.sessions,
})

export const bindExecutionSession = (input: BindExecutionSessionInput): ExecutionSessionBinding => {
  if (input.executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    throw new Error('causal execution-session binding requires bayn.execution-model.v2')
  }
  if (canonicalHashV1(observationMaterial(input.calendar)) !== input.calendar.normalizedResponseHash) {
    throw new Error('Alpaca market calendar normalized response hash does not match its content')
  }
  for (let index = 1; index < input.calendar.sessions.length; index += 1) {
    if (input.calendar.sessions[index - 1].date >= input.calendar.sessions[index].date) {
      throw new Error('Alpaca market calendar sessions must be unique and strictly ordered')
    }
  }
  if (input.calendar.requestedRange.start > input.signal.sessionDate) {
    throw new Error('Alpaca market calendar request must start on or before the signal session')
  }
  const executionSession = input.calendar.sessions.find((session) => session.date > input.signal.sessionDate)
  if (executionSession === undefined) {
    throw new Error('Alpaca market calendar response does not contain a future execution session')
  }
  if (
    executionSession.date < input.calendar.requestedRange.start ||
    executionSession.date > input.calendar.requestedRange.end
  ) {
    throw new Error('execution session is outside the bound Alpaca market calendar request')
  }
  const submissionOpenAt =
    input.signal.finalizedAt >= input.planningBrokerState.observedAt
      ? input.signal.finalizedAt
      : input.planningBrokerState.observedAt
  const cutoffLeadMinutes = input.executionModel.order.submissionCutoffLeadMinutes
  const submissionCutoffAt = new Date(Date.parse(executionSession.openAt) - cutoffLeadMinutes * 60_000).toISOString()
  const material = {
    schemaVersion: 'bayn.execution-session-binding.v1',
    signal: input.signal,
    planningBrokerState: input.planningBrokerState,
    calendar: {
      schemaVersion: input.calendar.schemaVersion,
      source: input.calendar.source,
      requestedRange: input.calendar.requestedRange,
      timeZone: input.calendar.timeZone,
      sessions: input.calendar.sessions,
      normalizedResponseHash: input.calendar.normalizedResponseHash,
    },
    executionSession,
    submissionOpenAt,
    submissionCutoffAt,
    submissionCutoffLeadMinutes: cutoffLeadMinutes,
  } as const
  return decodeBinding({ ...material, bindingHash: canonicalHashV1(material) })
}

export const bindCycleExecutionSession = (input: BindCycleExecutionSessionInput): ExecutionSessionBinding => {
  const binding = bindExecutionSession(input)
  const cycle = input.cycle
  const selectedObservation = makeExecutionCalendarObservation({
    schemaVersion: binding.calendar.schemaVersion,
    source: binding.calendar.source,
    ...binding.executionSession,
  })
  if (
    binding.signal.sessionDate !== cycle.identity.signalSessionDate ||
    binding.executionSession.date !== cycle.identity.executionSessionDate ||
    binding.executionSession.date !== cycle.window.executionSessionDate ||
    binding.executionSession.openAt !== cycle.window.executionOpenAt ||
    binding.executionSession.closeAt !== cycle.window.executionCloseAt ||
    selectedObservation.executionCalendarSchemaVersion !== cycle.identity.executionCalendarSchemaVersion ||
    selectedObservation.executionCalendarSchemaVersion !== cycle.window.executionCalendarSchemaVersion ||
    selectedObservation.executionCalendarSource !== cycle.identity.executionCalendarSource ||
    selectedObservation.executionCalendarSource !== cycle.window.executionCalendarSource ||
    selectedObservation.executionCalendarHash !== cycle.identity.executionCalendarHash ||
    selectedObservation.executionCalendarHash !== cycle.window.executionCalendarHash
  ) {
    throw new TypeError('execution-session binding does not match the durable cycle calendar')
  }
  if (
    canonicalHashV1(input.executionModel) !== cycle.identity.executionPolicy.strategyExecutionModelHash ||
    binding.submissionCutoffLeadMinutes * 60_000 !== cycle.identity.executionPolicy.submissionCutoffBeforeOpenMs ||
    binding.submissionCutoffAt !== cycle.window.submissionCutoffAt
  ) {
    throw new TypeError('execution-session binding does not match the durable cycle execution policy')
  }
  if (binding.submissionOpenAt < cycle.window.submissionOpenAt) {
    throw new TypeError('execution-session binding cannot widen the durable cycle submission window')
  }
  return binding
}
