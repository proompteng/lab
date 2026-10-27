import { Schema } from 'effect'
import { OrderSchema, OrderSide, OrderStatus, OrderType, TimeInForce } from '../execution/contracts'
import { MutationEventSchema } from '../execution/mutations/model'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { emptySourceCutFixture } from './source-cut.test-support'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'

export const bracketEvidenceFixture = (document: ExecutionDecisionDocument) => {
  const { cut } = emptySourceCutFixture()
  const template = supportedAssessmentFixture().input.realism.fills[0]
  const target = document.targetPlan.intentTargets[0]
  const risk = document.deltaRisk[0]
  const intentId = document.orderedIntentIds[0]
  const terms = risk?.protection
  if (
    template === undefined ||
    target === undefined ||
    risk === undefined ||
    intentId === undefined ||
    terms?._tag !== 'Bracket'
  )
    throw new Error('Expected a reproduced dispatchable whole-share bracket')
  const at = (offset: number) => new Date(Date.parse(document.createdAt) + offset).toISOString()
  const quantity = BigInt(target.quantityAtoms)
  const profitQuantity = 1000000000n
  if (quantity <= profitQuantity) throw new Error('Bracket fixture needs multiple shares')
  const parent = Schema.decodeUnknownSync(OrderSchema)({
    schemaVersion: 'bayn.order.v3',
    accountId: document.bindings.accountId,
    intentId,
    brokerOrderId: 'native-parent',
    clientOrderId: 'native-parent-client',
    symbol: target.symbol,
    side: OrderSide.Buy,
    orderType: OrderType.Limit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: target.quantityAtoms,
    filledQuantityAtoms: target.quantityAtoms,
    limitPriceMicros: risk.limitPriceMicros,
    status: OrderStatus.Filled,
    observedAt: at(9000),
  })
  const profit = Schema.decodeUnknownSync(OrderSchema)({
    ...parent,
    brokerOrderId: 'native-profit',
    clientOrderId: 'native-profit-client',
    parentBrokerOrderId: parent.brokerOrderId,
    side: OrderSide.Sell,
    limitPriceMicros: terms.profitLimitPriceMicros,
    filledQuantityAtoms: profitQuantity.toString(),
    status: OrderStatus.Canceled,
  })
  const stop = Schema.decodeUnknownSync(OrderSchema)({
    ...parent,
    brokerOrderId: 'native-stop',
    clientOrderId: 'native-stop-client',
    parentBrokerOrderId: parent.brokerOrderId,
    side: OrderSide.Sell,
    orderType: OrderType.StopLimit,
    limitPriceMicros: terms.stopLimitPriceMicros,
    stopPriceMicros: terms.stopPriceMicros,
    quantityAtoms: (quantity - profitQuantity).toString(),
    filledQuantityAtoms: (quantity - profitQuantity).toString(),
  })
  const orders = [parent, profit, stop].map((order, index) => {
    const material = { eventId: testHash({ order: index }), occurredAt: at(8000 + index), order }
    return {
      ...material,
      intentId,
      decisionId: document.contentHash,
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      sourceHash: testHash(material),
    }
  })
  const raw = [
    { order: parent, quantity: profitQuantity, price: risk.limitPriceMicros, offset: 4 },
    { order: parent, quantity: quantity - profitQuantity, price: risk.limitPriceMicros, offset: 5 },
    { order: profit, quantity: profitQuantity, price: terms.profitLimitPriceMicros, offset: 1000 },
    { order: stop, quantity: quantity - profitQuantity, price: terms.stopLimitPriceMicros, offset: 2000 },
  ]
  const fills = raw.map(({ order, quantity, price, offset }) => ({
    fillId: testHash({ fill: offset }),
    intentId,
    decisionId: document.contentHash,
    sourceHash: testHash({ receipt: offset }),
    brokerOrderId: order.brokerOrderId,
    side: order.side,
    quantityAtoms: quantity.toString(),
    priceAtoms: (BigInt(price) * 1000n).toString(),
    occurredAt: at(offset),
  }))
  const supplied = fills.map((fill) => ({
    ...template,
    fillId: fill.fillId,
    intentId,
    orderId: fill.brokerOrderId,
    decisionId: document.contentHash,
    positionOwnerGenerationHash: document.bindings.authorityGenerationHash,
    sourceHash: fill.sourceHash,
    side: fill.side,
    fillQuantityAtoms: fill.quantityAtoms,
    fillPriceAtoms: fill.priceAtoms,
    filledAt: fill.occurredAt,
  }))
  return {
    parent,
    profit,
    stop,
    at,
    terms,
    supplied,
    cut: {
      ...cut,
      asOf: at(10000),
      fills,
      orders,
      decisions: [{ sessionDate: document.executionSession!.executionSession.date, document }],
      mutations: [
        {
          authorityGenerationHash: document.bindings.authorityGenerationHash,
          strategyDecisionHash: document.bindings.strategyDecisionHash,
          event: Schema.decodeUnknownSync(MutationEventSchema)({
            schemaVersion: 'bayn.paper-mutation-event.v1',
            eventId: testHash('bracket outcome'),
            mutationId: testHash('bracket mutation'),
            intentId,
            sequence: 2,
            operation: 'SUBMIT',
            eventType: 'SUBMIT_ACCEPTED',
            requestHash: testHash('bracket request'),
            brokerOrderId: parent.brokerOrderId,
            consistencyDelayMs: 1000,
            occurredAt: at(5),
            routing: { startedAt: at(2), requestDispatchedAt: at(3), completedAt: at(5) },
          }),
        },
      ],
    },
  }
}
