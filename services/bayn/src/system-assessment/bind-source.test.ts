import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { MutationEventSchema } from '../execution/mutations/model'
import { bindSystemSourceCut, mutationObligations } from './bind-source'
import { testHash } from './fixtures.test-support'
import { evaluateSystemAssessment, ProfitabilityStatus, QualificationVerdict } from './assessment'
import { ObligationClass } from './reliability'
import { assessSession } from './session'
import { emptySourceCutFixture as fixture, capturedAccountsFixture } from './source-cut.test-support'
import { CashAdjustmentKind } from './cash-flows'
import { entryEvaluationRequestFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { makeStagedTerminalReceipt } from '../jev/staged-checkpoint'
import { makeJevEvaluationRequest } from '../jev/evidence'
import { makeJevResolution, JevResolutionStatus } from '../jev/resolution'
import { InferenceUsageStatus } from '../inference-costs'
import { costReportFromEvidence } from '../inference-expense.test-support'
import { SystemSourceCutSchema } from './source-cut'

const event = (sequence: number, eventType: string, occurredAt: string) =>
  Schema.decodeUnknownSync(MutationEventSchema)({
    schemaVersion: 'bayn.paper-mutation-event.v1',
    eventId: testHash({ sequence, eventType, occurredAt }),
    mutationId: testHash('mutation'),
    intentId: testHash('intent'),
    sequence,
    operation: 'SUBMIT',
    eventType,
    requestHash: testHash('request'),
    consistencyDelayMs: 1000,
    occurredAt,
  })

describe('immutable source binding', () => {
  test('packet financial claims cannot supply an uncaptured control account', () => {
    const { input, cut, verifiedSources } = fixture()
    const bound = Result.getOrThrow(bindSystemSourceCut(input, cut, verifiedSources))
    const controls = bound.input.policies.filter((policy) => policy.policy !== 'JEV')
    expect(controls).toHaveLength(3)
    expect(controls.every((policy) => policy.sessions.every((session) => session.financial === null))).toBe(true)
    expect(controls.every((policy) => policy.sessions.every((session) => session.inferenceEvidence === null))).toBe(
      true,
    )
    expect(controls.every((policy) => policy.sessions.every((session) => session.marks.length === 0))).toBe(true)
  })

  test('all four policies use their captured financial, inference and account marks', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const exaggerated = {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => ({
          ...session,
          financial:
            session.financial === null ? null : { ...session.financial, grossRealizedPnlMicros: '999999999999' },
          inferenceEvidence: null,
        })),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(exaggerated, cut, verifiedSources))
    for (const policy of bound.input.policies) {
      const captured = cut.financial.find((account) => account.policy === policy.policy)
      const definition = input.registration.policies.find((definition) => definition.policy === policy.policy)
      expect(captured).toBeDefined()
      for (const [index, session] of policy.sessions.entries()) {
        expect(session.financial?.grossRealizedPnlMicros).toBe(captured?.sessions[index]?.facts?.grossRealizedPnlMicros)
        expect(session.marks).toHaveLength(3)
        expect(session.inferenceEvidence).toMatchObject({ accountBindingHash: definition?.accountBindingHash })
        expect(session.operatingCosts.trading?.sourceHash).toBe(session.financial?.sourceHash)
      }
    }
  })

  test('source binding retains claim-only costs and late chart metering in the registered session', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const definition = input.registration.policies.find((policy) => policy.policy === 'JEV')
    const calendar = input.registration.calendar.sessions[0]
    if (definition === undefined || calendar === undefined) throw new Error('Missing checkpoint session')
    const { requestId: _requestId, ...material } = entryEvaluationRequestFixture(calendar.openAt)
    const request = Result.getOrThrow(
      makeJevEvaluationRequest({
        ...material,
        authorityGenerationHash: definition.authorityGenerationHash,
      }),
    )
    const checkpoint = stagedCheckpointFixture(request)
    const claim = checkpoint.claims.find((row) => row.stage === 'CHART')
    const received = checkpoint.terminals.find((row) => row.stage === 'CHART')
    if (claim === undefined || received?.outcome.status !== 'RECEIVED') throw new Error('Missing chart evidence')
    const visual = received.outcome.inference
    const late = Result.getOrThrow(
      makeStagedTerminalReceipt({
        schemaVersion: 'bayn.staged-terminal-receipt.v1',
        stage: 'CHART',
        requestId: request.requestId,
        claimHash: claim.claimHash,
        recordedAt: calendar.closeAt,
        outcome: { status: 'RECEIVED', inference: { ...visual, completedAt: calendar.closeAt } },
      }),
    )
    for (const terminal of [null, late]) {
      const stagedCheckpoint = { claims: [claim], terminals: terminal === null ? [] : [terminal], skips: [] }
      const captured = Schema.decodeUnknownSync(SystemSourceCutSchema)({
        ...cut,
        inference: cut.inference.map((evidence) =>
          evidence.accountBindingHash !== definition.accountBindingHash || evidence.sessionDate !== calendar.sessionDate
            ? evidence
            : {
                ...evidence,
                schemaVersion: 'bayn.inference-cost-evidence.v4',
                requests: [
                  {
                    requestId: request.requestId,
                    cycleId: request.cycleId,
                    authorityGenerationHash: request.authorityGenerationHash,
                    request,
                    receipt: null,
                    handoff: null,
                    resolution: Result.getOrThrow(
                      makeJevResolution(request, null, {
                        schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                        requestId: request.requestId,
                        status: JevResolutionStatus.Abandoned,
                        abandonedAt: request.expiresAt,
                      }),
                    ),
                    stagedCheckpoint,
                  },
                ],
              },
        ),
      })
      const bound = Result.getOrThrow(
        bindSystemSourceCut({ ...input, sourceCutHash: testHash(captured) }, captured, verifiedSources),
      )
      const session = bound.input.policies.find((policy) => policy.policy === 'JEV')?.sessions[0]
      if (session === undefined) throw new Error('Missing bound checkpoint session')
      expect(session.inferenceEvidence).toMatchObject({ requests: [{ stagedCheckpoint }] })
      const report = Result.getOrThrow(costReportFromEvidence(session.inferenceEvidence, session.inferenceRateCard))
      const chart = report.requests.find((line) => 'stage' in line && line.stage === 'CHART')
      expect(chart).toMatchObject({
        stageClaimHash: claim.claimHash,
        stageTerminalHash: terminal?.terminalHash ?? null,
        usageStatus: terminal === null ? InferenceUsageStatus.Unknown : InferenceUsageStatus.Received,
        estimatedCostPicoUsd: null,
      })
      const assessment = Result.getOrThrow(
        assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
      )
      expect(assessment.qualificationPnlMicros).toBeNull()
      expect(assessment.missing).toContain('INCOMPLETE_INFERENCE_USAGE')
      expect(assessment.numerical.status).toBe('UNRESOLVED')
    }
  })

  test('endpoint bid marks derive unrealized PnL from captured basis while open inventory still blocks qualification', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const definition = input.registration.policies.find((p) => p.policy === 'JEV')
    const calendar = input.registration.calendar.sessions[0]
    if (definition === undefined || calendar === undefined) throw new Error('Missing marked fixture')
    const source = {
      ...cut,
      financial: cut.financial.map((account) =>
        account.policy !== 'JEV'
          ? account
          : {
              ...account,
              sessions: account.sessions.map((session, index) =>
                index !== 0 || session.facts === null
                  ? session
                  : { ...session, facts: { ...session.facts, openingPositionCount: 1, closingPositionCount: 1 } },
              ),
            },
      ),
      accountMarks: cut.accountMarks.map((mark) => {
        if (
          mark.accountBindingHash !== definition.accountBindingHash ||
          mark.at < calendar.openAt ||
          mark.at > calendar.closeAt ||
          mark.cashMicros === null
        )
          return mark
        return {
          ...mark,
          cashMicros: (BigInt(mark.cashMicros) - 100_000_000n).toString(),
          valuation: {
            inventorySourceHash: testHash('open inventory basis'),
            positions: [
              {
                symbol: 'AAPL',
                quantityAtoms: '1000000000',
                costBasisMicros: '80000000',
                quoteSourceHash: testHash(mark.at),
                bidPriceMicros: mark.at === calendar.openAt ? '100000000' : '110000000',
              },
            ],
          },
        }
      }),
    }
    const bound = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(source) }, source, verifiedSources),
    )
    const session = bound.input.policies.find((p) => p.policy === 'JEV')?.sessions[0]
    if (session === undefined) throw new Error('Missing bound session')
    expect(session.financial).toMatchObject({
      openingUnrealizedPnlMicros: '20000000',
      closingUnrealizedPnlMicros: '30000000',
      openingPositionCount: 1,
      closingPositionCount: 1,
    })
    const assessment = Result.getOrThrow(
      assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
    )
    expect(assessment.netEconomicPnlMicros).toBe('1010000000')
    expect(assessment.economicEvidenceComplete).toBe(true)
    expect(assessment.missing).toContain('NONFLAT_SESSION')
    expect(assessment.numerical.status).toBe('UNRESOLVED')
    expect(assessment.violations).toEqual([])
  })

  test('all four policies reconstruct session boundary cash from their own retained movements and minute observations', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const financial = cut.financial.map((account) => ({
      ...account,
      cashHistory: {
        sourceHash: testHash({ history: account.policy }),
        completeFrom: input.registration.calendar.sessions[0]?.openAt ?? input.asOf,
        completeThrough: cut.asOf,
        changes: input.registration.calendar.sessions.flatMap((session) => {
          const marks = cut.accountMarks.filter(
            (m) =>
              m.accountBindingHash === account.accountBindingHash && m.at >= session.openAt && m.at <= session.closeAt,
          )
          return marks.slice(1).map((mark, index) => {
            const previous = marks[index]
            if (mark.cashMicros === null || previous?.cashMicros === null || previous === undefined)
              throw new Error('Missing cash fixture')
            return {
              sourceHash: testHash({ movement: mark.sourceHash }),
              earliestAt: mark.at,
              latestAt: mark.at,
              amountMicros: (BigInt(mark.cashMicros) - BigInt(previous.cashMicros)).toString(),
            }
          })
        }),
      },
    }))
    const accountMarks = cut.accountMarks.map((mark) => ({
      ...mark,
      cashMicros: input.registration.calendar.sessions.some((s) => mark.at === s.openAt || mark.at === s.closeAt)
        ? null
        : mark.cashMicros,
    }))
    const source = { ...cut, financial, accountMarks }
    const bound = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(source) }, source, verifiedSources),
    )
    for (const policy of bound.input.policies) {
      const definition = input.registration.policies.find((d) => d.policy === policy.policy)
      if (definition === undefined) throw new Error('Missing policy definition')
      for (const session of policy.sessions) {
        expect(session.financial).not.toBeNull()
        expect(session.marks).toHaveLength(3)
        const assessment = Result.getOrThrow(
          assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
        )
        expect(assessment.economicEvidenceComplete).toBe(true)
        expect(assessment.netEconomicPnlMicros).toBe(policy.policy === 'JEV' ? '1000000000' : '100000000')
      }
    }
  })
  test('captured accounts supply economics without packet financial amounts or their source hashes', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const supplied = {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => {
          if (session.financial !== null) verifiedSources.delete(session.financial.sourceHash)
          return { ...session, financial: null, operatingCosts: { ...session.operatingCosts, trading: null } }
        }),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
    for (const policy of bound.input.policies) {
      const definition = input.registration.policies.find((definition) => definition.policy === policy.policy)
      if (definition === undefined) throw new Error('Missing registered policy')
      for (const session of policy.sessions) {
        expect(session.financial).not.toBeNull()
        const result = Result.getOrThrow(
          assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
        )
        expect(result.economicEvidenceComplete).toBe(true)
        expect(result.netEconomicPnlMicros).toBe(policy.policy === 'JEV' ? '1000000000' : '100000000')
      }
    }
  })

  test('a packet cannot omit a captured intraminute loss or any other session mark', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const definition = input.registration.policies[0]
    const calendar = input.registration.calendar.sessions[0]
    const original = input.policies[0]?.sessions[0]
    if (definition === undefined || calendar === undefined || original === undefined) throw new Error('Missing fixture')
    const at = new Date(Date.parse(calendar.openAt) + 30000).toISOString()
    const sourceHash = testHash('captured intraminute loss')
    const captured = {
      ...cut,
      accountMarks: [
        ...cut.accountMarks,
        {
          accountBindingHash: definition.accountBindingHash,
          sourceHash,
          at,
          availableAt: at,
          cashMicros: '80000000000',
          valuation: { inventorySourceHash: testHash('inventory'), positions: [] },
        },
      ],
    }
    for (const supplied of [
      input.policies,
      input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => ({ ...session, marks: [] })),
      })),
    ]) {
      const bound = Result.getOrThrow(
        bindSystemSourceCut(
          { ...input, policies: supplied, sourceCutHash: testHash(captured) },
          captured,
          verifiedSources,
        ),
      )
      const session = bound.input.policies[0]?.sessions[0]
      if (session === undefined) throw new Error('Missing bound session')
      expect(session.marks).toHaveLength(4)
      expect(session.marks[1]).toEqual({ at, sourceHash, cashFlowAdjustedTradingEquityMicros: '80000000000' })
      const result = Result.getOrThrow(
        assessSession(
          { ...session, p95LatencyStress: original.p95LatencyStress },
          input.registration,
          definition,
          input.asOf,
          bound.verifiedSources,
        ),
      )
      expect(result.numerical.status).toBe('COMPLETE')
      if (result.numerical.status === 'COMPLETE') {
        expect(result.numerical.minimumEquityUsd).toBe(79996.25)
        expect(result.numerical.maximumDrawdownUsd).toBe(20003.75)
      }
      const assessment = Result.getOrThrow(
        evaluateSystemAssessment(
          {
            ...input,
            sourceCutHash: bound.input.sourceCutHash,
            policies: input.policies.map((policy) => ({
              ...policy,
              sessions: policy.sessions.map((value) =>
                value === original ? { ...value, marks: session.marks } : value,
              ),
            })),
          },
          bound.verifiedSources,
        ),
      )
      expect(assessment.verdict).toBe(QualificationVerdict.Rejected)
      expect(assessment.numerical).toMatchObject({ checks: { drawdown: false, sessionLoss: false } })
    }
  })

  test('captured mark ordering is canonical and conflicting simultaneous marks cannot be selected away', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const first = cut.accountMarks[0]
    if (first === undefined) throw new Error('Missing captured mark')
    const reversed = { ...cut, accountMarks: [...cut.accountMarks].reverse() }
    const original = Result.getOrThrow(bindSystemSourceCut(input, cut, verifiedSources))
    const reordered = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(reversed) }, reversed, verifiedSources),
    )
    expect(reordered.input.policies.map((policy) => policy.sessions.map((session) => session.marks))).toEqual(
      original.input.policies.map((policy) => policy.sessions.map((session) => session.marks)),
    )
    const conflict = {
      ...cut,
      accountMarks: [
        ...cut.accountMarks,
        { ...first, sourceHash: testHash('conflicting simultaneous mark'), cashMicros: '80000000000' },
      ],
    }
    const bound = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(conflict) }, conflict, verifiedSources),
    )
    const session = bound.input.policies[0]?.sessions[0]
    const definition = input.registration.policies[0]
    if (session === undefined || definition === undefined) throw new Error('Missing bound session')
    const result = Result.getOrThrow(
      assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
    )
    expect(result.violations).toContain('INVALID_MARK_ORDER')
    expect(result.numerical.status).toBe('UNRESOLVED')
  })

  test('each marked path starts from the registered allocation and retains prior fully costed session results', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const supplied = {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => ({
          ...session,
          marks: session.marks.map((mark) => ({ ...mark, cashFlowAdjustedTradingEquityMicros: '999999999999999' })),
        })),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
    for (const policy of bound.input.policies)
      for (const [index, session] of policy.sessions.entries()) {
        const net = policy.policy === 'JEV' ? 1000000000n : 100000000n
        const opening = 100000000000n + BigInt(index) * net
        expect(session.marks[0]?.cashFlowAdjustedTradingEquityMicros).toBe(opening.toString())
        expect(session.marks.at(-1)?.cashFlowAdjustedTradingEquityMicros).toBe((opening + net + 15000000n).toString())
      }
  })

  test('an unknown earlier session cannot be hidden by restarting the next marked equity path', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const original = input.policies[0]?.sessions[0]
    const supplied = {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => (session === original ? { ...session, cashFlows: null } : session)),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
    const sessions = bound.input.policies[0]?.sessions
    if (sessions === undefined) throw new Error('Missing bound sessions')
    expect(sessions.every((session) => session.marks.length === 0)).toBe(true)
    expect(sessions.slice(1).every((session) => session.financial !== null)).toBe(true)
  })

  test('a captured loss lowers every subsequent session baseline after operating costs', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const first = input.registration.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing calendar')
    const captured = {
      ...cut,
      financial: cut.financial.map((account) => ({
        ...account,
        sessions: account.sessions.map((session, index) => ({
          ...session,
          facts:
            index === 0 && session.facts !== null
              ? { ...session.facts, grossRealizedPnlMicros: '-100000000' }
              : session.facts,
        })),
      })),
      accountMarks: cut.accountMarks.map((mark) =>
        mark.at > first.openAt && mark.at <= first.closeAt ? { ...mark, cashMicros: '99895000000' } : mark,
      ),
    }
    const bound = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(captured) }, captured, verifiedSources),
    )
    for (const policy of bound.input.policies) {
      expect(policy.sessions[1]?.marks[0]?.cashFlowAdjustedTradingEquityMicros).toBe('99880000000')
      const net = policy.policy === 'JEV' ? 1000000000n : 100000000n
      expect(policy.sessions[19]?.marks[0]?.cashFlowAdjustedTradingEquityMicros).toBe(
        (99880000000n + 18n * net).toString(),
      )
    }
  })

  test('cash bridge derives funding, passive yield and paid expenses from retained movements exactly once', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const policy = input.policies[0]
    const session = policy?.sessions[0]
    const calendar = input.registration.calendar.sessions[0]
    const definition = input.registration.policies.find((definition) => definition.policy === policy?.policy)
    if (
      session?.cashFlows === null ||
      session?.cashFlows === undefined ||
      calendar === undefined ||
      definition === undefined
    )
      throw new Error('Missing cash-flow fixture')
    const at = new Date(Date.parse(calendar.openAt) + 30_000).toISOString()
    const movements = [
      { kind: CashAdjustmentKind.External, amountMicros: '1000000' },
      { kind: CashAdjustmentKind.PassiveYield, amountMicros: '5000' },
      { kind: CashAdjustmentKind.PaidOperatingCost, amountMicros: '20000' },
    ].map((movement) => ({
      ...movement,
      movementId: testHash({ movement: movement.kind }),
      sourceHash: testHash({ receipt: movement.kind }),
      at,
    }))
    const cashFlows = { ...session.cashFlows, movements }
    verifiedSources.add(testHash(cashFlows))
    for (const movement of movements) verifiedSources.add(movement.sourceHash)
    const captured = {
      ...cut,
      accountMarks: cut.accountMarks.map((mark) =>
        mark.cashMicros !== null &&
        mark.accountBindingHash === definition.accountBindingHash &&
        mark.at >= at &&
        mark.at <= calendar.closeAt
          ? { ...mark, cashMicros: (BigInt(mark.cashMicros) + 985000n).toString() }
          : mark,
      ),
    }
    const supplied = {
      ...input,
      sourceCutHash: testHash(captured),
      policies: input.policies.map((entry) => ({
        ...entry,
        sessions: entry.sessions.map((value) => (value === session ? { ...value, cashFlows } : value)),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(supplied, captured, verifiedSources))
    const actual = bound.input.policies[0]?.sessions[0]
    if (actual === undefined) throw new Error('Missing bound session')
    expect(actual.financial?.cashInventory).toEqual({
      openingEquityMicros: '100000000000',
      closingEquityMicros: '101015985000',
      netExternalFlowsMicros: '1000000',
      passiveCashYieldMicros: '5000',
      operatingCostsPaidFromAccountMicros: '20000',
    })
    const result = Result.getOrThrow(
      assessSession(actual, input.registration, definition, input.asOf, bound.verifiedSources),
    )
    expect(result.economicEvidenceComplete).toBe(true)
    expect(result.netEconomicPnlMicros).toBe('1000000000')
    expect(result.qualificationPnlMicros).toBe('1000000000')
  })

  test('unverified, missing and foreign cash-flow evidence cannot supply a financial bridge', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const original = input.policies[0]?.sessions[0]
    if (original?.cashFlows === undefined || original.cashFlows === null) throw new Error('Missing cash-flow fixture')
    for (const cashFlows of [
      null,
      { ...original.cashFlows, coverage: 'INCOMPLETE' },
      { ...original.cashFlows, accountBindingHash: testHash('foreign account') },
      { ...original.cashFlows, sessionDate: '2026-11-03' },
      { ...original.cashFlows, asOf: '2026-11-02T14:30:00.000Z' },
      { ...original.cashFlows, asOf: '2027-01-01T00:00:00.000Z' },
    ]) {
      if (cashFlows !== null) verifiedSources.add(testHash(cashFlows))
      const supplied = {
        ...input,
        policies: input.policies.map((policy) => ({
          ...policy,
          sessions: policy.sessions.map((session) => (session === original ? { ...session, cashFlows } : session)),
        })),
      }
      const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
      expect(bound.input.policies[0]?.sessions[0]?.financial).toBeNull()
      expect(bound.input.policies[0]?.sessions[0]?.operatingCosts.trading).toBeNull()
    }
    verifiedSources.delete(testHash(original.cashFlows))
    const bound = Result.getOrThrow(bindSystemSourceCut(input, cut, verifiedSources))
    expect(bound.input.policies[0]?.sessions[0]?.financial).toBeNull()
  })

  test('a control cannot borrow candidate marks or inference even at the same timestamp', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const candidate = input.registration.policies.find((definition) => definition.policy === 'JEV')
    const selected = {
      ...cut,
      accountMarks: cut.accountMarks.filter((mark) => mark.accountBindingHash === candidate?.accountBindingHash),
      inference: cut.inference.filter((record) => record.accountBindingHash === candidate?.accountBindingHash),
    }
    const bound = Result.getOrThrow(
      bindSystemSourceCut({ ...input, sourceCutHash: testHash(selected) }, selected, verifiedSources),
    )
    for (const policy of bound.input.policies.filter((policy) => policy.policy !== 'JEV'))
      for (const session of policy.sessions) {
        expect(session.financial).toBeNull()
        expect(session.marks).toEqual([])
        expect(session.inferenceEvidence).toBeNull()
      }
  })

  test('captured accounts cannot change policy identity, repeat a policy or substitute its calendar', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const first = cut.financial[0]
    if (first === undefined) throw new Error('Missing captured account')
    for (const financial of [
      [first, first],
      [{ ...first, accountBindingHash: testHash('foreign account') }],
      [{ ...first, definitionHash: testHash('retuned policy') }],
      [{ ...first, sessions: first.sessions.slice(1) }],
      [{ ...first, sessions: [...first.sessions].reverse() }],
    ]) {
      const changed = { ...cut, financial }
      expect(
        Result.isFailure(bindSystemSourceCut({ ...input, sourceCutHash: testHash(changed) }, changed, verifiedSources)),
      ).toBe(true)
    }
  })

  test('a repeated receipt with conflicting retained contents cannot supply decision work', () => {
    const { input, cut, verifiedSources } = fixture()
    const pass = {
      controllerKey: testHash('controller'),
      planHash: testHash('plan'),
      epoch: 1,
      sequence: 1,
      receiptHash: testHash('receipt'),
      completedAt: '2026-11-02T14:31:02.000Z',
      observation: {
        result: 'SUCCESS' as const,
        outcome: 'WINDOW_CLOSED' as const,
        observedAt: '2026-11-02T14:31:02.000Z',
      },
    }
    const conflicting = {
      ...cut,
      controllerPasses: [
        pass,
        {
          ...pass,
          observation: { ...pass.observation, outcome: 'ALREADY_ACQUIRED' as const },
        },
      ],
    }
    const result = bindSystemSourceCut({ ...input, sourceCutHash: testHash(conflicting) }, conflicting, verifiedSources)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ message: 'Controller receipt has conflicting retained contents' })
  })
  test('a supplied profitable candidate and perfect reliability cannot replace absent database facts', () => {
    const { input, cut, verifiedSources } = fixture()
    const bound = Result.getOrThrow(bindSystemSourceCut(input, cut, verifiedSources))
    expect(bound.input.policies.find((p) => p.policy === 'JEV')?.sessions.every((s) => s.financial === null)).toBe(true)
    expect(bound.input.reliability.completions).toEqual([])
    expect(bound.input.policies.every((p) => p.sessions.every((s) => s.p95LatencyStress === null))).toBe(true)
    const result = Result.getOrThrow(evaluateSystemAssessment(bound.input, bound.verifiedSources))
    expect(result.profitability.status).toBe(ProfitabilityStatus.Undetermined)
    expect(result.verdict).not.toBe('QUALIFIED_PAPER')
  })

  test('replay image membership retains the separate missing runner authentication obligation', () => {
    const { input, cut, verifiedSources } = fixture()
    const policy = input.policies[0]
    const session = policy?.sessions[0]
    const image = session?.p95LatencyStress?.image
    if (image === undefined || policy === undefined) throw new Error('Missing image fixture')
    for (const membership of [null, image]) {
      const material = {
        policy: policy.policy,
        protocolHash: input.registration.latencyStressProtocolHash,
        reportFileHash: testHash('report file'),
        reportHash: testHash('report'),
        costsFileHash: testHash('costs file'),
        registrationHash: cut.registrationHash,
        sourceCutHash: input.sourceCutHash,
        image: membership,
        economics: null,
        executionReceiptHash: null,
      }
      const bound = Result.getOrThrow(
        bindSystemSourceCut(
          input,
          cut,
          verifiedSources,
          [],
          [
            {
              ...material,
              sourceHash: testHash(material),
            },
          ],
        ),
      )
      expect(bound.input.realism.unsupportedAssumptions).toContain(
        `${membership === null ? 'MISSING_REPLAY_IMAGE_MEMBERSHIP' : 'UNAUTHENTICATED_REPLAY_RUNNER'}:${material.reportHash}`,
      )
      expect(bound.input.policies.every((p) => p.sessions.every((s) => s.p95LatencyStress === null))).toBe(true)
    }
  })

  test('the source cut cannot be reused for a different attempt, as-of, or content hash', () => {
    const { input, cut, verifiedSources } = fixture()
    for (const change of [
      { asOf: '2026-11-29T00:00:00.000Z' },
      { sourceCutHash: testHash('other') },
      { registration: { ...input.registration, attemptIndex: 2 } },
    ]) {
      expect(Result.isFailure(bindSystemSourceCut({ ...input, ...change }, cut, verifiedSources))).toBe(true)
    }
  })

  test('a process crash after submission starts creates a recovery obligation without inventing an outcome', () => {
    const { input, cut } = fixture()
    const start = '2026-11-02T14:30:00.000Z'
    const mutations = [
      {
        authorityGenerationHash: testHash('generation'),
        strategyDecisionHash: testHash('strategy-decision'),
        event: event(1, 'SUBMIT_STARTED', start),
      },
    ]
    const obligations = Result.getOrThrow(mutationObligations({ ...cut, mutations }, input.registration))
    expect(obligations.map((o) => o.class)).toEqual([ObligationClass.Mutation, ObligationClass.Recovery])
    expect(obligations[1]?.dueAt).toBe(obligations[0]?.deadlineAt)
  })

  test('repeated uncertainty cannot restart the recovery clock or erase the admitted mutation', () => {
    const { input, cut } = fixture()
    const mutations = [
      event(1, 'SUBMIT_STARTED', '2026-11-02T14:30:00.000Z'),
      event(2, 'SUBMIT_UNKNOWN', '2026-11-02T14:30:00.100Z'),
      event(3, 'RECOVERY_UNKNOWN', '2026-11-02T14:30:20.000Z'),
    ].map((event) => ({
      authorityGenerationHash: testHash('generation'),
      strategyDecisionHash: testHash('strategy-decision'),
      event,
    }))
    const obligations = Result.getOrThrow(mutationObligations({ ...cut, mutations }, input.registration))
    expect(obligations).toHaveLength(2)
    expect(obligations[1]?.dueAt).toBe('2026-11-02T14:30:00.100Z')
  })

  test('a crash followed directly by recovery still contributes to the recovery denominator', () => {
    const { input, cut } = fixture()
    const mutations = [
      event(1, 'SUBMIT_STARTED', '2026-11-02T14:30:00.000Z'),
      event(2, 'RECOVERY_FOUND', '2026-11-02T14:30:02.000Z'),
    ].map((event) => ({
      authorityGenerationHash: testHash('generation'),
      strategyDecisionHash: testHash('strategy-decision'),
      event,
    }))
    const obligations = Result.getOrThrow(mutationObligations({ ...cut, mutations }, input.registration))
    expect(obligations).toHaveLength(2)
    expect(obligations[1]?.dueAt).toBe('2026-11-02T14:30:01.000Z')
  })
})
