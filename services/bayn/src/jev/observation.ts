import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { ExecutionMarketDataBindingSchema, reconstructBoundIntradaySnapshot } from '../shadow-decision-contract'
import { IntradayMomentumProtocolSchema } from '../strategy/intraday-momentum/protocol'
import { JevContractError } from './contract'

const ObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-candidate-observation.v2'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  protocol: IntradayMomentumProtocolSchema,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  rows: Schema.Struct({
    bars: Schema.Array(Schema.Unknown),
    quotes: Schema.Array(Schema.Unknown),
    trades: Schema.Array(Schema.Unknown),
  }),
  decision: Schema.Unknown,
})

export const reproduceJevCandidateObservation = (input: unknown) =>
  Result.gen(function* () {
    const observation = yield* Schema.decodeUnknownResult(ObservationSchema, strictParseOptions)(input)
    const snapshotSchemaVersion = observation.manifest['schemaVersion']
    if (
      snapshotSchemaVersion !== 'bayn.streaming-market-snapshot.v1' &&
      snapshotSchemaVersion !== 'bayn.simulated-market-snapshot.v1'
    )
      return yield* Result.fail(new JevContractError({ message: 'Jev observation has no supported source snapshot' }))
    const binding = yield* Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      ...observation.manifest,
      snapshotSchemaVersion,
      schemaVersion:
        snapshotSchemaVersion === 'bayn.streaming-market-snapshot.v1'
          ? 'bayn.execution-market-data-binding.v3'
          : 'bayn.execution-market-data-binding.v4',
    })
    if (binding.schemaVersion === 'bayn.reconciled-position-liquidation-binding.v1')
      return yield* Result.fail(new JevContractError({ message: 'Jev entry requires complete market evidence' }))
    const snapshot = reconstructBoundIntradaySnapshot(binding, observation.rows)
    if (
      snapshot === undefined ||
      snapshot.manifest.observedAt !== observation.observedAt ||
      snapshot.manifest.candidateSymbols?.join('|') !== observation.protocol.candidateSymbols.join('|') ||
      !snapshot.manifest.symbols.includes(observation.protocol.benchmarkSymbol)
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Jev observation source or candidate universe does not reproduce' }),
      )
    return { ...observation, snapshot, contentHash: yield* canonicalHashV1Result(observation) }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Jev candidate observation cannot be reproduced', cause }),
    ),
  )
