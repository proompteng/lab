import { Schema } from 'effect'

import { OrderSide, OrderStatus, OrderType, type Intent, type Order, type Position } from './contracts'
import {
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
} from '../schemas'

export const ProtectionCloseBasisSchema = Schema.Struct({
  proofId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  reconciliationId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  protectionIntentId: Sha256Schema,
  symbol: SymbolSchema,
  signedQuantityAtoms: SignedMicrosSchema.check(Schema.makeFilter((quantity) => quantity !== '0')),
  checkedAt: UtcInstantSchema,
  releasedOrderIds: Schema.Array(StrictNonEmptyStringSchema).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(3),
    Schema.makeFilter((ids) => ids.every((id, index) => index === 0 || id > (ids[index - 1] ?? ''))),
  ),
})
export type ProtectionCloseBasis = typeof ProtectionCloseBasisSchema.Type

interface ProtectionCloseBook {
  readonly account: { readonly accountId: string }
  readonly reconciliation: { readonly reconciliationId: string; readonly reconciledAt: string }
  readonly positions: readonly Pick<Position, 'symbol' | 'quantityAtoms' | 'accountId'>[]
  readonly orders: readonly Pick<Order, 'brokerOrderId' | 'intentId' | 'accountId' | 'symbol' | 'status'>[]
}

const isWorking = (status: OrderStatus) =>
  status === OrderStatus.New || status === OrderStatus.Pending || status === OrderStatus.PartiallyFilled

/** Keep the original exact book intact. Only the matching native protection group can be treated as settled. */
export const matchesProtectionCloseBook = (
  basis: ProtectionCloseBasis,
  book: ProtectionCloseBook,
  cycleId: string,
  observedAt: string,
  maximumAgeMs: number,
): boolean => {
  const [position] = book.positions
  const group = book.orders.filter(({ intentId }) => intentId === basis.protectionIntentId)
  const age = Date.parse(observedAt) - Date.parse(basis.checkedAt)
  return (
    basis.cycleId === cycleId &&
    basis.accountId === book.account.accountId &&
    basis.reconciliationId === book.reconciliation.reconciliationId &&
    basis.checkedAt >= book.reconciliation.reconciledAt &&
    age >= 0 &&
    age < maximumAgeMs &&
    book.positions.length === 1 &&
    position?.accountId === basis.accountId &&
    position.symbol === basis.symbol &&
    position.quantityAtoms === basis.signedQuantityAtoms &&
    group.length === basis.releasedOrderIds.length &&
    group.every(
      (order) =>
        order.accountId === basis.accountId &&
        order.symbol === basis.symbol &&
        basis.releasedOrderIds.includes(order.brokerOrderId),
    ) &&
    group.some(({ status }) => isWorking(status)) &&
    book.orders.every((order) => order.intentId === basis.protectionIntentId || !isWorking(order.status))
  )
}

export const protectionCloseReducesPosition = (
  basis: ProtectionCloseBasis,
  intent: Pick<
    Intent,
    | 'accountId'
    | 'cycleId'
    | 'authorityGenerationHash'
    | 'symbol'
    | 'side'
    | 'quantityAtoms'
    | 'orderType'
    | 'protection'
  >,
): boolean => {
  const inventory = BigInt(basis.signedQuantityAtoms)
  const quantity = BigInt(intent.quantityAtoms)
  return (
    intent.accountId === basis.accountId &&
    intent.cycleId === basis.cycleId &&
    intent.authorityGenerationHash === basis.authorityGenerationHash &&
    intent.symbol === basis.symbol &&
    intent.orderType === OrderType.Limit &&
    intent.protection === undefined &&
    quantity > 0n &&
    (inventory > 0n
      ? intent.side === OrderSide.Sell && quantity <= inventory
      : intent.side === OrderSide.Buy && quantity <= -inventory)
  )
}
