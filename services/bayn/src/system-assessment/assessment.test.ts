import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { evaluateSystemAssessment, EdgeStatus, ProfitabilityStatus, QualificationVerdict } from './assessment'
import { JevNumericalVerdict } from '../jev/acceptance'
import { assessmentFixture, supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { assessSession, exactUsd } from './session'
import { validateSystemRegistration } from './policy'
import { OperatingCostCoverage } from '../operating-costs'

describe('complete system qualification', () => {
  test.each(['4900', '-4900'])(
    'posted settlement rounding %s contributes once to economic profit and the cash bridge',
    (rounding) => {
      const { input, verifiedSources } = supportedAssessmentFixture()
      const definition = input.registration.policies.find((p) => p.policy === 'JEV')
      const original = input.policies.find((p) => p.policy === 'JEV')?.sessions[0]
      if (definition === undefined || original?.financial == null || original.operatingCosts.trading === null)
        throw new Error('Missing economic fixture')
      const sourceHash = testHash({ original: original.financial.sourceHash, rounding })
      verifiedSources.add(sourceHash)
      const adjustment = BigInt(rounding)
      const session = {
        ...original,
        financial: {
          ...original.financial,
          sourceHash,
          cashSettlementRoundingMicros: rounding,
          cashInventory: {
            ...original.financial.cashInventory,
            closingEquityMicros: (BigInt(original.financial.cashInventory.closingEquityMicros) + adjustment).toString(),
          },
        },
        operatingCosts: {
          ...original.operatingCosts,
          trading: {
            ...original.operatingCosts.trading,
            sourceHash,
            netPnlAfterExecutionFeesMicros: (
              BigInt(original.operatingCosts.trading.netPnlAfterExecutionFeesMicros) + adjustment
            ).toString(),
          },
        },
        marks: original.marks.map((mark, index) =>
          index === 0
            ? mark
            : {
                ...mark,
                cashFlowAdjustedTradingEquityMicros: (
                  BigInt(mark.cashFlowAdjustedTradingEquityMicros) + adjustment
                ).toString(),
              },
        ),
      }
      const result = Result.getOrThrow(
        assessSession(session, input.registration, definition, input.asOf, verifiedSources),
      )
      expect(result.netEconomicPnlMicros).toBe((1_000_000_000n + adjustment).toString())
      expect(result.economicEvidenceComplete).toBe(true)
      expect(result.violations).not.toContain('CASH_INVENTORY_MISMATCH')
    },
  )

  test('fully evidenced open inventory does not erase measured profit but still prevents flat-close qualification', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const definition = input.registration.policies.find((p) => p.policy === 'JEV')
    const original = input.policies.find((p) => p.policy === 'JEV')?.sessions[0]
    if (definition === undefined || original?.financial == null) throw new Error('Missing economic fixture')
    const session = {
      ...original,
      financial: { ...original.financial, openingPositionCount: 1, closingPositionCount: 1 },
    }
    const result = Result.getOrThrow(
      assessSession(session, input.registration, definition, input.asOf, verifiedSources),
    )
    expect(result.netEconomicPnlMicros).toBe('1000000000')
    expect(result.economicEvidenceComplete).toBe(true)
    expect(result.missing).toContain('NONFLAT_SESSION')
    expect(result.numerical.status).toBe('UNRESOLVED')
  })

  test('missing inference capture for any policy remains an unknown total and prevents qualification', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    for (const missingPolicy of input.policies) {
      const changed = {
        ...input,
        policies: input.policies.map((policy) =>
          policy.policy !== missingPolicy.policy
            ? policy
            : {
                ...policy,
                sessions: policy.sessions.map((session) => ({ ...session, inferenceEvidence: null })),
              },
        ),
      }
      const result = Result.getOrThrow(evaluateSystemAssessment(changed, verifiedSources))
      expect(result.verdict).toBe(QualificationVerdict.Inconclusive)
      expect(result.edge.status).toBe(EdgeStatus.Undetermined)
      expect(result.evidenceComplete).toBe(false)
      expect(
        result.missing.some(
          (reason) => reason.startsWith(`${missingPolicy.policy}:`) && reason.endsWith('MISSING_INFERENCE_EVIDENCE'),
        ),
      ).toBe(true)
      if (missingPolicy.policy === 'JEV') {
        expect(result.profitability.status).toBe(ProfitabilityStatus.Undetermined)
        expect(result.profitability.netEconomicPnlMicros).toBeNull()
      } else expect(result.profitability.status).toBe(ProfitabilityStatus.Profitable)
    }
  })

  test('verified replacement tariff bytes cannot change the prospectively registered costs', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const changed = {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: [
        {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          currency: 'USD',
          source: 'synthetic changed tariff',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveUntil: '2027-01-01T00:00:00.000Z',
          inputMicrosPerMillionTokens: '1',
          outputMicrosPerMillionTokens: '0',
        },
      ],
    }
    verifiedSources.add(testHash(changed))
    const result = Result.getOrThrow(
      evaluateSystemAssessment(
        {
          ...input,
          policies: input.policies.map((p) => ({
            ...p,
            sessions: p.sessions.map((s) => ({ ...s, inferenceRateCard: changed })),
          })),
        },
        verifiedSources,
      ),
    )
    expect(result.verdict).not.toBe(QualificationVerdict.Qualified)
    expect(result.violations.some((reason) => reason.endsWith('INFERENCE_TARIFF_REGISTRATION_MISMATCH'))).toBe(true)
  })
  test('a complete synthetic evidence set reaches qualification and every removed evidence class prevents it', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const result = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
    expect(result.verdict).toBe(QualificationVerdict.Qualified)
    expect(result.edge.status).toBe(EdgeStatus.Established)
    const incomplete = new Set(verifiedSources)
    incomplete.delete(input.obligationCoverageHash)
    const missing = Result.getOrThrow(evaluateSystemAssessment(input, incomplete))
    expect(missing.verdict).not.toBe(QualificationVerdict.Qualified)
  })
  test('fully attributed sample profit does not establish qualification when execution evidence is absent', () => {
    const { input, verifiedSources } = assessmentFixture()
    const result = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
    expect(result.profitability.status).toBe(ProfitabilityStatus.Profitable)
    expect(result.profitability.netEconomicPnlMicros).toBe('20000000000')
    expect(result.verdict).toBe(QualificationVerdict.Rejected)
    expect(result.violations).toContain('FILL_REALISM_COVERAGE_MISMATCH')
    expect(result.edge.status).toBe(EdgeStatus.Undetermined)
    expect(result.numerical?.verdict).toBe(JevNumericalVerdict.Passed)
  })

  test('unknown expenses remain unknown, while imported complete invoices determine actual economics', () => {
    const { input, verifiedSources } = assessmentFixture()
    const candidate = input.policies[0]
    const definition = input.registration.policies[0]
    const session = candidate?.sessions[0]
    expect(session).toBeDefined()
    expect(definition).toBeDefined()
    if (session === undefined || definition === undefined) throw new Error('Missing test fixture')
    const result = Result.getOrThrow(
      assessSession(session, input.registration, definition, input.asOf, verifiedSources),
    )
    expect(result.netEconomicPnlMicros).toBe('1000000000')
    expect(result.qualificationPnlMicros).toBe('1000000000')
    const missing = Result.getOrThrow(
      assessSession(
        {
          ...session,
          operatingCosts: {
            ...session.operatingCosts,
            coverage: session.operatingCosts.coverage.map((row) => ({
              ...row,
              status: OperatingCostCoverage.Unknown,
              sourceHash: null,
            })),
          },
        },
        input.registration,
        definition,
        input.asOf,
        verifiedSources,
      ),
    )
    expect(missing.netEconomicPnlMicros).toBeNull()
    expect(missing.numerical.status).toBe('UNRESOLVED')
  })

  test('removing a losing or blocked session and resetting an attempt cannot create a valid evaluation', () => {
    const { input, verifiedSources } = assessmentFixture()
    expect(
      Result.isFailure(
        evaluateSystemAssessment(
          { ...input, policies: input.policies.map((p) => ({ ...p, sessions: p.sessions.slice(1) })) },
          verifiedSources,
        ),
      ),
    ).toBe(true)
    expect(Result.isFailure(validateSystemRegistration({ ...input.registration, attemptIndex: 0 }))).toBe(true)
    expect(
      Result.isFailure(
        validateSystemRegistration({
          ...input.registration,
          calendar: { ...input.registration.calendar, operatingHours: '24_7' },
        }),
      ),
    ).toBe(true)
  })

  test('registration is prospective and binds all four definitions and the frozen protocol', () => {
    const { input } = assessmentFixture()
    expect(Result.isSuccess(validateSystemRegistration(input.registration))).toBe(true)
    expect(
      Result.isFailure(validateSystemRegistration({ ...input.registration, registeredAt: '2026-11-02T14:30:00.000Z' })),
    ).toBe(true)
    expect(
      Result.isFailure(validateSystemRegistration({ ...input.registration, acceptanceProtocolHash: 'f'.repeat(64) })),
    ).toBe(true)
    expect(
      Result.isFailure(
        validateSystemRegistration({
          ...input.registration,
          policies: input.registration.policies.map((p) => ({ ...p, policy: 'JEV' })),
        }),
      ),
    ).toBe(true)
  })

  test('native controls cannot register substituted source, protocol, prompt or execution identities', () => {
    const { input } = assessmentFixture()
    for (const control of ['REPEATED_MOMENTUM', 'JEV_ABLATION'] as const)
      for (const field of [
        'strategyHash',
        'parametersHash',
        'protocolHash',
        'promptsHash',
        'executionModelHash',
      ] as const) {
        const registration = {
          ...input.registration,
          policies: input.registration.policies.map((p) =>
            p.policy === control ? { ...p, [field]: 'f'.repeat(64) } : p,
          ),
        }
        expect(Result.isFailure(validateSystemRegistration(registration))).toBe(true)
      }
  })

  test('the frozen estimator rejects inadequate numerical tail resolution', () => {
    const { input, verifiedSources } = assessmentFixture()
    const result = Result.getOrThrow(
      evaluateSystemAssessment(
        { ...input, registration: { ...input.registration, attemptIndex: 100 } },
        verifiedSources,
      ),
    )
    expect(result.verdict).toBe(QualificationVerdict.Rejected)
    expect(result.violations.some((s) => s.includes('tail resolution'))).toBe(true)
  })

  test('mark and cash reconciliation disagreement cannot produce a passing result', () => {
    const { input, verifiedSources } = assessmentFixture()
    const result = Result.getOrThrow(
      evaluateSystemAssessment(
        {
          ...input,
          policies: input.policies.map((p) => ({
            ...p,
            sessions: p.sessions.map((s) => ({
              ...s,
              financial:
                s.financial === null
                  ? null
                  : { ...s.financial, cashInventory: { ...s.financial.cashInventory, netExternalFlowsMicros: '1' } },
            })),
          })),
        },
        verifiedSources,
      ),
    )
    expect(result.profitability.status).toBe(ProfitabilityStatus.Undetermined)
    expect(result.verdict).toBe(QualificationVerdict.Rejected)
  })

  test('microdollar conversions preserve exact inputs and reject loss of precision', () => {
    for (const amount of [0n, 1n, -1n, 1234567n, 100000000000n]) expect(Result.isSuccess(exactUsd(amount))).toBe(true)
    expect(Result.isFailure(exactUsd(999999999999999999n))).toBe(true)
  })
})

test.each([1, 3, 7, 21])(
  'assesses a complete %i-session window and rejects missing trailing evidence',
  (sessionCount) => {
    const { input, verifiedSources } = supportedAssessmentFixture(sessionCount)
    const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
    expect(report.policies.every((policy) => policy.sessions.length === sessionCount)).toBe(true)
    expect(report.profitability.status).toBe(ProfitabilityStatus.Profitable)
    expect(
      Result.isFailure(
        evaluateSystemAssessment(
          {
            ...input,
            policies: input.policies.map((policy, index) =>
              index === 0 ? { ...policy, sessions: policy.sessions.slice(0, -1) } : policy,
            ),
          },
          verifiedSources,
        ),
      ),
    ).toBe(true)
  },
)
