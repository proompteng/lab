import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'
import { conditionalConfidence } from '../../src/system-assessment/conditional-confidence'
import { evaluateEconomicQualification } from '../../src/system-assessment/economic-qualification'
import { assessSession } from '../../src/system-assessment/session'
import {
  knownPayoffAssessmentFixture,
  supportedAssessmentFixture,
  testHash,
} from '../../src/system-assessment/fixtures.test-support'
import { JevResearchPolicy } from '../../src/jev/acceptance'
import { formalModelExecutable, runFormalModel as model } from './model'

const formal = formalModelExecutable === undefined ? describe.skip : describe
const micros = (usd: number) => String(Math.round(usd * 1_000_000))

formal('independent economic evidence evaluation', () => {
  test('recomputes paired bounds, profit and risk before comparing production verdicts', () => {
    const cases = [knownPayoffAssessmentFixture(), supportedAssessmentFixture(7), supportedAssessmentFixture(21)].map(
      ({ input, verifiedSources }) => {
        const registration = input.registration
        if (registration.schemaVersion !== 'bayn.system-registration.v4') throw Error('Expected current registration')
        const policies = input.policies.map((policy) => {
          const definition = registration.policies.find((row) => row.policy === policy.policy)
          if (definition === undefined) throw Error('Missing definition')
          return {
            policy: policy.policy,
            definitionHash: testHash(definition),
            sessions: policy.sessions.map((session) =>
              Result.getOrThrow(assessSession(session, registration, definition, input.asOf, verifiedSources)),
            ),
          }
        })
        return { registration, policies }
      },
    )
    const first = cases[0]
    if (first === undefined) throw Error('Missing fixture')
    for (const fault of ['omitted', 'date', 'profit', 'mark', 'support'] as const) {
      cases.push({
        registration:
          fault === 'support'
            ? {
                ...first.registration,
                statisticalPlan: {
                  ...first.registration.statisticalPlan,
                  supports: first.registration.statisticalPlan.supports.map((row) => ({ ...row, upperMicros: '-1' })),
                },
              }
            : first.registration,
        policies: first.policies.map((policy) => ({
          ...policy,
          sessions:
            fault === 'omitted'
              ? []
              : policy.sessions.map((session) => ({
                  ...session,
                  sessionDate: fault === 'date' ? '2026-12-31' : session.sessionDate,
                  netEconomicPnlMicros: fault === 'profit' ? '-1' : session.netEconomicPnlMicros,
                  numerical:
                    fault === 'mark' && session.numerical.status === 'COMPLETE'
                      ? { ...session.numerical, closingEquityUsd: session.numerical.closingEquityUsd + 1 }
                      : session.numerical,
                })),
        })),
      })
    }
    const duplicate = first.policies[0]
    if (duplicate === undefined) throw Error('Missing duplicate-policy fixture')
    cases.push({ ...first, policies: [...first.policies, duplicate] })
    const actual = model(
      cases.map(({ registration, policies }) => {
        const candidate = registration.policies.find((row) => row.policy === JevResearchPolicy.Candidate)
        if (candidate === undefined) throw Error('Missing candidate')
        return {
          operation: 'economicEvidence',
          dates: registration.calendar.sessions.map((row) => row.sessionDate),
          allocation: registration.allocationMicros,
          lossLimit: candidate.riskPolicy.maxDailyLossMicros,
          drawdownLimit: candidate.riskPolicy.maxDrawdownMicros,
          attempt: String(registration.attemptIndex),
          supports: registration.statisticalPlan.supports,
          policies: policies.map((policy) => ({
            policy: policy.policy,
            sessions: policy.sessions.map((session) => {
              const row = session.numerical
              if (row.status !== 'COMPLETE' || session.netEconomicPnlMicros === null)
                throw Error('Expected complete financial facts')
              return {
                date: session.sessionDate,
                profit: session.netEconomicPnlMicros,
                opening: micros(row.openingEquityUsd),
                closing: micros(row.closingEquityUsd),
                minimum: micros(row.minimumEquityUsd),
                maximum: micros(row.maximumEquityUsd),
                drawdown: micros(row.maximumDrawdownUsd),
              }
            }),
          })),
        }
      }),
    )
    expect(actual).toEqual(
      cases.map(({ registration, policies }) => {
        const result = evaluateEconomicQualification(registration, policies)
        return Result.isFailure(result) || !('checks' in result.success) ? null : result.success.checks
      }),
    )
    expect(actual.slice(3)).toEqual([null, null, null, null, null, null])
  })

  test('binds observations, controls and supports before deriving the attempt error budget', () => {
    const { input } = knownPayoffAssessmentFixture()
    if (input.registration.schemaVersion !== 'bayn.system-registration.v4') throw Error('Expected current registration')
    const base = input.registration.statisticalPlan
    const cases = fc
      .sample(
        fc.record({
          count: fc.integer({ min: 1, max: 30 }),
          attempt: fc.integer({ min: 1, max: 10000 }),
          profit: fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
          width: fc.bigInt({ min: 0n, max: 10n ** 31n }),
        }),
        { seed: 261107, numRuns: 100 },
      )
      .map(({ count, attempt, profit, width }) => ({
        attempt,
        plan: {
          ...base,
          supports: base.supports.map((row, index) => ({
            ...row,
            lowerMicros: String(profit - BigInt(index) - width),
            upperMicros: String(profit - BigInt(index) + width),
          })),
        },
        series: base.supports.map((row, index) => ({
          policy: row.policy,
          netProfitMicros: Array<string>(count).fill(String(profit - BigInt(index))),
        })),
      }))
    const first = cases[0],
      candidate = first?.series[0]
    if (first === undefined || candidate === undefined) throw Error('Missing series fixture')
    cases.push(
      { ...first, attempt: 0 },
      { ...first, series: [] },
      { ...first, series: [...first.series, candidate] },
      { ...first, plan: { ...first.plan, supports: first.plan.supports.slice(1) } },
      {
        ...first,
        series: first.series.map((row, index) => ({ ...row, netProfitMicros: index === 0 ? [] : row.netProfitMicros })),
      },
      {
        ...first,
        series: first.series.map((row, index) => ({
          ...row,
          netProfitMicros: index === 0 ? ['999999999999999999999999999999999999999999999999'] : row.netProfitMicros,
        })),
      },
    )
    const expected = cases.map(({ attempt, plan, series }) => {
      const candidate = series[0]
      if (candidate === undefined) return null
      const result = conditionalConfidence(plan, candidate, series.slice(1), attempt)
      return Result.isFailure(result)
        ? null
        : {
            denominator: result.success.alpha.denominator,
            profit: result.success.profit.lowerSumMicros,
            paired: result.success.paired.map((row) => ({ policy: row.control, lowerSumMicros: row.lowerSumMicros })),
          }
    })
    expect(
      model(
        cases.map(({ attempt, plan, series }) => ({
          operation: 'conditionalSeriesBounds',
          attempt: String(attempt),
          supports: plan.supports,
          series: series.map((row) => ({ policy: row.policy, values: row.netProfitMicros })),
        })),
      ),
    ).toEqual(expected)
    expect(expected.slice(-6)).toEqual([null, null, null, null, null, null])
  })
})
