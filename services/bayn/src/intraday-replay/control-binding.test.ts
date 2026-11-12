import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { AccountStatus, Authority } from '../execution/contracts'
import { sha256 } from '../hash'
import { prepareControlStudy } from './control-study'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { bindControlStudyInput, ControlStudyOpeningSchema } from './control-binding'
import { controlBindingFixture } from './control-binding.test-support'

test('binding inherits native cash and the used drawdown without pricing unknown costs at zero', () => {
  const { plan, opening, exported, source, receipt } = controlBindingFixture()
  const input = Result.getOrThrow(bindControlStudyInput(plan, opening, exported, source, receipt))
  expect(input.backtest.openingCashMicros).toBe(opening.inputs.portfolio.brokerState.account.cashMicros)
  expect(input.openingPeakEquityMicros).toBe(opening.inputs.peakEquityMicros)
  expect(input.riskEnvironment).toBe(BrokerEnvironment.Sandbox)
  expect(input.backtest.allocatedDataCostPerSessionMicros).toBeNull()
  expect(input.backtest.assumptions).toEqual(plan.controlTemplate.backtest.assumptions)
})

test.each(['retained', 'current'] as const)(
  'binding and preparation preserve the exact %s sandbox policy',
  (version) => {
    const { plan, opening, exported, source, receipt } = controlBindingFixture()
    const policy =
      version === 'current'
        ? plan.candidate.riskPolicy
        : {
            ...plan.candidate.riskPolicy,
            schemaVersion: 'bayn.execution-risk-policy.v4' as const,
            maxDailyTradedNotionalMicros: '1000000000000',
          }
    const bound = Result.getOrThrow(
      bindControlStudyInput(
        { ...plan, candidate: { ...plan.candidate, riskPolicy: policy } },
        { ...opening, inputs: { ...opening.inputs, policy } },
        exported,
        source,
        receipt,
      ),
    )
    expect(bound.riskPolicy).toEqual(policy)
    const prepared = Result.getOrThrow(prepareControlStudy(bound, receipt))
    expect(prepared.risk).toEqual({ ...policy, accountId: prepared.prepared.identity.accountId })
    expect(Result.isFailure(prepareControlStudy({ ...bound, riskEnvironment: BrokerEnvironment.Live }, receipt))).toBe(
      true,
    )
    const changedPolicy = { ...policy, maxOrderNotionalMicros: '1' }
    expect(Result.isFailure(prepareControlStudy({ ...bound, riskPolicy: changedPolicy }, receipt))).toBe(true)
    expect(
      Result.isFailure(
        bindControlStudyInput(
          { ...plan, controlTemplate: { ...plan.controlTemplate, riskPolicy: changedPolicy } },
          opening,
          exported,
          source,
          receipt,
        ),
      ),
    ).toBe(true)
  },
)

test.each([
  { recorded: '0', declared: '0', admissible: true },
  { recorded: '1', declared: '0', admissible: false },
  { recorded: '0', declared: '1', admissible: false },
  { recorded: '1', declared: '1', admissible: false },
])(
  'v2 opening turnover preserves recorded $recorded micros against declared $declared',
  ({ recorded, declared, admissible }) => {
    const { plan, opening, exported, source, receipt } = controlBindingFixture()
    const current = {
      ...opening,
      dailyTradedNotionalMicros: declared,
      inputs: {
        ...opening.inputs,
        schemaVersion: 'bayn.account-protection-inputs.v2',
        dailyTradedNotionalMicros: recorded,
      },
    }
    expect(Schema.is(ControlStudyOpeningSchema)(current)).toBeTrue()
    const result = bindControlStudyInput(plan, current, exported, source, receipt)
    expect(Result.isSuccess(result)).toBe(admissible)
    if (Result.isFailure(result)) expect(String(result.failure.cause)).toContain('used daily turnover')
  },
)

test.each([
  ['different physical build', ['opening', 'build', 'sourceRevision'], 'f'.repeat(40)],
  [
    'different account',
    ['opening', 'broker'],
    Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: 'other',
      }),
    ),
  ],
  ['different request', ['opening', 'requestHash'], sha256('other request')],
  ['different authority', ['opening', 'inputs', 'authority', 'generationHash'], sha256('other authority')],
  ['changed risk limits', ['opening', 'inputs', 'policy', 'maxDrawdownMicros'], '20000000000'],
  ['used daily turnover', ['opening', 'dailyTradedNotionalMicros'], '1'],
  ['a researcher-chosen balance', ['plan', 'controlTemplate', 'backtest', 'openingCashMicros'], '100000000000'],
  [
    'a non-session initial cut',
    ['plan', 'controlTemplate', 'backtest', 'interval', 'startAt'],
    '2026-09-04T13:29:00.000Z',
  ],
  ['used daily loss', ['opening', 'inputs', 'dayStartEquityMicros'], '100000000001'],
  ['stale opening', ['opening', 'inputs', 'observedAt'], '2026-09-04T13:24:59.000Z'],
  ['future opening', ['opening', 'inputs', 'observedAt'], '2026-09-04T13:30:00.001Z'],
  ['unverified accounting', ['opening', 'inputs', 'accountingExact'], false],
  ['unresolved mutation', ['opening', 'inputs', 'unknownMutationCount'], 1],
  ['OBSERVE authority', ['opening', 'inputs', 'authority', 'effective'], Authority.Observe],
  ['changed export', ['exported', 'finalChunkHash'], sha256('other chunk')],
  ['forged coverage', ['source', 'coverageEndMs'], Date.parse('2026-09-04T14:00:00Z')],
] as const)('binding rejects %s', (_name, path, value) => {
  const original = controlBindingFixture()
  // Fault injection deliberately crosses the external JSON boundary.
  const x = JSON.parse(JSON.stringify(original))
  expect(Result.isSuccess(bindControlStudyInput(x.plan, x.opening, x.exported, x.source, original.receipt))).toBeTrue()
  let parent = x
  for (const key of path.slice(0, -1)) parent = parent[key]
  const key = path.at(-1)
  if (key === undefined) throw new Error('Fault path is missing')
  parent[key] = value
  expect(Result.isFailure(bindControlStudyInput(x.plan, x.opening, x.exported, x.source, original.receipt))).toBeTrue()
})

const rehashOpeningState = (opening: ReturnType<typeof controlBindingFixture>['opening']) => {
  const state = opening.inputs.portfolio.brokerState
  const digest = Result.getOrThrow(reconciledStateHash(state))
  state.reconciliation = { ...state.reconciliation, expectedHash: digest, observedHash: digest }
  opening.inputs.reconciliation = state.reconciliation
}

test.each(['restricted account', 'restricted buying power'] as const)('exact native state still rejects %s', (kind) => {
  const x = controlBindingFixture()
  const account = x.opening.inputs.portfolio.brokerState.account
  if (kind === 'restricted account') account.status = AccountStatus.Restricted
  else account.buyingPowerMicros = '1'
  rehashOpeningState(x.opening)
  expect(Schema.is(ControlStudyOpeningSchema)(x.opening)).toBeTrue()
  const result = bindControlStudyInput(x.plan, x.opening, x.exported, x.source, x.receipt)
  if (Result.isSuccess(result)) throw new Error('Restricted native capital must not bind')
  expect(String(result.failure.cause)).toContain(
    kind === 'restricted account' ? 'exact native accounting' : 'buying power',
  )
})

test('the first regular open uses the native strict broker-state age boundary', () => {
  for (const expired of [false, true]) {
    const x = controlBindingFixture()
    const inputs = x.opening.inputs
    const at = new Date(
      Date.parse(x.plan.controlTemplate.backtest.interval.startAt) -
        inputs.policy.maxBrokerStateAgeMs +
        (expired ? 0 : 1),
    ).toISOString()
    inputs.observedAt = at
    inputs.authorityObservedAt = at
    inputs.authority.updatedAt = at
    inputs.portfolio.brokerState.account.observedAt = at
    inputs.portfolio.brokerState.positionsObservedAt = at
    inputs.portfolio.brokerState.ordersObservedAt = at
    inputs.portfolio.brokerState.reconciliation.reconciledAt = at
    rehashOpeningState(x.opening)
    expect(Schema.is(ControlStudyOpeningSchema)(x.opening)).toBeTrue()
    const result = bindControlStudyInput(x.plan, x.opening, x.exported, x.source, x.receipt)
    expect(Result.isFailure(result)).toBe(expired)
    if (Result.isFailure(result)) expect(String(result.failure.cause)).toContain('fresh at the first session boundary')
  }
})
