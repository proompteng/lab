import { Schema } from 'effect'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { Authority, KillState } from '../execution/contracts'
import { BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Result } from 'effect'
import { emptySourceCutFixture } from './source-cut.test-support'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { testHash } from './fixtures.test-support'
import { OperationalSafetySourceSchema } from './operational-safety-source'
import { SystemSourceCutSchema } from './source-cut'

export const nativeSafetyFixture = () => {
  const registration = operationalRegistrationFixture()
  const definition = registration.policies[0]
  const close = registration.calendar.sessions.at(-1)?.closeAt
  if (close === undefined || definition.capitalAuthorization === undefined)
    throw new Error('Missing native registration')
  const asOf = new Date(Date.parse(close) + 120000).toISOString()
  const authority = {
    singleton: true,
    schema_version: 'bayn.paper-authority.v1',
    generation_hash: definition.authorityGenerationHash,
    maximum: Authority.Execution,
    effective: Authority.Execution,
    kill_state: KillState.Clear,
    reason: null,
    version: 1,
    updated_at: registration.registeredAt,
  }
  const safety = Schema.decodeUnknownSync(OperationalSafetySourceSchema)({
    schemaVersion: 'bayn.operational-safety-source.v1',
    accountId: definition.riskPolicy.accountId,
    asOf,
    baseline: { capturedAt: registration.registeredAt, authority },
    authority,
    authorityTransitions: [],
    admissions: [],
    bindings: [],
    orders: [],
    fills: [],
    intents: [],
    broker: { status: 'AVAILABLE', snapshot: observedBrokerSnapshotFixture(definition.riskPolicy.accountId, asOf) },
  })
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: definition.capitalAuthorization.request.broker.environment,
      accountId: definition.riskPolicy.accountId,
    }),
  )
  const accounts = [
    {
      policy: definition.policy,
      identity,
      forward: {
        accountingReceiptsExact: true,
        ledgerExact: true,
        missingLedgerAccountCount: 0,
        unresolvedMutationCount: 0,
        accountTransactions: [],
        accountCashSettlements: [],
        accountPositionCounts: { reconciledAt: asOf, exact: true },
      },
    },
  ]
  const sourceMaterial = { safety, accounts, mutations: [] }
  const { cut: base } = emptySourceCutFixture()
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    ...base,
    registrationHash: testHash(registration),
    asOf,
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    sourceMaterial,
    sourceMaterialHash: testHash(sourceMaterial),
    financial: [
      {
        policy: definition.policy,
        sourceHash: testHash(accounts),
        accountBindingHash: definition.accountBindingHash,
        definitionHash: testHash(definition),
        cashHistory: null,
        sessions: registration.calendar.sessions.map((session) => ({
          sessionDate: session.sessionDate,
          evidenceHash: testHash(session),
          facts: null,
        })),
      },
    ],
  })
  const input = { schemaVersion: 'bayn.operational-assessment-input.v3', registration, sourceCutHash: testHash(cut) }
  const verifiedSources = new Set([registration.calendar.sourceHash, ...registration.retainedIncidentSources])
  return { registration, definition, authority, sourceMaterial, safety, cut, input, verifiedSources }
}
