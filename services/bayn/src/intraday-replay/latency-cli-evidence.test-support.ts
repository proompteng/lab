import { Effect, FileSystem, Schema } from 'effect'

export const LatencyCliAcceptance = Schema.Struct({
  policy: Schema.String,
  trading: Schema.Boolean,
  sessionCount: Schema.Number,
  filledSessions: Schema.Number,
  executionProfitMicros: Schema.String,
  qualificationProfitMicros: Schema.String,
  complete: Schema.Boolean,
  providerDispatchCount: Schema.Number,
  receiptEconomicsComplete: Schema.Boolean,
  executableHash: Schema.String,
})

// Keep only synthetic fixture measurements, never the replay's account or source payloads.
export const retainLatencyAcceptanceEvidence = (path: string, result: typeof LatencyCliAcceptance.Type) =>
  Effect.gen(function* () {
    const evidence = `${JSON.stringify({
      schemaVersion: 'bayn.latency-cli-acceptance.v1',
      evidenceScope: 'SYNTHETIC_REPLAY_FIXTURE',
      profitabilityQualified: false,
      policy: result.policy,
      tradingFixture: result.trading,
      sessionCount: result.sessionCount,
      filledSessions: result.filledSessions,
      accountingComplete: result.complete,
      providerDispatchCount: result.providerDispatchCount,
      receiptEconomicsComplete: result.receiptEconomicsComplete,
      syntheticExecutionProfitMicros: result.executionProfitMicros,
      syntheticQualificationProfitMicros: result.qualificationProfitMicros,
      executableHash: result.executableHash,
    })}\n`
    if (Buffer.byteLength(evidence, 'utf8') > 4096) {
      return yield* Effect.fail(new Error('Latency acceptance evidence exceeds 4096 bytes'))
    }
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, evidence, { flag: 'wx', mode: 0o600 })
  })
