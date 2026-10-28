import { executionDecisionRows } from '../db/execution-decision-query'
import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { readForwardPerformanceInput } from '../forward-performance/program'
import type { ForwardPerformanceConfig } from '../forward-performance/config'
import { generationScope } from '../forward-performance/postgres/scope'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { verifyInferenceExpenseCoverage } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { JevResearchPolicy } from '../jev/acceptance'
import { instrumentMarket } from '../instruments'
import { isSnapshotExecutionMarketDataBinding } from '../shadow-decision-contract'
import { Sha256Schema, SignedMicrosSchema, StrictNonEmptyStringSchema, UtcInstantSchema } from '../schemas'
import { readSystemRegistration } from './postgres'
import { SystemAssessmentError } from './economics'
import { captureForwardFinancialEvidence } from './forward-evidence'
import { SystemSourceCutSchema, persistSystemSourceCut } from './source-cut'
import { loadActiveStrategyProtocol } from '../strategy'
import { qualificationRuntime } from './configuration'
import { BrokerEnvironment, BrokerIdentitySchema } from '../broker/identity'
import type { SystemRegistration } from './policy'
import { measureControllerLatency } from './controller-latency'
import { measureFullBatchLatency } from './full-batch-latency'
import { sourceFitsRegisteredSession } from './decision-work'
import { prepareValuationInventory, requiredValuationTimes } from './valuation'
import { executableBid, readValuationQuotes } from './valuation-quotes'
import { captureExecutionOrders, captureExecutionFills } from './execution-evidence'
import { readSystemExecutionOrders, readSystemExecutionFills, readSystemProtectionIntents } from './execution-capture'
import { executionOrderPlans } from './execution-plans'

export const readSystemCashObservations = (
  accountId: string,
  scope: {
    readonly accountBindingHash: string
    readonly openAt: string
    readonly closeAt: string
    readonly asOf: string
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          accountBindingHash: Sha256Schema,
          sourceHash: Sha256Schema,
          at: UtcInstantSchema,
          availableAt: UtcInstantSchema,
          cashMicros: SignedMicrosSchema,
        }),
      ),
    )(
      yield* sql`
    SELECT ${scope.accountBindingHash}::text AS "accountBindingHash", event.content_hash AS "sourceHash",
      to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "availableAt",
      snapshot.cash_micros::text AS "cashMicros"
    FROM account_snapshots AS snapshot JOIN broker_events AS event USING (event_id)
    WHERE snapshot.account_id = ${accountId}
      AND event.occurred_at BETWEEN ${scope.openAt}::timestamptz AND ${scope.closeAt}::timestamptz
      AND event.observed_at <= ${scope.asOf}::timestamptz
    ORDER BY event.occurred_at, event.source_sequence`,
    )
  })

export const readRegisteredFinancialIdentity = (definition: SystemRegistration['policies'][number]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          identity: BrokerIdentitySchema,
          riskPolicyHash: Sha256Schema,
          sourceRevision: StrictNonEmptyStringSchema,
          imageDigest: StrictNonEmptyStringSchema,
          strategyHash: Sha256Schema,
          parametersHash: Sha256Schema,
          protocolHash: Sha256Schema,
        }),
      ),
    )(
      yield* sql`SELECT risk_policy_hash AS "riskPolicyHash",
        activation_source_revision AS "sourceRevision", activation_image_digest AS "imageDigest",
        strategy_behavior_hash AS "strategyHash", strategy_parameter_hash AS "parametersHash",
        strategy_protocol_hash AS "protocolHash", jsonb_build_object(
        'schemaVersion', broker_identity_schema_version, 'provider', broker_provider,
        'environment', broker_environment, 'accountId', account_id, 'identityHash', broker_identity_hash
      ) AS identity FROM authority_generations WHERE generation_hash = ${definition.authorityGenerationHash}`,
    )
    const row = rows[0]
    if (row === undefined) return null
    const accountBindingHash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.inference-cost-account.v1',
        accountId: row.identity.accountId,
      }),
    )
    if (
      row.identity.environment !== BrokerEnvironment.Sandbox ||
      row.riskPolicyHash !== definition.riskPolicyHash ||
      row.sourceRevision !== definition.sourceRevision ||
      row.imageDigest.replace(/^sha256:/, '') !== definition.imageDigest ||
      row.strategyHash !== definition.strategyHash ||
      row.parametersHash !== definition.parametersHash ||
      row.protocolHash !== definition.protocolHash ||
      accountBindingHash !== definition.accountBindingHash
    )
      return yield* new SystemAssessmentError({
        message:
          'Financial capture account, environment, risk policy or generation provenance differs from registration',
      })
    return row.identity
  })

export const readSystemBatchEvidence = (accountId: string, generationHash: string, openAt: string, closeAt: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.batches)(
      yield* sql`
      SELECT plan.payload AS plan, observation.payload AS observation, result.payload AS result
      FROM jev_batch_plans AS plan JOIN autonomous_cycles AS cycle USING (cycle_id)
      LEFT JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
      LEFT JOIN jev_batch_results AS result USING (batch_id)
      WHERE cycle.account_id = ${accountId} AND plan.authority_generation_hash = ${generationHash}
        AND plan.payload->>'observedAt' >= ${openAt}
        AND plan.payload->>'observedAt' < ${closeAt}
      ORDER BY plan.payload->>'observedAt', plan.batch_id`,
    )
  })

export const readSystemMutationEvidence = (accountId: string, generationHash: string, from: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.mutations)(
      yield* sql`
        SELECT intent.authority_generation_hash AS "authorityGenerationHash", intent.decision_hash AS "strategyDecisionHash", jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion', event.schema_version, 'eventId', event.event_id, 'mutationId', event.mutation_id,
          'intentId', event.intent_id, 'sequence', event.sequence::integer, 'operation', event.operation,
          'eventType', event.event_type, 'requestHash', event.request_hash, 'consistencyDelayMs', event.consistency_delay_ms,
          'brokerOrderId', event.broker_order_id, 'requestId', event.request_id, 'responseStatus', event.response_status,
          'responseContentHash', event.response_content_hash, 'denialReason', event.denial_reason,
          'occurredAt', to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          || CASE WHEN event.routing IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('routing', event.routing) END AS event
        FROM mutation_events AS event JOIN intents AS intent USING (intent_id)
        WHERE intent.account_id = ${accountId} AND intent.authority_generation_hash = ${generationHash}
          AND event.occurred_at >= ${from}::timestamptz
        ORDER BY event.mutation_id, event.sequence`,
    )
  })

export const readSystemControllerPasses = (
  controllerKey: string,
  planHash: string | null,
  openAt: string,
  closeAt: string,
  asOf: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.controllerPasses)(
      yield* sql`
        SELECT DISTINCT status->>'controller_key' AS "controllerKey",
          status->>'plan_hash' AS "planHash", (status->>'epoch')::double precision AS epoch,
          (status->>'last_sequence')::double precision AS sequence, status->>'last_receipt_hash' AS "receiptHash",
          to_char((status->>'completed_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
          status->'last_pass' AS observation
        FROM execution_controller_observations
        WHERE controller_key = ${controllerKey} AND status->>'plan_hash' = ${planHash}
          AND status->>'last_receipt_hash' IS NOT NULL AND jsonb_typeof(status->'last_pass') = 'object'
          AND (status->>'completed_at')::timestamptz <= ${asOf}::timestamptz
          AND ((status->>'completed_at')::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz
            OR (status #>> '{last_pass,executionIssuedAt}')::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz)
        ORDER BY "receiptHash", epoch, sequence, "completedAt"`,
    )
  })

export const readSystemDurableObservations = (registrationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.durableObservations)(
      yield* sql`
    SELECT kind, source_hash AS "sourceHash", correct,
      to_char(source_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceAt",
      to_char((date_trunc('milliseconds', witnessed_at) +
        CASE WHEN witnessed_at > date_trunc('milliseconds', witnessed_at) THEN interval '1 millisecond'
          ELSE interval '0' END) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "witnessedAt"
    FROM system_durable_observations WHERE registration_hash = ${registrationHash}
    ORDER BY witnessed_at, kind, source_hash`,
    )
  })

export const readSystemDecisionAdmissions = ({
  accountId,
  generationHash,
  openAt,
  firstSession,
  lastSession,
  asOf,
}: {
  readonly accountId: string
  readonly generationHash: string
  readonly openAt: string
  readonly firstSession: string
  readonly lastSession: string
  readonly asOf: string
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          eventId: Sha256Schema,
          decisionId: Sha256Schema,
          observedAt: UtcInstantSchema,
        }),
      ),
    )(
      yield* sql`
      SELECT receipt.event_id AS "eventId", receipt.decision_id AS "decisionId",
        to_char((date_trunc('milliseconds', receipt.observed_at) +
          CASE WHEN receipt.observed_at > date_trunc('milliseconds', receipt.observed_at)
            THEN interval '1 millisecond' ELSE interval '0' END) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
      FROM execution_decision_admissions receipt JOIN mutation_events event USING(event_id)
        JOIN intents intent USING(intent_id)
        JOIN autonomous_cycles cycle ON cycle.cycle_id = intent.cycle_id
      WHERE intent.account_id = ${accountId} AND intent.authority_generation_hash = ${generationHash}
        AND cycle.execution_session_date BETWEEN ${firstSession}::date AND ${lastSession}::date
        AND event.occurred_at >= ${openAt}::timestamptz
        AND receipt.observed_at <= ${asOf}::timestamptz
      ORDER BY receipt.event_id, receipt.decision_id`,
    )
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return { ...row, sourceHash: yield* Effect.fromResult(canonicalHashV1Result(row)) }
      }),
    )
  })

/** Capture one database snapshot. External ledger verification can reject a moving or incomplete cut. */
export const captureSystemSourceCut = (config: ForwardPerformanceConfig, registrationHash: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registration = yield* readSystemRegistration(registrationHash)
      const runtimeConfiguration = qualificationRuntime(config, yield* Effect.fromResult(loadActiveStrategyProtocol()))
      const runtimeConfigurationHash = yield* Effect.fromResult(canonicalHashV1Result(runtimeConfiguration))
      if (runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash)
        return yield* new SystemAssessmentError({
          message: 'Capture runtime differs from the prospectively registered configuration',
        })
      const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
      const identity = config.execution.brokerIdentity
      const first = registration.calendar.sessions[0]
      const last = registration.calendar.sessions.at(-1)
      if (
        candidate === undefined ||
        identity === undefined ||
        identity.environment !== BrokerEnvironment.Sandbox ||
        first === undefined ||
        last === undefined
      )
        return yield* new SystemAssessmentError({
          message: 'Source capture requires a registered candidate and broker identity',
        })
      const sql = yield* PgClient.PgClient
      const cut = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          const times = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ asOf: UtcInstantSchema })))(
            yield* sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"`,
          )
          const asOf = times[0]?.asOf
          if (asOf === undefined)
            return yield* new SystemAssessmentError({ message: 'Database snapshot time is unavailable' })
          const client = yield* makeTigerBeetleRequestClient(config)
          const accounts = []
          for (const definition of registration.policies) {
            const accountIdentity = yield* readRegisteredFinancialIdentity(definition)
            if (accountIdentity === null) continue
            if (
              definition.policy === JevResearchPolicy.Candidate &&
              accountIdentity.identityHash !== identity.identityHash
            )
              return yield* new SystemAssessmentError({
                message: 'Candidate capture differs from the configured account',
              })
            const accountConfig = { ...config, execution: { ...config.execution, brokerIdentity: accountIdentity } }
            const forward = yield* readForwardPerformanceInput(accountConfig, undefined, {
              authorityGenerationHash: definition.authorityGenerationHash,
            })
            const decisions = yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.decisions)(
              yield* sql`
                SELECT cycle.execution_session_date::text AS "sessionDate", decision.document
                FROM autonomous_cycles AS cycle JOIN (${executionDecisionRows(sql)}) AS decision USING (cycle_id)
                WHERE cycle.account_id = ${accountIdentity.accountId}
                  AND ${generationScope(sql, accountIdentity.accountId, definition.authorityGenerationHash, 'cycle')}
                  AND cycle.execution_session_date BETWEEN ${first.sessionDate}::date AND ${last.sessionDate}::date
                ORDER BY cycle.execution_session_date, decision.decision_hash`,
            )
            const scope = {
              accountId: accountIdentity.accountId,
              generationHash: definition.authorityGenerationHash,
              firstSession: first.sessionDate,
              lastSession: last.sessionDate,
              asOf,
            }
            const protectionIntents = yield* readSystemProtectionIntents(
              scope,
              definition.riskPolicy.maxBrokerStateAgeMs,
            )
            const plans = yield* Effect.fromResult(executionOrderPlans(decisions, protectionIntents))
            const fills = yield* Effect.fromResult(
              captureExecutionFills(
                plans,
                yield* readSystemExecutionFills(scope, first.openAt, last.closeAt),
                accountIdentity.accountId,
                definition.authorityGenerationHash,
              ),
            )
            const cashObservations = yield* readSystemCashObservations(accountIdentity.accountId, {
              accountBindingHash: definition.accountBindingHash,
              openAt: first.openAt,
              closeAt: last.closeAt,
              asOf,
            })
            const inventory = yield* Effect.fromResult(prepareValuationInventory(forward))
            const observedTimes = new Set(cashObservations.map((mark) => mark.at))
            const scheduled = yield* Effect.forEach(
              requiredValuationTimes(registration.calendar.sessions).filter(
                (at) => at <= asOf && !observedTimes.has(at),
              ),
              (at) =>
                Effect.gen(function* () {
                  const source = { accountBindingHash: definition.accountBindingHash, at, registrationHash }
                  return {
                    accountBindingHash: definition.accountBindingHash,
                    at,
                    availableAt: asOf,
                    cashMicros: null,
                    sourceHash: yield* Effect.fromResult(canonicalHashV1Result(source)),
                  }
                }),
            )
            const observations = [...cashObservations, ...scheduled].sort((a, b) => a.at.localeCompare(b.at))
            const holdingsByTime = new Map(observations.map((mark) => [mark.at, inventory.at(mark.at)]))
            const quoteRequests = [...holdingsByTime].flatMap(([at, holdings]) =>
              holdings === null || holdings.length === 0
                ? []
                : [{ at, symbols: holdings.map((position) => position.symbol) }],
            )
            const quotes = yield* readValuationQuotes(definition, quoteRequests)
            const accountMarks = yield* Effect.forEach(observations, (cash) =>
              Effect.gen(function* () {
                const holdings = holdingsByTime.get(cash.at)
                const positions =
                  holdings?.map((position) => {
                    const bid = executableBid(
                      quotes.get(cash.at)?.get(position.symbol),
                      position.symbol,
                      cash.at,
                      registration.obligations.configuration.protocol.maximumQuoteAgeMs,
                    )
                    return bid === null ? null : { ...position, ...bid }
                  }) ?? null
                const supported = positions?.filter((position) => position !== null) ?? []
                const valuation =
                  positions === null || supported.length !== positions.length
                    ? null
                    : {
                        inventorySourceHash: inventory.sourceHash,
                        positions: supported,
                      }
                return {
                  ...cash,
                  valuation,
                  sourceHash: yield* Effect.fromResult(canonicalHashV1Result({ cash, valuation })),
                }
              }),
            )
            const store = makeInferenceExpenseStore(sql, accountIdentity.accountId)
            const inferenceSnapshots = yield* Effect.forEach(registration.calendar.sessions, ({ sessionDate }) =>
              Effect.gen(function* () {
                const snapshot = yield* readInferenceExpenseSnapshot(sql, accountIdentity.accountId, sessionDate)
                yield* Effect.fromResult(
                  verifyInferenceExpenseCoverage(snapshot.evidence, accountIdentity.accountId, snapshot.quotes),
                )
                const ledger = yield* readInferenceExpenseLedger(client, snapshot, store.currentSession(sessionDate))
                return {
                  ...snapshot,
                  evidence: {
                    ...snapshot.evidence,
                    requests: snapshot.evidence.requests.map(
                      ({
                        requestSchemaVersion: _version,
                        sourceFingerprint: _fingerprint,
                        stages: _stages,
                        ...source
                      }) => source,
                    ),
                  },
                  ledger,
                }
              }),
            )
            if (
              forward.transactions.some(
                (t) =>
                  t.occurredAt >= first.openAt &&
                  t.occurredAt <= last.closeAt &&
                  (t.symbol === undefined ||
                    !registration.obligations.configuration.protocol.universe.includes(t.symbol) ||
                    !registration.calendar.tradingMarkets.includes(instrumentMarket(t.symbol))),
              ) ||
              decisions.some(({ document }) =>
                [document.bindings.decisionMarketData, document.bindings.executionMarketData].some(
                  (binding) =>
                    binding !== undefined &&
                    isSnapshotExecutionMarketDataBinding(binding) &&
                    !sourceFitsRegisteredSession(binding, registration, binding.observedAt),
                ),
              )
            )
              return yield* new SystemAssessmentError({
                message: 'Captured market scope is incompatible with the registered policy and session windows',
              })
            const protectionDecisions = yield* Effect.forEach(protectionIntents, (intent) =>
              Effect.gen(function* () {
                const session = registration.calendar.sessions.find(
                  (session) =>
                    intent.riskDecision.decidedAt >= session.openAt && intent.riskDecision.decidedAt <= session.closeAt,
                )
                if (session === undefined)
                  return yield* new SystemAssessmentError({
                    message: 'Protection approval falls outside the registered sessions',
                  })
                return { sessionDate: session.sessionDate, decisionHash: intent.intentId }
              }),
            )
            const financial = yield* Effect.fromResult(
              captureForwardFinancialEvidence(registration, definition.policy, forward, {
                decisions: [
                  ...decisions.map(({ sessionDate, document }) => ({
                    sessionDate,
                    decisionHash: document.contentHash,
                  })),
                  ...protectionDecisions,
                ],
                fills,
              }),
            )
            accounts.push({
              policy: definition.policy,
              identity: accountIdentity,
              forward,
              decisions,
              protectionIntents,
              fills,
              accountMarks,
              cashObservations,
              valuationQuoteSources: [
                ...new Map(
                  [...quotes.values()].flatMap((bySymbol) =>
                    [...bySymbol.values()].map((quote) => [quote.recordHash, quote.source]),
                  ),
                ).values(),
              ],
              inferenceSnapshots,
              financial,
            })
          }
          const candidateAccount = accounts.find((account) => account.policy === JevResearchPolicy.Candidate)
          if (candidateAccount === undefined)
            return yield* new SystemAssessmentError({
              message: 'Registered candidate authority generation is unavailable',
            })
          const { decisions } = candidateAccount
          const mutations = yield* readSystemMutationEvidence(
            identity.accountId,
            candidate.authorityGenerationHash,
            first.openAt,
          )
          const batches = yield* readSystemBatchEvidence(
            identity.accountId,
            candidate.authorityGenerationHash,
            first.openAt,
            last.closeAt,
          )
          const controllerPasses = yield* readSystemControllerPasses(
            identity.identityHash,
            registration.obligations.configuration.controllerPlanHash,
            first.openAt,
            last.closeAt,
            asOf,
          )
          const durableObservations = yield* readSystemDurableObservations(registrationHash)
          const decisionAdmissions = yield* readSystemDecisionAdmissions({
            accountId: identity.accountId,
            generationHash: candidate.authorityGenerationHash,
            openAt: first.openAt,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          })
          const scope = {
            accountId: identity.accountId,
            generationHash: candidate.authorityGenerationHash,
            openAt: first.openAt,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          }
          const { protectionIntents, fills } = candidateAccount
          const plans = yield* Effect.fromResult(executionOrderPlans(decisions, protectionIntents))
          const orders = yield* Effect.fromResult(
            captureExecutionOrders(
              plans,
              yield* readSystemExecutionOrders(scope),
              identity.accountId,
              candidate.authorityGenerationHash,
            ),
          )
          const sourceMaterial = {
            runtimeConfiguration,
            accounts,
            decisions,
            batches,
            mutations,
            orders,
            protectionIntents,
            accountMarks: accounts.flatMap((account) => account.accountMarks),
            controllerPasses,
            durableObservations,
            decisionAdmissions,
          }
          return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema)({
            schemaVersion: 'bayn.system-source-cut.v4',
            decisionAdmissions,
            registrationHash,
            asOf,
            runtimeConfigurationHash,
            financial: accounts.map((account) => account.financial),
            inference: accounts.flatMap((account) => account.inferenceSnapshots.map((snapshot) => snapshot.evidence)),
            inferenceLedgerEvidenceHash: yield* Effect.fromResult(
              canonicalHashV1Result(
                accounts.map((account) => ({
                  policy: account.policy,
                  snapshots: account.inferenceSnapshots,
                })),
              ),
            ),
            decisions,
            batches,
            mutations,
            fills,
            orders,
            protectionIntents,
            accountMarks: accounts.flatMap((account) => account.accountMarks),
            controllerPasses,
            durableObservations,
            sourceMaterial,
            sourceMaterialHash: yield* Effect.fromResult(canonicalHashV1Result(sourceMaterial)),
          })
        }),
      )
      const saved = yield* persistSystemSourceCut(cut)
      return {
        ...saved,
        controllerLatency: yield* Effect.fromResult(measureControllerLatency(registration, cut, identity)),
        fullBatchLatency: yield* Effect.fromResult(measureFullBatchLatency(registration, cut, identity)),
      }
    }),
  ).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'System source capture failed', cause })))
