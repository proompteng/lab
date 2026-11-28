import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, FileSystem } from 'effect'

import { retainLatencyAcceptanceEvidence } from './latency-cli-evidence.test-support'

const acceptance = {
  policy: 'JEV',
  trading: false,
  sessionCount: 20,
  filledSessions: 0,
  executionProfitMicros: '0',
  qualificationProfitMicros: '-20000000',
  complete: true,
  providerDispatchCount: 0,
  receiptEconomicsComplete: false,
  executableHash: 'a'.repeat(64),
}

test('retained replay evidence labels synthetic scope without copying extra fields', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = `${yield* fs.makeTempDirectoryScoped()}/acceptance.json`
      const withExtraFields = { ...acceptance, credentials: 'must-not-leak' }
      yield* retainLatencyAcceptanceEvidence(path, withExtraFields)
      const bytes = yield* fs.readFileString(path)
      expect(bytes.length).toBeLessThanOrEqual(4096)
      expect(bytes).not.toContain('must-not-leak')
      expect(JSON.parse(bytes)).toEqual({
        schemaVersion: 'bayn.latency-cli-acceptance.v1',
        evidenceScope: 'SYNTHETIC_REPLAY_FIXTURE',
        profitabilityQualified: false,
        policy: 'JEV',
        tradingFixture: false,
        sessionCount: 20,
        filledSessions: 0,
        accountingComplete: true,
        providerDispatchCount: 0,
        receiptEconomicsComplete: false,
        syntheticExecutionProfitMicros: '0',
        syntheticQualificationProfitMicros: '-20000000',
        executableHash: 'a'.repeat(64),
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('positive synthetic returns do not become profitability qualification', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = `${yield* fs.makeTempDirectoryScoped()}/acceptance.json`
      yield* retainLatencyAcceptanceEvidence(path, {
        ...acceptance,
        trading: true,
        filledSessions: 20,
        executionProfitMicros: '50000000',
        qualificationProfitMicros: '30000000',
      })
      expect(JSON.parse(yield* fs.readFileString(path))).toMatchObject({
        tradingFixture: true,
        filledSessions: 20,
        profitabilityQualified: false,
        receiptEconomicsComplete: false,
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('retained evidence is exclusive and preserves an existing artifact', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = `${yield* fs.makeTempDirectoryScoped()}/acceptance.json`
      yield* retainLatencyAcceptanceEvidence(path, acceptance)
      const original = yield* fs.readFileString(path)
      const duplicate = yield* retainLatencyAcceptanceEvidence(path, { ...acceptance, filledSessions: 1 }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(yield* fs.readFileString(path)).toBe(original)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('oversized evidence fails before creating an artifact', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = `${yield* fs.makeTempDirectoryScoped()}/acceptance.json`
      const oversized = yield* retainLatencyAcceptanceEvidence(path, {
        ...acceptance,
        executionProfitMicros: '1'.repeat(4096),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(oversized)).toBe(true)
      expect(yield* fs.exists(path)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
