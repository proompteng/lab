import { PgClient } from '@effect/sql-pg'
import { Array as Arr, Effect, Exit, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { decodeJevEvaluationRequest, type JevEvaluationRequest } from '../jev/evidence'
import { EntryInferenceJournal, type EntryHandoff, type EntryStageTransition } from '../jev/entry-inference'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  decodeStagedCheckpoint,
  decodeStagedCheckpointForRequest,
  type StagedDispatchClaim,
  type StagedTerminalReceipt,
  type StagedCheckpoint,
} from '../jev/staged-checkpoint'
import { verifyStagedCheckpointHandoff } from '../jev/staged-inference-cost-evidence'
import * as chartStages from '../jev/staged-chart-questions'
import { withObservedStage } from '../telemetry'

const failed = (cause: unknown) =>
  operationalError({
    component: 'database',
    operation: 'entry-inference-handoff',
    message: 'Provider handoff could not be durably verified',
    cause,
  })

const Matches = Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })])
type LockedJournal = { readonly request: JevEvaluationRequest; readonly checkpoint: StagedCheckpoint }

export const recordEntryVisualClaim = (sql: PgClient.PgClient, input: StagedDispatchClaim, loaded: LockedJournal) =>
  Effect.gen(function* () {
    const { request, checkpoint } = loaded
    const existing = checkpoint.claims.find((row) => row.stage === input.stage)
    yield* Effect.fromResult(
      decodeStagedCheckpoint(request, {
        ...checkpoint,
        claims: [...checkpoint.claims.filter((row) => row.stage !== input.stage), input],
      }),
    )
    if (existing !== undefined) {
      yield* Schema.decodeUnknownEffect(Matches)(
        yield* sql`SELECT payload=${sql.json(input)} AS matches FROM jev_staged_dispatch_claims WHERE request_id=${input.requestId} AND stage=${input.stage}`,
      )
      return { dispatchAllowed: false }
    }
    const rows = yield* sql`INSERT INTO jev_staged_dispatch_claims (request_id, stage, claim_hash, payload)
        SELECT ${input.requestId}, ${input.stage}, ${input.claimHash}, ${sql.json(input)}
        FROM jev_evaluation_requests request JOIN autonomous_cycles cycle USING(cycle_id)
        WHERE request.request_id=${input.requestId}
          AND execution_account_commit_now(cycle.account_id) < ${input.expiresAt}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=${input.requestId})
          AND NOT EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=${input.requestId})
        RETURNING claim_hash`
    return { dispatchAllowed: rows.length === 1 }
  })

const transitionId = (input: EntryStageTransition) =>
  input.terminal === null ? input.successor.handoff.requestId : input.terminal.requestId

export const makeEntryInferenceJournal = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const commit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* failed('Provider journal transitions must commit independently before provider I/O')
      return yield* sql.withTransaction(effect)
    }).pipe(Effect.mapError(failed))

  const load = (requestIds: readonly string[]) =>
    Effect.gen(function* () {
      const ids = [...new Set(requestIds)]
      const journals = new Map<string, LockedJournal>()
      if (!Arr.isArrayNonEmpty(ids)) return journals
      const requests = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ request_id: Sha256Schema, payload: Schema.Unknown })),
        strictParseOptions,
      )(
        yield* sql`SELECT request_id, payload FROM jev_evaluation_requests WHERE request_id IN ${sql.in(ids)}
          ORDER BY request_id COLLATE "C" FOR UPDATE`,
      )
      if (requests.length !== ids.length) return yield* failed('A journal transition request is missing')
      // A separate statement starts its snapshot after the full request lock set has been acquired.
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            request_id: Sha256Schema,
            claims: Schema.Unknown,
            terminals: Schema.Unknown,
            skips: Schema.Unknown,
          }),
        ),
        strictParseOptions,
      )(
        yield* sql`SELECT request_id,
          COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C")
            FROM jev_staged_dispatch_claims WHERE request_id=request.request_id), '[]'::jsonb) AS claims,
          COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C")
            FROM jev_staged_terminal_receipts WHERE request_id=request.request_id), '[]'::jsonb) AS terminals,
          COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C")
            FROM jev_staged_skip_receipts WHERE request_id=request.request_id), '[]'::jsonb) AS skips
          FROM jev_evaluation_requests request WHERE request_id IN ${sql.in(ids)}`,
      )
      const checkpoints = new Map(rows.map(({ request_id, ...checkpoint }) => [request_id, checkpoint]))
      for (const row of requests) {
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.payload))
        if (request.requestId !== row.request_id) return yield* failed('A journal request differs from its row key')
        const checkpoint = yield* Effect.fromResult(
          decodeStagedCheckpointForRequest(request, checkpoints.get(row.request_id), chartStages),
        )
        journals.set(request.requestId, { request, checkpoint })
      }
      return journals
    })

  const saveTerminals = (terminals: readonly StagedTerminalReceipt[]) =>
    Effect.gen(function* () {
      if (terminals.length === 0) return
      const expected = sql`jsonb_to_recordset(${sql.json(
        terminals.map((terminal) => ({
          request_id: terminal.requestId,
          stage: terminal.stage,
          claim_hash: terminal.claimHash,
          terminal_hash: terminal.terminalHash,
          payload: terminal,
        })),
      )}::jsonb) AS expected(request_id text, stage text, claim_hash text, terminal_hash text, payload jsonb)`
      yield* sql`INSERT INTO jev_staged_terminal_receipts (request_id, stage, claim_hash, terminal_hash, payload)
        SELECT request_id, stage, claim_hash, terminal_hash, payload FROM ${expected}
        ORDER BY request_id COLLATE "C", stage COLLATE "C" ON CONFLICT (request_id, stage) DO NOTHING`
      yield* Schema.decodeUnknownEffect(
        Matches,
        strictParseOptions,
      )(
        yield* sql`SELECT NOT EXISTS (
          SELECT 1 FROM ${expected} LEFT JOIN jev_staged_terminal_receipts stored USING (request_id, stage)
          WHERE stored.payload IS DISTINCT FROM expected.payload
        ) AS matches`,
      )
    })

  const saveHandoffs = (handoffs: readonly EntryHandoff[]) =>
    Effect.gen(function* () {
      const allowed = new Set<string>()
      if (handoffs.length === 0) return allowed
      const expected = sql`jsonb_to_recordset(${sql.json(
        handoffs.map((handoff) => ({
          request_id: handoff.requestId,
          handoff_hash: handoff.handoffHash,
          payload: handoff,
        })),
      )}::jsonb) AS expected(request_id text, handoff_hash text, payload jsonb)`
      const inserted = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ request_id: Sha256Schema })),
        strictParseOptions,
      )(
        yield* sql`INSERT INTO jev_inference_handoffs (request_id, handoff_hash, payload)
          SELECT request_id, handoff_hash, payload FROM ${expected}
          ORDER BY request_id COLLATE "C" ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
      )
      const states = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ request_id: Sha256Schema, matches: Schema.Literal(true), resolved: Schema.Boolean }),
        ),
        strictParseOptions,
      )(
        yield* sql`SELECT expected.request_id,
          stored.handoff_hash = expected.handoff_hash AND stored.payload = expected.payload AS matches,
          resolution.request_id IS NOT NULL AS resolved
          FROM ${expected} LEFT JOIN jev_inference_handoffs stored USING (request_id)
          LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)`,
      )
      if (states.length !== handoffs.length) return yield* failed('Stored handoff set differs from the transition')
      const newIds = new Set(inserted.map((row) => row.request_id))
      for (const state of states) if (!state.resolved && newIds.has(state.request_id)) allowed.add(state.request_id)
      return allowed
    })

  const transition = (inputs: readonly EntryStageTransition[]) =>
    Effect.gen(function* () {
      const byId = new Map(inputs.map((input) => [transitionId(input), input]))
      if (byId.size !== inputs.length) return yield* failed('A transition group repeats a request')
      const journals = yield* load([...byId.keys()])
      const terminals: StagedTerminalReceipt[] = []
      const handoffs: EntryHandoff[] = []
      for (const [requestId, { request, checkpoint: original }] of journals) {
        const input = byId.get(requestId)
        if (input === undefined) return yield* failed('Locked journal differs from the transition group')
        const { terminal, successor } = input
        let checkpoint = original
        if (terminal !== null) {
          checkpoint = yield* Effect.fromResult(
            decodeStagedCheckpointForRequest(
              request,
              {
                ...original,
                terminals: [...original.terminals.filter((row) => row.stage !== terminal.stage), terminal],
              },
              chartStages,
            ),
          )
          terminals.push(terminal)
        }
        if (successor.kind === 'HANDOFF') {
          const handoff = yield* Effect.fromResult(
            decodeEntryHandoff(
              { requestId, input: request.request, observedAt: request.observedAt, expiresAt: request.expiresAt },
              successor.handoff,
            ),
          )
          yield* Effect.fromResult(verifyStagedCheckpointHandoff(checkpoint, handoff))
          handoffs.push(handoff)
        }
      }
      yield* saveTerminals(terminals)
      const allowed = yield* saveHandoffs(handoffs)
      return [...journals.keys()].map((requestId) => ({ requestId, dispatchAllowed: allowed.has(requestId) }))
    })

  return {
    recordVisualClaims: (inputs: readonly StagedDispatchClaim[]) =>
      commit(
        Effect.forEach(
          inputs.toSorted((left, right) => left.requestId.localeCompare(right.requestId)),
          (input) =>
            Effect.gen(function* () {
              const loaded = (yield* load([input.requestId])).get(input.requestId)
              if (loaded === undefined) return yield* failed('A visual claim request is missing')
              const result = yield* recordEntryVisualClaim(sql, input, loaded)
              return { requestId: input.requestId, ...result }
            }),
        ),
      ),
    recordTransitions: (inputs: readonly EntryStageTransition[]) =>
      commit(transition(inputs)).pipe(
        Effect.onExit((exit) => {
          if (!Exit.isFailure(exit) || !inputs.some((input) => input.successor.kind === 'HANDOFF')) return Effect.void
          const terminals = inputs.flatMap(({ terminal }) =>
            terminal === null ? [] : [{ terminal, successor: { kind: 'NONE' as const } }],
          )
          return terminals.length === 0 ? Effect.void : commit(transition(terminals)).pipe(Effect.asVoid)
        }),
        withObservedStage('bayn.jev.handoff-journal', {
          dependency: 'postgresql',
          attributes: { 'bayn.jev.transition_count': inputs.length },
        }),
      ),
  } satisfies typeof EntryInferenceJournal.Service
})

export const EntryInferenceJournalLive = Layer.effect(EntryInferenceJournal, makeEntryInferenceJournal)
