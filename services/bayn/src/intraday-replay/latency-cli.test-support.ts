import { readSystemMutationEvidence, readSystemDecisionAdmissions } from '../system-assessment/capture'
import { decisionAdmissionWitnesses } from '../system-assessment/decision-admissions'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Redacted, Result, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { PostgresClientLive } from '../db/postgres-client'
import { OrderSide as BrokerOrderSide } from '../broker/alpaca/model'
import { sha256 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { IsoDateSchema } from '../schemas'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { registeredTradeReplayFixture } from '../testing/registered-replay-fixture'
import { retainReplayArrivals, retainedReplayFixture } from '../testing/retained-replay-fixture'
import {
  calibrateNativeLatencyFixture,
  fullBatchLatencyFixture,
  latencyCalibrationDecisionFixture,
  nativeLatencyBacktestFixture,
} from '../system-assessment/latency.test-support'
import {
  supportedAssessmentFixture,
  testHash,
  withRegistrationCommitments,
} from '../system-assessment/fixtures.test-support'
import { bindLatencyStressSources } from '../system-assessment/latency-report'
import { reproduceReplaySessionEconomics } from '../system-assessment/latency-economics'
import { backtestBrokerEvidenceConfig, prepareBacktest } from './backtest'
import { ReplayBrokerCheckpointSchema } from './broker-checkpoint'
import { ReplayInferenceCallSchema } from './inference-timing'
import { NativeReplayPolicySchema } from './native-policy'
import { executionDecisionRows } from '../db/execution-decision-query'
import { decodeExecutionDecisionDocument } from '../shadow-decision-contract'
import {
  readSystemExecutionOrders,
  readSystemProtectionIntents,
  readSystemExecutionFills,
} from '../system-assessment/execution-capture'
import { executionOrderPlans } from '../system-assessment/execution-plans'
import {
  bindExecutionEvidence,
  captureExecutionOrders,
  captureExecutionFills,
} from '../system-assessment/execution-evidence'
import { resolveExecutionOrderTerms } from '../system-assessment/execution-order-terms'

// Compression is part of each chart request hash, so retained receipts use the release runtime throughout.
const main = Effect.gen(function* () {
  const [rawPolicy, mode, directory, executablePath] = process.argv.slice(2)
  const policy = yield* Schema.decodeUnknownEffect(NativeReplayPolicySchema)(rawPolicy)
  assert.ok(mode === 'trading' || mode === 'missing')
  assert.ok(directory !== undefined && executablePath !== undefined)
  const trading = mode === 'trading'
  assert.ok(baynTestPostgresUrl !== undefined && baynTestTigerBeetleAddress !== undefined)
  const url = new URL(baynTestPostgresUrl)
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname.endsWith('_test') &&
      /^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress),
    'Latency CLI acceptance requires isolated local test databases',
  )
  const databases = {
    operationTimeoutMs: 30000,
    postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
  }
  yield* Effect.gen(function* () {
    const market = trading ? registeredTradeReplayFixture() : null
    const retained = retainedReplayFixture()
    // Missing decision inputs must remain missing at every measured replay time, including on slower CI hosts.
    const source =
      market ??
      retainReplayArrivals(
        retained.events.filter((event) =>
          retained.manifest.marketSources.some((source) => source.topics.quotes === event.record.topic),
        ),
        retained.manifest.marketSources,
        retained.manifest.deliveryModel,
      )
    const first = market?.sessions[0]
    const { native, document } = yield* market !== null && first !== undefined
      ? calibrateNativeLatencyFixture(
          nativeJevFixture(
            JevPurpose.Entry,
            new Date(Date.parse(first.regularOpenAt) + 152000).toISOString(),
            undefined,
            undefined,
            undefined,
            undefined,
            market.calendarObservation,
          ),
        )
      : latencyCalibrationDecisionFixture
    const sessions = market?.sessions.map((s) => ({
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(s.date),
      openAt: s.regularOpenAt,
      closeAt: s.regularCloseAt,
    }))
    const calibration = fullBatchLatencyFixture(document, native, sessions)
    const configuredRegistration = withRegistrationCommitments({
      ...calibration.registration,
      obligations: {
        ...calibration.registration.obligations,
        configuration: { ...calibration.registration.obligations.configuration, operationTimeoutMs: 120000 },
      },
    })
    const {
      input: registeredInput,
      registration,
      cut,
      capture,
    } = nativeLatencyBacktestFixture(
      { ...calibration, registration: configuredRegistration },
      undefined,
      policy,
      source.manifest,
    )
    const input = { ...registeredInput, replicate: randomUUID() }
    const prepared = Result.getOrThrow(prepareBacktest(input, capture))
    const definition = registration.policies.find((p) => p.policy === policy)
    if (definition === undefined) throw new Error('Missing registered candidate')
    const fs = yield* FileSystem.FileSystem
    const arrivalsPath = `${directory}/arrivals.ndjson.gz`
    const inputPath = `${directory}/input.json`
    const capturePath = `${directory}/capture.json`
    const outputPath = `${directory}/output`
    yield* fs.writeFile(arrivalsPath, gzipSync(source.body))
    yield* fs.writeFileString(inputPath, JSON.stringify(input))
    yield* fs.writeFileString(capturePath, JSON.stringify(capture.value))
    const sql = yield* PgClient.PgClient
    yield* sql`DROP SCHEMA public CASCADE`
    yield* sql`CREATE SCHEMA public`
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          executablePath,
          '--input',
          inputPath,
          '--arrivals',
          arrivalsPath,
          '--source-receipt',
          capturePath,
          '--source-receipt-sha256',
          capture.contentHash,
          '--output',
          outputPath,
        ],
        {
          env: {
            BAYN_PUBLIC_INFORMATION_PROXY: '',
            BAYN_OPENAI_API_KEY: '',
            BAYN_JEV_API_KEY: '',
            BAYN_BACKTEST_POSTGRES_URL: baynTestPostgresUrl,
            BAYN_BACKTEST_TIGERBEETLE_ADDRESS: baynTestTigerBeetleAddress,
            BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID: '20912',
            BAYN_BACKTEST_TIGERBEETLE_LEDGER: '70912',
          },
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'inherit',
        },
      ),
    )
    assert.equal(Number(yield* child.exitCode), 0)
    const reportBytes = yield* fs.readFile(`${outputPath}/report.json`)
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
          profitability: Schema.Literal('UNPROVEN'),
          issues: Schema.Array(Schema.String),
          executableSha256: Schema.String,
          brokerCheckpoint: ReplayBrokerCheckpointSchema,
          inference: Schema.Struct({
            calls: Schema.Array(ReplayInferenceCallSchema),
            providerDispatchCount: Schema.Number,
            retainedCallCount: Schema.Number,
          }),
          latencyStress: Schema.Struct({ protocolHash: Schema.String }),
          sessions: Schema.Array(
            Schema.Struct({
              sessionDate: Schema.String,
              completion: Schema.String,
              issues: Schema.Array(Schema.String),
            }),
          ),
        }),
      ),
    )(new TextDecoder().decode(reportBytes))
    const executableHash = sha256(yield* fs.readFile(executablePath))
    assert.equal(report.executableSha256, executableHash)
    assert.equal(
      report.completion,
      trading ? 'COMPLETE' : 'INCOMPLETE',
      JSON.stringify({ issues: report.issues, sessions: report.sessions }),
    )
    if (trading) {
      assert.deepEqual(report.brokerCheckpoint.state.ledger.positions, [])
      const identities = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ accountId: Schema.String, generationHash: Schema.String })),
      )(
        yield* sql`SELECT DISTINCT intents.account_id AS "accountId", intents.authority_generation_hash AS "generationHash"
        FROM autonomous_cycles JOIN intents USING (cycle_id)`,
      )
      assert.ok(identities.length > 0)
      const firstSession = registration.calendar.sessions[0]
      const lastSession = registration.calendar.sessions.at(-1)
      assert.ok(firstSession !== undefined && lastSession !== undefined)
      const documents = yield* Effect.forEach(
        yield* sql`SELECT document FROM (${executionDecisionRows(sql)}) decisions`,
        (row) => Effect.fromResult(decodeExecutionDecisionDocument(row['document'])),
      )
      const orders = yield* Effect.forEach(identities, (identity) =>
        Effect.gen(function* () {
          const scope = {
            ...identity,
            firstSession: firstSession.sessionDate,
            lastSession: lastSession.sessionDate,
            asOf: lastSession.closeAt,
          }
          const protection = yield* readSystemProtectionIntents(scope, definition.riskPolicy.maxBrokerStateAgeMs)
          const plans = yield* Effect.fromResult(
            executionOrderPlans(
              documents
                .filter(
                  (document) =>
                    document.bindings.accountId === identity.accountId &&
                    document.bindings.authorityGenerationHash === identity.generationHash,
                )
                .map((document) => ({ document })),
              protection,
            ),
          )
          const orders = yield* Effect.fromResult(
            captureExecutionOrders(
              plans,
              yield* readSystemExecutionOrders(scope),
              identity.accountId,
              identity.generationHash,
            ),
          )
          const fills = yield* Effect.fromResult(
            captureExecutionFills(
              plans,
              yield* readSystemExecutionFills(scope, firstSession.openAt, lastSession.closeAt),
              identity.accountId,
              identity.generationHash,
            ),
          )
          const mutations = yield* readSystemMutationEvidence(
            identity.accountId,
            identity.generationHash,
            firstSession.openAt,
          )
          const decisionAdmissions = yield* readSystemDecisionAdmissions({
            ...identity,
            firstSession: firstSession.sessionDate,
            lastSession: lastSession.sessionDate,
            asOf: scope.asOf,
          })
          const executionCut = {
            ...cut,
            asOf: scope.asOf,
            protectionIntents: protection,
            orders,
            fills,
            mutations,
            decisionAdmissions,
            decisions: documents
              .filter(
                (document) =>
                  document.bindings.authorityGenerationHash === identity.generationHash &&
                  document.bindings.accountId === identity.accountId,
              )
              .map((document) => {
                assert.ok(document.executionSession !== undefined)
                return { sessionDate: document.executionSession.executionSession.date, document }
              }),
          }
          const template = supportedAssessmentFixture().input.realism.fills[0]
          assert.ok(template !== undefined)
          const supplied = fills.map((fill) => ({
            ...template,
            fillId: fill.fillId,
            intentId: fill.intentId,
            decisionId: fill.decisionId,
            orderId: fill.brokerOrderId,
            sourceHash: fill.sourceHash,
            positionOwnerGenerationHash: identity.generationHash,
            side: fill.side,
            fillQuantityAtoms: fill.quantityAtoms,
            fillPriceAtoms: fill.priceAtoms,
            filledAt: fill.occurredAt,
          }))
          const bound = yield* Effect.fromResult(bindExecutionEvidence(supplied, executionCut, identity.generationHash))
          assert.deepEqual(bound.missing, [])
          const admissions = yield* Effect.fromResult(decisionAdmissionWitnesses(executionCut, identity.generationHash))
          for (const evidence of protection)
            assert.ok(
              admissions.witnesses.some((row) => row.sourceHash === evidence.intentId),
              'Missing replacement admission',
            )
          for (const fill of fills) assert.ok(plans.has(fill.intentId))
          return { orders, plans, fills, protection }
        }),
      )
      const plans = new Map(orders.flatMap((group) => [...group.plans]))
      assert.ok(
        orders.some((group) => group.protection.length > 0),
        'Expected separately armed native protection',
      )
      assert.equal(orders.flatMap((group) => group.fills).length, report.brokerCheckpoint.state.ledger.fills.length)
      const receipts = orders.flatMap((group) => group.orders)
      const byBrokerId = new Map(receipts.map((row) => [row.order.brokerOrderId, row]))
      for (const brokerId of new Set(report.brokerCheckpoint.state.ledger.fills.map((fill) => fill.brokerOrderId))) {
        const receipt = byBrokerId.get(brokerId)
        assert.ok(receipt !== undefined, `Missing captured native broker order ${brokerId}`)
        const root =
          receipt.order.parentBrokerOrderId === undefined ? receipt : byBrokerId.get(receipt.order.parentBrokerOrderId)
        assert.ok(root !== undefined)
        const plan = plans.get(root.intentId)
        assert.ok(plan !== undefined)
        const terms = yield* Effect.fromResult(
          resolveExecutionOrderTerms(
            brokerId,
            root,
            receipts.filter((row) => row.order.parentBrokerOrderId === root.order.brokerOrderId),
            plan,
          ),
        )
        assert.equal(terms._tag, 'Bound')
      }
      for (const session of registration.calendar.sessions) {
        const fills = report.brokerCheckpoint.state.ledger.fills.filter(
          (fill) => fill.observedAt >= session.openAt && fill.observedAt <= session.closeAt,
        )
        assert.ok(
          fills.some((fill) => fill.side === BrokerOrderSide.Buy),
          session.sessionDate,
        )
        assert.ok(
          fills.some((fill) => fill.side === BrokerOrderSide.Sell),
          session.sessionDate,
        )
      }
    }
    assert.deepEqual(report.inference, { calls: [], providerDispatchCount: 0, retainedCallCount: 0 })
    assert.deepEqual(
      report.sessions.map((s) => s.sessionDate),
      registration.calendar.sessions.map((s) => s.sessionDate),
    )
    assert.equal(report.latencyStress.protocolHash, registration.latencyStressProtocolHash)
    const sources = new Set([
      definition.costAllocationRuleHash,
      executableHash,
      input.source.dataSha256,
      ...registration.costAllocationPlans.map((plan) => plan.basisSourceHash),
    ])
    const costs = {
      policy,
      allocationRuleHash: definition.costAllocationRuleHash,
      asOf: cut.asOf,
      inferenceCalls: report.inference.calls,
      inferenceTariff: input.inference.costs,
      sessions: registration.calendar.sessions.map((s) => {
        const invoiceHash = testHash({ category: 'fixture infrastructure invoice', session: s.sessionDate })
        sources.add(invoiceHash)
        return {
          schemaVersion: 'bayn.operating-cost-evidence.v1',
          accountBindingHash: definition.accountBindingHash,
          sessionDate: s.sessionDate,
          asOf: cut.asOf,
          currency: 'USD',
          trading: null,
          coverage: Object.values(OperatingCostCategory).map((category) => ({
            category,
            status: OperatingCostCoverage.Complete,
            sourceHash: invoiceHash,
          })),
          consumption: [
            {
              provider: `${policy}:synthetic fixture`,
              documentId: invoiceHash,
              lineId: '1',
              sourceHash: invoiceHash,
              category: OperatingCostCategory.Infrastructure,
              serviceStartDate: s.sessionDate,
              serviceEndDateExclusive: new Date(Date.parse(`${s.sessionDate}T00:00:00Z`) + 86400000)
                .toISOString()
                .slice(0, 10),
              grossAmountMicros: '1000000',
              credits: [],
              unallocatedMicros: '0',
              allocations: [
                {
                  accountBindingHash: definition.accountBindingHash,
                  sessionDate: s.sessionDate,
                  amountMicros: '1000000',
                  sourceHash: invoiceHash,
                },
              ],
            },
          ],
          prepaidFunding: [],
        }
      }),
    }
    const artifacts = new Map<string, Uint8Array>()
    const retain = (bytes: Uint8Array) => {
      const hash = sha256(bytes)
      artifacts.set(hash, bytes)
      sources.add(hash)
      return hash
    }
    const descriptor = {
      policy,
      imagePlatform: null,
      executionReceiptHash: null,
      inputFileHash: retain(yield* fs.readFile(inputPath)),
      captureFileHash: retain(yield* fs.readFile(capturePath)),
      reportFileHash: retain(reportBytes),
      costsFileHash: retain(new TextEncoder().encode(JSON.stringify(costs))),
    }
    const receipts = yield* Effect.fromResult(
      bindLatencyStressSources([descriptor], registration, cut, artifacts, sources),
    )
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]?.image, null)
    assert.equal(receipts[0]?.executionReceiptHash, null)
    assert.equal(receipts[0]?.economics, null)
    const accounting = yield* Effect.fromResult(
      reproduceReplaySessionEconomics(
        registration,
        Result.getOrThrow(backtestBrokerEvidenceConfig(prepared)),
        report.brokerCheckpoint,
        costs,
        sources,
      ),
    )
    assert.equal(accounting.complete, true)
    assert.equal(accounting.sessions.length, 20)
    if (trading) {
      assert.ok(
        accounting.sessions.every((s) => s.qualificationPnlMicros !== null && BigInt(s.qualificationPnlMicros) > 0n),
      )
    } else assert.ok(accounting.sessions.every((s) => s.qualificationPnlMicros === '-1000000'))
    const { reportHash: _reportHash, ...reportMaterial } = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(new TextDecoder().decode(reportBytes))
    const relabeled = { ...reportMaterial, completion: 'COMPLETE', issues: [] }
    const relabeledHash = retain(
      new TextEncoder().encode(JSON.stringify({ ...relabeled, reportHash: testHash(relabeled) })),
    )
    const relabeledResult = bindLatencyStressSources(
      [{ ...descriptor, reportFileHash: relabeledHash }],
      registration,
      cut,
      artifacts,
      sources,
    )
    assert.equal(Result.isFailure(relabeledResult), !trading)
    if (Result.isFailure(relabeledResult))
      assert.match(String(relabeledResult.failure.cause), /Latency report hides an incomplete registered session/)
    artifacts.set(descriptor.reportFileHash, new TextEncoder().encode('{}'))
    assert.ok(Result.isFailure(bindLatencyStressSources([descriptor], registration, cut, artifacts, sources)))
    yield* fs.writeFileString(
      `${directory}/acceptance.json`,
      JSON.stringify({
        policy,
        trading,
        sessionCount: accounting.sessions.length,
        filledSessions: registration.calendar.sessions.filter((session) =>
          report.brokerCheckpoint.state.ledger.fills.some(
            (fill) => fill.observedAt >= session.openAt && fill.observedAt <= session.closeAt,
          ),
        ).length,
        executionProfitMicros: accounting.sessions
          .reduce((sum, session) => sum + BigInt(session.executionPnlMicros), 0n)
          .toString(),
        qualificationProfitMicros: accounting.sessions
          .reduce((sum, session) => {
            assert.ok(session.qualificationPnlMicros !== null)
            return sum + BigInt(session.qualificationPnlMicros)
          }, 0n)
          .toString(),
        complete: accounting.complete,
        providerDispatchCount: report.inference.providerDispatchCount,
        receiptEconomicsComplete: receipts[0]?.economics !== null,
        executableHash,
      }),
    )
  }).pipe(Effect.provide(PostgresClientLive(databases)))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(main)
