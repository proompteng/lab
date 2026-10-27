import { beforeAll, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { OrderSide, OrderType, TimeInForce, type Order } from '../execution/contracts'
import type { SystemSourceCut } from './source-cut'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { persistenceDocumentFixture } from './decision-persistence.test-support'
import { bracketEvidenceFixture } from './bracket-evidence.test-support'
import { testHash } from './fixtures.test-support'
import { bindExecutionEvidence, captureExecutionOrders } from './execution-evidence'
import { measureRealism, RealismStatus } from './realism'
import { capturedAccountsFixture } from './source-cut.test-support'
import { bindSystemSourceCut } from './bind-source'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  document = await Effect.runPromise(persistenceDocumentFixture)
})
const fixture = () => bracketEvidenceFixture(document)
const rehash = (row: SystemSourceCut['orders'][number]) => ({
  ...row,
  sourceHash: testHash({ eventId: row.eventId, occurredAt: row.occurredAt, order: row.order }),
})

const realismFor = (
  f: ReturnType<typeof fixture>,
  bound: Result.Result.Success<ReturnType<typeof bindExecutionEvidence>>,
) => {
  return Result.getOrThrow(
    measureRealism(
      {
        expectedDecisionIds: [document.contentHash],
        expectedFillIds: bound.fills.map((fill) => fill.fillId),
        decisions: [
          {
            decisionId: document.contentHash,
            policyDefinitionHash: testHash('bracket policy'),
            authorityGenerationHash: document.bindings.authorityGenerationHash,
            snapshotHash: document.bindings.snapshotContentHash,
            decisionAt: document.createdAt,
            persistedAt: f.at(1),
            inputs: [
              {
                contentHash: document.bindings.snapshotContentHash,
                availableAt: document.bindings.snapshotFinalizedAt,
              },
            ],
          },
        ],
        fills: bound.fills,
        unsupportedAssumptions: bound.missing,
      },
      new Set([...bound.sources, document.bindings.snapshotContentHash]),
    ),
  )
}

test('a native bracket binds parent and protective fills to separate sealed order terms and cumulative quantities', () => {
  const f = fixture()
  const bound = Result.getOrThrow(bindExecutionEvidence(f.supplied, f.cut, document.bindings.authorityGenerationHash))
  expect(document.dispatchable).toBe(true)
  expect(bound.missing).toEqual([])
  expect(bound.fills.map((fill) => fill.orderId)).toEqual([
    'native-parent',
    'native-parent',
    'native-profit',
    'native-stop',
  ])
  expect(bound.fills.map((fill) => fill.cumulativeFilledQuantityAtoms)).toEqual([
    '1000000000',
    f.parent.quantityAtoms!,
    '1000000000',
    f.stop.quantityAtoms!,
  ])
  expect(bound.fills.map((fill) => fill.limitPriceAtoms)).toEqual([
    ...Array(2).fill((BigInt(f.parent.limitPriceMicros!) * 1000n).toString()),
    (BigInt(f.terms.profitLimitPriceMicros) * 1000n).toString(),
    (BigInt(f.terms.stopLimitPriceMicros) * 1000n).toString(),
  ])
  expect(realismFor(f, bound)).toMatchObject({ status: RealismStatus.Supported, violations: [], missing: [] })
})

test('capture retains every broker child under the same owned intent without collapsing orders', () => {
  const f = fixture()
  const captured = Result.getOrThrow(
    captureExecutionOrders(
      f.cut.decisions,
      f.cut.orders.map(({ eventId, occurredAt, order }) => ({ eventId, occurredAt, order })),
      document.bindings.accountId,
      document.bindings.authorityGenerationHash,
    ),
  )
  expect(captured).toEqual(f.cut.orders)
  expect(new Set(captured.map((row) => row.intentId)).size).toBe(1)
  expect(new Set(captured.map((row) => row.order.brokerOrderId)).size).toBe(3)
})

test('the assessment source binder consumes native leg receipts and preserves missing sibling evidence', () => {
  const f = fixture()
  const { input, cut: financialCut, verifiedSources } = capturedAccountsFixture()
  const candidate = input.registration.policies.find((policy) => policy.policy === 'JEV')!
  const definition = { ...candidate, authorityGenerationHash: document.bindings.authorityGenerationHash }
  const registration = {
    ...input.registration,
    policies: input.registration.policies.map((policy) => (policy.policy === 'JEV' ? definition : policy)),
  }
  const cut = {
    ...financialCut,
    registrationHash: testHash(registration),
    decisions: f.cut.decisions,
    mutations: f.cut.mutations,
    fills: f.cut.fills,
    orders: f.cut.orders,
    financial: financialCut.financial.map((account) =>
      account.policy === 'JEV' ? { ...account, definitionHash: testHash(definition) } : account,
    ),
  }
  const supplied = {
    ...input,
    registration,
    registrationReceiptHash: testHash(registration),
    sourceCutHash: testHash(cut),
    realism: {
      ...input.realism,
      fills: f.supplied,
      expectedDecisionIds: [document.contentHash],
      expectedFillIds: f.supplied.map((fill) => fill.fillId),
      decisions: [],
    },
  }
  const actual = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
  expect(actual.input.realism.fills.map((fill) => fill.orderId)).toEqual(f.supplied.map((fill) => fill.orderId))
  expect(actual.input.realism.fills.at(-1)?.limitPriceAtoms).toBe(
    (BigInt(f.terms.stopLimitPriceMicros) * 1000n).toString(),
  )
  expect(f.cut.orders.every((row) => actual.verifiedSources.has(row.sourceHash))).toBe(true)
  const missing = { ...cut, orders: cut.orders.filter((row) => row.order.brokerOrderId !== f.stop.brokerOrderId) }
  const incomplete = Result.getOrThrow(
    bindSystemSourceCut({ ...supplied, sourceCutHash: testHash(missing) }, missing, verifiedSources),
  )
  expect(
    incomplete.input.realism.unsupportedAssumptions.some((reason) => reason.includes('MISSING_NATIVE_PROTECTION_LEGS')),
  ).toBe(true)
})

test('broker-generated protection can resize to a fractional residual after an actual partial profit fill', () => {
  const f = fixture()
  const profit = 500000000n
  const residual = BigInt(f.parent.quantityAtoms!) - profit
  const fills = f.cut.fills.map((fill) => ({
    ...fill,
    quantityAtoms:
      fill.brokerOrderId === f.profit.brokerOrderId
        ? profit.toString()
        : fill.brokerOrderId === f.stop.brokerOrderId
          ? residual.toString()
          : fill.quantityAtoms,
  }))
  const supplied = f.supplied.map((fill) => ({
    ...fill,
    fillQuantityAtoms: fills.find((actual) => actual.fillId === fill.fillId)!.quantityAtoms,
  }))
  const orders = f.cut.orders.map((row) =>
    rehash({
      ...row,
      order:
        row.order.brokerOrderId === f.profit.brokerOrderId
          ? { ...row.order, filledQuantityAtoms: profit.toString() }
          : row.order.brokerOrderId === f.stop.brokerOrderId
            ? { ...row.order, quantityAtoms: residual.toString(), filledQuantityAtoms: residual.toString() }
            : row.order,
    }),
  )
  const bound = Result.getOrThrow(
    bindExecutionEvidence(supplied, { ...f.cut, fills, orders }, document.bindings.authorityGenerationHash),
  )
  expect(bound.missing).toEqual([])
  expect(bound.fills.at(-1)?.requestedQuantityAtoms).toBe(residual.toString())
  expect(realismFor(f, bound)).toMatchObject({ status: RealismStatus.Supported, violations: [], missing: [] })
})

test.each([
  ['stop trigger', 2, { stopPriceMicros: '1' }],
  ['stop limit', 2, { limitPriceMicros: '1' }],
  ['profit limit', 1, { limitPriceMicros: '1' }],
  ['parent quantity', 0, { quantityAtoms: '1000000000' }],
  ['child quantity', 2, { quantityAtoms: '999999999999999999' }],
  ['account', 2, { accountId: 'foreign-account' }],
  ['symbol', 2, { symbol: 'AMZN' }],
  ['intent', 2, { intentId: testHash('foreign-intent') }],
  ['side', 2, { side: OrderSide.Buy }],
  ['duration', 2, { timeInForce: TimeInForce.GoodUntilCanceled }],
  ['type', 2, { orderType: OrderType.Limit }],
  ['nested parent', 2, { parentBrokerOrderId: 'native-profit' }],
  ['duplicate client identity', 2, { clientOrderId: 'native-profit-client' }],
] satisfies readonly (readonly [string, number, Partial<Order>])[])(
  'a valid receipt hash cannot legitimize changed native %s',
  (_name, index, patch) => {
    const f = fixture()
    const orders = f.cut.orders.map((row, i) =>
      rehash(i === index ? { ...row, order: { ...row.order, ...patch } } : row),
    )
    expect(
      Result.isFailure(
        bindExecutionEvidence(f.supplied, { ...f.cut, orders }, document.bindings.authorityGenerationHash),
      ),
    ).toBe(true)
  },
)

test('missing parent, sibling or future observation stays incomplete instead of borrowing parent terms', () => {
  const f = fixture()
  for (const orders of [
    f.cut.orders.filter((row) => row.order.brokerOrderId !== 'native-parent'),
    f.cut.orders.filter((row) => row.order.brokerOrderId !== 'native-stop'),
    f.cut.orders.map((row) => rehash({ ...row, order: { ...row.order, observedAt: f.at(11000) } })),
  ]) {
    const bound = Result.getOrThrow(
      bindExecutionEvidence(f.supplied, { ...f.cut, orders }, document.bindings.authorityGenerationHash),
    )
    expect(bound.missing.length).toBeGreaterThan(0)
  }
})

test('protective disposals cannot consume entry fills that have not occurred or overdraw their shared inventory', () => {
  const f = fixture()
  const stop = f.cut.fills[3]!
  for (const changed of [
    { ...stop, occurredAt: f.at(1) },
    { ...stop, quantityAtoms: (BigInt(stop.quantityAtoms) + 1n).toString() },
  ]) {
    const fills = f.cut.fills.map((fill) => (fill.fillId === stop.fillId ? changed : fill))
    const supplied = f.supplied.map((fill) =>
      fill.fillId === changed.fillId
        ? { ...fill, filledAt: changed.occurredAt, fillQuantityAtoms: changed.quantityAtoms }
        : fill,
    )
    expect(
      Result.isFailure(bindExecutionEvidence(supplied, { ...f.cut, fills }, document.bindings.authorityGenerationHash)),
    ).toBe(true)
  }
})

test('duplicate broker identities, forged receipts and a non-dispatchable decision cannot bind real fills', () => {
  const f = fixture()
  for (const cut of [
    { ...f.cut, orders: [...f.cut.orders, f.cut.orders[0]!] },
    { ...f.cut, orders: f.cut.orders.map((row) => ({ ...row, sourceHash: testHash('forged') })) },
    { ...f.cut, decisions: f.cut.decisions.map((row) => ({ ...row, document: { ...document, dispatchable: false } })) },
  ])
    expect(Result.isFailure(bindExecutionEvidence(f.supplied, cut, document.bindings.authorityGenerationHash))).toBe(
      true,
    )
})
