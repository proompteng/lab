import { Result, Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export enum ObligationClass {
  Decision = 'DECISION',
  Reconciliation = 'RECONCILIATION',
  Mutation = 'MUTATION',
  Recovery = 'RECOVERY',
}

export enum ObligationOutcome {
  Correct = 'CORRECT',
  Failed = 'FAILED',
}

export enum ReliabilityStatus {
  MeetsTarget = 'MEETS_TARGET',
  MissesTarget = 'MISSES_TARGET',
  Undetermined = 'UNDETERMINED',
  NotApplicable = 'NOT_APPLICABLE',
}

export const ScheduledObligationSchema = Schema.Struct({
  obligationId: Sha256Schema,
  class: Schema.Enum(ObligationClass),
  dueAt: UtcInstantSchema,
  deadlineAt: UtcInstantSchema,
  scheduleEvidenceHash: Sha256Schema,
})

export const ObligationCompletionSchema = Schema.Struct({
  obligationId: Sha256Schema,
  outcome: Schema.Enum(ObligationOutcome),
  completedAt: UtcInstantSchema,
  evidenceHash: Sha256Schema,
})

export const ReliabilityInputSchema = Schema.Struct({
  asOf: UtcInstantSchema,
  schedule: Schema.Array(ScheduledObligationSchema),
  completions: Schema.Array(ObligationCompletionSchema),
})

export const reliabilityTargetNumerator = 999n
export const reliabilityTargetDenominator = 1000n

export const reliabilityFraction = (good: bigint, scheduled: bigint): ReliabilityStatus =>
  scheduled <= 0n || good < 0n || good > scheduled
    ? ReliabilityStatus.Undetermined
    : good * reliabilityTargetDenominator >= scheduled * reliabilityTargetNumerator
      ? ReliabilityStatus.MeetsTarget
      : ReliabilityStatus.MissesTarget

/** The schedule includes work that never started; retries cannot alter its deadline or denominator. */
export const measureReliability = (input: unknown, retainedPolicy = false) =>
  Schema.decodeUnknownResult(
    ReliabilityInputSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new SystemAssessmentError({ message: 'Reliability evidence is malformed', cause })),
    Result.flatMap((data) =>
      Result.gen(function* () {
        const schedule = new Map(data.schedule.map((obligation) => [obligation.obligationId, obligation]))
        const completions = new Map(data.completions.map((completion) => [completion.obligationId, completion]))
        if (schedule.size !== data.schedule.length || completions.size !== data.completions.length)
          return yield* Result.fail(new SystemAssessmentError({ message: 'Duplicate reliability evidence' }))
        for (const obligation of data.schedule)
          if (obligation.deadlineAt < obligation.dueAt)
            return yield* Result.fail(
              new SystemAssessmentError({ message: 'Obligation deadline precedes its due time' }),
            )
        for (const completion of data.completions) {
          const obligation = schedule.get(completion.obligationId)
          if (
            obligation === undefined ||
            completion.completedAt < obligation.dueAt ||
            completion.completedAt > data.asOf
          )
            return yield* Result.fail(
              new SystemAssessmentError({ message: 'Completion is outside its registered obligation' }),
            )
        }
        const classes = Object.values(ObligationClass).map((kind) => {
          const obligations = data.schedule.filter((obligation) => obligation.class === kind)
          let good = 0n
          let pending = 0n
          const missed: string[] = []
          for (const obligation of obligations) {
            const completion = completions.get(obligation.obligationId)
            if (completion?.outcome === ObligationOutcome.Correct && completion.completedAt <= obligation.deadlineAt)
              good += 1n
            else if (data.asOf < obligation.deadlineAt && completion === undefined) pending += 1n
            else missed.push(obligation.obligationId)
          }
          const scheduled = BigInt(obligations.length)
          const status =
            !retainedPolicy && kind === ObligationClass.Recovery && scheduled === 0n
              ? ReliabilityStatus.NotApplicable
              : pending > 0n
                ? ReliabilityStatus.Undetermined
                : reliabilityFraction(good, scheduled)
          return {
            class: kind,
            status,
            scheduled: scheduled.toString(),
            correctOnTime: good.toString(),
            pending: pending.toString(),
            missed,
            allowedFailures: (scheduled / reliabilityTargetDenominator).toString(),
          }
        })
        return {
          target: {
            numerator: reliabilityTargetNumerator.toString(),
            denominator: reliabilityTargetDenominator.toString(),
          },
          status: classes.some((item) => item.status === ReliabilityStatus.MissesTarget)
            ? ReliabilityStatus.MissesTarget
            : classes.every(
                  (item) =>
                    item.status === ReliabilityStatus.MeetsTarget || item.status === ReliabilityStatus.NotApplicable,
                )
              ? ReliabilityStatus.MeetsTarget
              : ReliabilityStatus.Undetermined,
          classes,
        }
      }),
    ),
  )
