import {
  readSystemCashObservations,
  readSystemFeeSettlementAnchors,
  readSystemBatchEvidence,
  readSystemAlphaObservations,
  readSystemAlphaBaselinePreparations,
  readSystemMutationEvidence,
  readSystemControllerPasses,
  readSystemDurableObservations,
  readStrategyBoundSystemDurableObservations,
  readPreparedAlphaSystemDurableObservations,
  readSystemDecisionAdmissions,
  systemDecisionQuery,
} from './capture-queries'
import { readRegisteredFinancialIdentity } from './capital-identity'
import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { readForwardPerformanceInput } from '../forward-performance/program'
import type { ForwardPerformanceConfig } from '../forward-performance/config'
import { acquireInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { verifyInferenceExpenseCoverage } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { JevResearchPolicy } from '../jev/acceptance'
import { instrumentMarket } from '../instruments'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import { readAssessmentRegistration } from './postgres'
import { SystemAssessmentError } from './economics'
import { captureForwardFinancialEvidence } from './forward-evidence'
import { RetainedSystemSourceCutSchema, SystemSourceCutSchema, persistSystemSourceCut } from './source-cut'
import { captureQualificationRuntime, configuredQualificationRuntime } from './configuration'
import { BrokerEnvironment } from '../broker/identity'
import { alpacaHttpLayer } from '../broker/alpaca/http'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import {
  nativeBrokerRecoveryClose,
  registeredMarkIntervalMs,
  isNativeSystemRegistration,
  isStrategyBoundSystemRegistration,
  type SystemRegistration,
} from './policy'
import { measureControllerLatency } from './controller-latency'
import { measureRegisteredDecisionLatency } from './native-decision-latency'
import { decisionMarketScopeSupported } from './decision-work'
import { prepareValuationInventory, requiredValuationTimes } from './valuation'
import { executableValuationQuote, readValuationQuotes } from './valuation-quotes'
import { captureExecutionOrders, captureExecutionFills } from './execution-evidence'
import { readSystemExecutionOrders, readSystemExecutionFills, readSystemProtectionIntents } from './execution-capture'
import { executionOrderPlans } from './execution-plans'
import { captureInferenceSnapshot } from './inference-capture'
import { captureOperationalSourceCut } from './operational-capture'
import { captureNativeBrokerStatements } from './broker-statements'

import { incumbentTigerBeetle, openIncumbentPostgres } from './incumbent-store'
import { requirePairedIncumbentWitness } from './paired-witness'
import { forwardPerformanceSnapshot } from '../forward-performance/postgres/snapshot'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'

const readSnapshotTime = (sql: PgClient.PgClient) =>
  Effect.gen(function* () {
    const times = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ asOf: UtcInstantSchema })))(
      yield* sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"`,
    )
    const clock = times[0]
    if (clock === undefined)
      return yield* new SystemAssessmentError({ message: 'Database snapshot time is unavailable' })
    return clock.asOf
  })

/** Capture independent snapshots against the same registered trading windows. */
export const captureSystemSourceCut = (config: ForwardPerformanceConfig, registrationHash: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registration = yield* readAssessmentRegistration(registrationHash)
      if (registration.program === 'BAYN_OPERATIONAL_RELIABILITY')
        return yield* captureOperationalSourceCut(config, registrationHash, registration)
      const { runtimeConfiguration, runtimeConfigurationHash } = yield* Effect.fromResult(
        captureQualificationRuntime(
          yield* Effect.fromResult(configuredQualificationRuntime(config, registration.obligations.configuration)),
          registration.obligations,
        ),
      )
      const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
      const identity = config.execution.brokerIdentity
      const first = registration.calendar.sessions[0]
      const last = registration.calendar.sessions.at(-1)
      if (
        candidate === undefined ||
        identity === undefined ||
        identity.environment !== BrokerEnvironment.Sandbox ||
        identity.accountId !== candidate.riskPolicy.accountId ||
        identity.identityHash !== config.alpaca.identity.identityHash ||
        first === undefined ||
        last === undefined
      )
        return yield* new SystemAssessmentError({
          message: 'Source capture requires a registered candidate and broker identity',
        })
      const sql = yield* PgClient.PgClient
      const incumbent = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Incumbent)
      const peer = incumbent === undefined ? undefined : yield* openIncumbentPostgres(config, true)
      const incumbentConfig =
        incumbent === undefined ? undefined : { ...config, tigerBeetle: yield* incumbentTigerBeetle }
      const incumbentWitness =
        incumbent === undefined || peer === undefined
          ? undefined
          : yield* requirePairedIncumbentWitness(sql, peer, registrationHash, incumbent.authorityGenerationHash)
      const brokerRecoveryClose = nativeBrokerRecoveryClose(registration)
      const statementCut = yield* currentUtcInstant
      const brokerStatements =
        brokerRecoveryClose !== undefined && statementCut >= brokerRecoveryClose
          ? yield* captureNativeBrokerStatements(config.alpaca, registration.policies, {
              // Include the prior day so a proof can select a real before-open anchor.
              after: utcInstantFromEpochMillis(Date.parse(first.openAt) - 86_400_000),
              until: statementCut,
            }).pipe(
              // @effect-diagnostics-next-line strictEffectProvide:off -- private capture owns the shared proxy transport
              Effect.provide(alpacaHttpLayer(config.alpaca)),
            )
          : undefined
      const settlementWindows = isNativeSystemRegistration(registration)
        ? registration.calendar.sessions.flatMap((session) => {
            const provider = registration.calendar.marketCalendar.providerSessions.find(
              (row) => row.date === session.sessionDate,
            )
            return provider === undefined ? [] : [{ ...session, recoveryCloseAt: provider.sessionCloseAt }]
          })
        : []
      if (brokerRecoveryClose !== undefined && settlementWindows.length !== registration.calendar.sessions.length)
        return yield* new SystemAssessmentError({ message: 'A native session is missing its settlement window' })
      const captureAccount = (
        definition: SystemRegistration['policies'][number],
        ownerConfig: ForwardPerformanceConfig,
        asOf: string,
      ) =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const accountIdentity = yield* readRegisteredFinancialIdentity(
            definition,
            definition.policy === JevResearchPolicy.Incumbent ? { incumbentWitnessHash: registrationHash } : undefined,
          )
          const brokerNonTradeActivity = brokerStatements?.get(definition.policy)
          if (
            brokerStatements !== undefined &&
            (accountIdentity === null ||
              brokerNonTradeActivity === undefined ||
              brokerNonTradeActivity.accountIdentityHash !== accountIdentity.identityHash ||
              brokerNonTradeActivity.observedAt > asOf)
          )
            return yield* new SystemAssessmentError({
              message: 'Broker activity statement differs from its registered account or evidence cut',
            })
          if (accountIdentity === null) return null
          if (
            definition.policy === JevResearchPolicy.Candidate &&
            accountIdentity.identityHash !== identity.identityHash
          )
            return yield* new SystemAssessmentError({
              message: 'Candidate capture differs from the configured account',
            })
          const accountConfig = {
            ...ownerConfig,
            execution: { ...ownerConfig.execution, brokerIdentity: accountIdentity },
          }
          const forward = yield* readForwardPerformanceInput(accountConfig, undefined, {
            authorityGenerationHash: definition.authorityGenerationHash,
          })
          const decisions = yield* Schema.decodeUnknownEffect(RetainedSystemSourceCutSchema.fields.decisions)(
            yield* systemDecisionQuery(sql, {
              accountId: accountIdentity.accountId,
              generationHash: definition.authorityGenerationHash,
              firstSession: first.sessionDate,
              lastSession: last.sessionDate,
            }),
          )
          const scope = {
            accountId: accountIdentity.accountId,
            generationHash: definition.authorityGenerationHash,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          }
          const protectionIntents = yield* readSystemProtectionIntents(scope, definition.riskPolicy.maxBrokerStateAgeMs)
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
          const settlementAnchors =
            settlementWindows.length === 0
              ? undefined
              : yield* readSystemFeeSettlementAnchors(accountIdentity.accountId, settlementWindows, asOf)
          const inventory = yield* Effect.fromResult(prepareValuationInventory(forward))
          const observedTimes = new Set(cashObservations.map((mark) => mark.at))
          const scheduled = yield* Effect.forEach(
            requiredValuationTimes(registration.calendar.sessions, registeredMarkIntervalMs(registration)).filter(
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
                  const quote = executableValuationQuote(
                    quotes.get(cash.at)?.get(position.symbol),
                    position.symbol,
                    cash.at,
                    registration.obligations.configuration.protocol.maximumQuoteAgeMs,
                    registration.obligations.configuration.protocol.marketProfiles.find(
                      (profile) => profile.market === instrumentMarket(position.symbol),
                    ),
                    position.quantityAtoms,
                  )
                  return quote === null ? null : { ...position, ...quote }
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
          const inferenceSources = yield* Effect.forEach(registration.calendar.sessions, ({ sessionDate }) =>
            acquireInferenceExpenseSnapshot(sql, accountIdentity.accountId, sessionDate),
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
            decisions.some(({ document }) => !decisionMarketScopeSupported(document, registration))
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
          return {
            capturedAt: asOf,
            policy: definition.policy,
            identity: accountIdentity,
            ...(brokerNonTradeActivity === undefined ? {} : { brokerNonTradeActivity }),
            forward,
            decisions,
            protectionIntents,
            fills,
            accountMarks,
            cashObservations,
            ...(settlementAnchors === undefined ? {} : { settlementAnchors }),
            valuationQuoteSources: [
              ...new Map(
                [...quotes.values()].flatMap((bySymbol) =>
                  [...bySymbol.values()].map((quote) => [quote.recordHash, quote.source]),
                ),
              ).values(),
            ],
            inferenceSources,
            financial,
          }
        })
      const captured = yield* forwardPerformanceSnapshot(sql).withTransaction(
        Effect.gen(function* () {
          const asOf = yield* readSnapshotTime(sql)
          const accounts = (yield* Effect.forEach(
            registration.policies.filter((definition) => definition.policy !== JevResearchPolicy.Incumbent),
            (definition) => captureAccount(definition, config, asOf),
          )).filter((account) => account !== null)
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
          const durableObservations =
            registration.schemaVersion === 'bayn.system-registration.v7'
              ? yield* readPreparedAlphaSystemDurableObservations(registrationHash, asOf)
              : registration.schemaVersion === 'bayn.system-registration.v6'
                ? yield* readStrategyBoundSystemDurableObservations(registrationHash, asOf)
                : yield* readSystemDurableObservations(registrationHash)
          const alphaObservations = isStrategyBoundSystemRegistration(registration)
            ? yield* readSystemAlphaObservations(
                identity.accountId,
                candidate.authorityGenerationHash,
                registration.calendar,
                asOf,
                yield* Effect.fromResult(canonicalHashV1Result(registration.obligations.configuration.protocol)),
              )
            : []
          const alphaBaselinePreparations =
            registration.schemaVersion === 'bayn.system-registration.v7'
              ? yield* readSystemAlphaBaselinePreparations(registration, asOf)
              : []
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
          return {
            accounts,
            asOf,
            decisions,
            mutations,
            orders,
            protectionIntents,
            controllerPasses,
            durableObservations,
            decisionAdmissions,
            batches,
            alphaObservations,
            alphaBaselinePreparations,
            fills,
          }
        }),
      )
      const incumbentAccount =
        incumbent === undefined || peer === undefined || incumbentConfig === undefined
          ? null
          : yield* forwardPerformanceSnapshot(peer)
              .withTransaction(
                Effect.flatMap(readSnapshotTime(peer), (asOf) => captureAccount(incumbent, incumbentConfig, asOf)),
              )
              .pipe(Effect.provideService(PgClient.PgClient, peer))
      if (incumbent !== undefined && incumbentAccount === null)
        return yield* new SystemAssessmentError({ message: 'Independent incumbent capture is unavailable' })
      const asOf =
        incumbentAccount !== null && incumbentAccount.capturedAt > captured.asOf
          ? incumbentAccount.capturedAt
          : captured.asOf
      const {
        decisions,
        mutations,
        orders,
        protectionIntents,
        controllerPasses,
        durableObservations,
        decisionAdmissions,
        batches,
        alphaObservations,
        alphaBaselinePreparations,
        fills,
      } = captured
      const candidateLedger = yield* makeTigerBeetleRequestClient(config)
      const incumbentLedger =
        incumbentConfig === undefined ? undefined : yield* makeTigerBeetleRequestClient(incumbentConfig)
      const capturedAccounts = incumbentAccount === null ? captured.accounts : [...captured.accounts, incumbentAccount]
      const accounts = yield* Effect.forEach(capturedAccounts, ({ inferenceSources, ...account }) =>
        Effect.gen(function* () {
          const owner = account.policy === JevResearchPolicy.Incumbent ? peer : sql
          const client = account.policy === JevResearchPolicy.Incumbent ? incumbentLedger : candidateLedger
          if (owner === undefined || client === undefined)
            return yield* new SystemAssessmentError({ message: 'Qualified account ledger is unavailable' })
          const store = makeInferenceExpenseStore(owner, account.identity.accountId)
          const inferenceSnapshots = yield* Effect.forEach(inferenceSources, ({ verify }) =>
            Effect.gen(function* () {
              const snapshot = yield* verify
              yield* Effect.fromResult(
                verifyInferenceExpenseCoverage(snapshot.evidence, account.identity.accountId, snapshot.quotes),
              )
              const ledger = yield* readInferenceExpenseLedger(
                client,
                snapshot,
                store.currentSession(snapshot.evidence.sessionDate),
              )
              return { ...captureInferenceSnapshot(snapshot, registration.program), ledger }
            }),
          )
          return { ...account, inferenceSnapshots }
        }),
      )
      const sourceAccounts = accounts.map(({ inferenceSnapshots, ...account }) => ({
        ...account,
        inferenceSnapshots: inferenceSnapshots.map(({ source, ledger }) => ({ ...source, ledger })),
      }))
      const sourceMaterial = {
        ...(incumbentWitness === undefined ? {} : { incumbentWitness }),
        captureBuild: {
          sourceRevision: config.build.sourceRevision,
          imageRepository: config.build.imageRepository,
          imageDigest: config.build.imageDigest,
        },
        runtimeConfiguration,
        accounts: sourceAccounts,
        decisions,
        mutations,
        orders,
        protectionIntents,
        accountMarks: accounts.flatMap((account) => account.accountMarks),
        controllerPasses,
        durableObservations,
        decisionAdmissions,
        ...(isStrategyBoundSystemRegistration(registration) ? { alphaObservations } : {}),
        ...(registration.schemaVersion === 'bayn.system-registration.v7' ? { alphaBaselinePreparations } : {}),
      }
      const cut = yield* Schema.decodeUnknownEffect(
        SystemSourceCutSchema,
        strictParseOptions,
      )({
        ...(registration.schemaVersion === 'bayn.system-registration.v7'
          ? { schemaVersion: 'bayn.system-source-cut.v6', alphaObservations, alphaBaselinePreparations }
          : registration.schemaVersion === 'bayn.system-registration.v6'
            ? { schemaVersion: 'bayn.system-source-cut.v5', alphaObservations }
            : { schemaVersion: 'bayn.system-source-cut.v4' }),
        decisionAdmissions,
        registrationHash,
        asOf,
        runtimeConfigurationHash,
        financial: accounts.map((account) => account.financial),
        inference: accounts.flatMap((account) =>
          account.inferenceSnapshots.flatMap((snapshot) => (snapshot.evidence === null ? [] : [snapshot.evidence])),
        ),
        inferenceLedgerEvidenceHash: yield* Effect.fromResult(
          canonicalHashV1Result(
            sourceAccounts.map((account) => ({
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
      if (cut.schemaVersion === 'bayn.system-source-cut.v6')
        yield* Effect.fromResult(derivePreparedAlphaBaselineSources(cut))
      const saved = yield* persistSystemSourceCut(cut)
      return {
        sourceCutHash: saved.sourceCutHash,
        controllerLatency: yield* Effect.fromResult(measureControllerLatency(registration, cut, identity)),
        fullBatchLatency: yield* Effect.fromResult(measureRegisteredDecisionLatency(registration, cut, identity)),
      }
    }),
  ).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'System source capture failed', cause })))
