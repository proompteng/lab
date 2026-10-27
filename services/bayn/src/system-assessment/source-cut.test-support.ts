import { Schema } from 'effect'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { SystemSourceCutSchema } from './source-cut'
import { CapturedTradingFactsSchema } from './session'

export const emptySourceCutFixture = () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const candidate = input.registration.policies.find((p) => p.policy === 'JEV')
  const policy = input.policies.find((p) => p.policy === 'JEV')
  if (candidate === undefined || policy === undefined) throw new Error('Missing candidate fixture')
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    schemaVersion: 'bayn.system-source-cut.v2',
    registrationHash: testHash(input.registration),
    asOf: input.asOf,
    runtimeConfigurationHash: input.registration.obligations.runtimeConfigurationHash,
    financial: [
      {
        policy: 'JEV',
        sourceHash: testHash('captured financial'),
        accountBindingHash: candidate.accountBindingHash,
        definitionHash: testHash(candidate),
        cashHistory: null,
        sessions: policy.sessions.map((s) => ({ sessionDate: s.sessionDate, evidenceHash: testHash(s), facts: null })),
      },
    ],
    inference: policy.sessions.map((s) => s.inferenceEvidence),
    inferenceLedgerEvidenceHash: testHash('inference ledger'),
    decisions: [],
    batches: [],
    mutations: [],
    fills: [],
    accountMarks: [],
    controllerPasses: [],
    durableObservations: [],
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  })
  return { input: { ...input, sourceCutHash: testHash(cut) }, cut, verifiedSources }
}

export const capturedAccountsFixture = () => {
  const { input, cut, verifiedSources } = emptySourceCutFixture()
  const financial = input.registration.policies.map((definition) => {
    const policy = input.policies.find((policy) => policy.policy === definition.policy)
    if (policy === undefined) throw new Error('Missing policy fixture')
    return {
      policy: definition.policy,
      sourceHash: testHash({ captured: definition.policy }),
      accountBindingHash: definition.accountBindingHash,
      definitionHash: testHash(definition),
      cashHistory: null,
      sessions: policy.sessions.map((session) => ({
        sessionDate: session.sessionDate,
        evidenceHash: testHash(session),
        facts: Schema.decodeUnknownSync(CapturedTradingFactsSchema)(session.financial),
      })),
    }
  })
  const accountMarks = input.policies.flatMap((policy) => {
    const definition = input.registration.policies.find((definition) => definition.policy === policy.policy)
    if (definition === undefined) throw new Error('Missing policy definition')
    return policy.sessions.flatMap((session) =>
      session.marks.map((mark) => ({
        accountBindingHash: definition.accountBindingHash,
        sourceHash: mark.sourceHash,
        at: mark.at,
        availableAt: mark.at,
        cashMicros: mark.cashFlowAdjustedTradingEquityMicros,
        valuation: { inventorySourceHash: testHash('inventory'), positions: [] },
      })),
    )
  })
  const captured = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    ...cut,
    financial,
    accountMarks,
    inference: input.policies.flatMap((policy) => policy.sessions.map((session) => session.inferenceEvidence)),
  })
  return { input: { ...input, sourceCutHash: testHash(captured) }, cut: captured, verifiedSources }
}
