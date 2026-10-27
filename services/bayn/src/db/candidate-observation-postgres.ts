import { JevBatchPlanVersion } from '../jev/batch'
import { entryAblationStrategyIdentity, makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Result, Schema } from 'effect'

import { operationalError } from '../errors'
import { CandidateObservationStore, type CandidateObservation } from '../observe-composition/candidate-observation'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { verifyJevPortfolioSources } from './jev-position-postgres'
import { jevBehaviorHash } from '../jev/protocol'
import {
  decodeRepeatedMomentumPolicy,
  repeatedMomentumStrategyIdentity,
  type RepeatedMomentumPolicy,
} from '../strategy/repeated-momentum/policy'

type ReproducedJevObservation = Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>

const recordCandidateObservation = (
  sql: PgClient.PgClient,
  { contentHash, payload }: CandidateObservation,
  reproduced: ReproducedJevObservation | undefined,
  policy: JevBatchPlanVersion | RepeatedMomentumPolicy,
) =>
  Effect.gen(function* () {
    if (reproduced !== undefined) {
      const control =
        policy === JevBatchPlanVersion.Ablation
          ? yield* Effect.fromResult(entryAblationStrategyIdentity(makeEntryAblationPolicy(reproduced.protocol)))
          : typeof policy !== 'string'
            ? yield* Effect.fromResult(repeatedMomentumStrategyIdentity(policy))
            : null
      const parameterHash =
        control?.strategy.parameterHash ?? (yield* Effect.fromResult(canonicalHashV1Result(reproduced.protocol)))
      const protocolHash =
        control?.protocolHash ??
        (yield* Effect.fromResult(
          makeStrategyProtocolHashResult({
            name: 'jev',
            behaviorHash: jevBehaviorHash,
            parameterHash,
            parameterSchemaVersion: reproduced.protocol.schemaVersion,
          }),
        ))
      const state = reproduced.portfolio.brokerState
      const reconciliation = state.reconciliation
      yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
        strictParseOptions,
      )(
        yield* sql`
        SELECT EXISTS (
          SELECT 1 FROM autonomous_cycles AS cycle
          JOIN authority_generations AS generation ON generation.generation_hash = ${reproduced.authorityGenerationHash}
          JOIN reconciliations AS evidence ON evidence.reconciliation_id = ${reconciliation.reconciliationId}
          WHERE cycle.cycle_id = ${reproduced.cycleId} AND cycle.strategy_name = 'jev'
            AND cycle.account_id = ${state.account.accountId} AND cycle.strategy_protocol_hash = ${protocolHash}
            AND (generation.account_id IS NULL OR generation.account_id = cycle.account_id)
            AND (generation.strategy_parameter_hash IS NULL OR generation.strategy_parameter_hash = ${parameterHash})
            AND evidence.account_id = cycle.account_id AND evidence.expected_hash = ${reconciliation.expectedHash}
            AND evidence.observed_hash = ${reconciliation.observedHash} AND evidence.content_hash = ${reconciliation.contentHash}
            AND evidence.status = 'EXACT' AND evidence.reconciled_at = ${reconciliation.reconciledAt}::timestamptz
            AND evidence.discrepancies = '[]'::jsonb
        ) AS matches
      `,
      )
      yield* verifyJevPortfolioSources(sql, reproduced.cycleId, reproduced.portfolio)
    }
    const inserted = yield* sql`
      INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
      VALUES (${contentHash}, ${payload.cycleId}, ${payload.observedAt}::timestamptz, ${sql.json(payload)})
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING content_hash
    `
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ content_hash: Sha256Schema })),
      strictParseOptions,
    )(inserted)
    if (rows.length === 1 && rows[0]?.content_hash === contentHash) return
    const existing = yield* sql`
      SELECT payload = ${sql.json(payload)} AS matches
      FROM intraday_candidate_observations WHERE content_hash = ${contentHash}
    `
    yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
      strictParseOptions,
    )(existing)
  }).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'database',
        operation: 'candidate-observation',
        message: 'candidate observation was not durably recorded',
        cause,
      }),
    ),
  )

export const recordReproducedJevObservation = (
  sql: PgClient.PgClient,
  source: ReproducedJevObservation,
  policy: JevBatchPlanVersion | RepeatedMomentumPolicy,
) => {
  const { snapshot, contentHash, ...payload } = source
  return recordCandidateObservation(
    sql,
    { contentHash, payload: { ...payload, manifest: snapshot.manifest } },
    source,
    policy,
  )
}

export const makeCandidateObservationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    latestJevWindowEnd: ({ cycleId, purpose }) =>
      sql`
        SELECT max(payload #>> '{manifest,rangeEndAt}') AS at FROM intraday_candidate_observations
        WHERE cycle_id = ${cycleId} AND payload ->> 'schemaVersion' = 'bayn.jev-observation.v1'
          AND payload #>> '{portfolio,purpose}' = ${purpose}
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ at: Schema.NullOr(UtcInstantSchema) })]),
            strictParseOptions,
          ),
        ),
        Effect.map(([row]) => Option.fromNullishOr(row.at)),
        Effect.mapError((cause) =>
          operationalError({
            component: 'database',
            operation: 'candidate-observation',
            message: 'Could not read the prior Jev observation window',
            cause,
          }),
        ),
      ),
    record: (observation: CandidateObservation, momentumPolicy?: RepeatedMomentumPolicy) =>
      Effect.gen(function* () {
        if (
          observation.payload.schemaVersion === 'bayn.jev-observation.v1' &&
          Option.isSome(yield* Effect.serviceOption(sql.transactionService))
        )
          return yield* operationalError({
            component: 'database',
            operation: 'candidate-observation',
            message: 'Jev observations must commit before inference',
          })
        if (observation.payload.schemaVersion !== 'bayn.jev-observation.v1')
          return yield* recordCandidateObservation(sql, observation, undefined, JevBatchPlanVersion.V7)
        const reproduced = yield* Effect.fromResult(reproduceJevCandidateObservation(observation.payload)).pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'database',
              operation: 'candidate-observation',
              message: 'Jev observation could not be reproduced before persistence',
              cause,
            }),
          ),
        )
        if (reproduced.contentHash !== observation.contentHash)
          return yield* operationalError({
            component: 'database',
            operation: 'candidate-observation',
            message: 'Jev observation does not reproduce its content hash',
          })
        if (momentumPolicy !== undefined) {
          const verified = yield* Effect.fromResult(decodeRepeatedMomentumPolicy(momentumPolicy))
          const supplied = yield* Effect.fromResult(canonicalHashV1Result(verified.sharedProtocol))
          const original = yield* Effect.fromResult(canonicalHashV1Result(reproduced.protocol))
          if (supplied !== original)
            return yield* operationalError({
              component: 'database',
              operation: 'candidate-observation',
              message: 'Momentum policy differs from its source protocol',
            })
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT cycle_id FROM autonomous_cycles WHERE cycle_id = ${reproduced.cycleId} FOR UPDATE`
              const prior = yield* sql`SELECT content_hash FROM intraday_candidate_observations
              WHERE cycle_id = ${reproduced.cycleId} AND payload->>'schemaVersion' = 'bayn.jev-observation.v1'
                AND payload #>> '{portfolio,purpose}' = ${reproduced.portfolio.purpose}
                AND payload #>> '{manifest,rangeEndAt}' >= ${reproduced.snapshot.manifest.rangeEndAt}
                AND content_hash <> ${reproduced.contentHash}`
              if (prior.length !== 0)
                return yield* operationalError({
                  component: 'database',
                  operation: 'candidate-observation',
                  message: 'Momentum observation window already has a committed source',
                })
              yield* recordReproducedJevObservation(sql, reproduced, verified)
            }),
          )
        }
        return yield* recordReproducedJevObservation(sql, reproduced, JevBatchPlanVersion.V7)
      }).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'database',
            operation: 'candidate-observation',
            message: 'Observation policy could not be durably bound',
            cause,
          }),
        ),
      ),
  } satisfies CandidateObservationStore['Service']
})

export const CandidateObservationStoreLive = Layer.effect(CandidateObservationStore, makeCandidateObservationStore)
