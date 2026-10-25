import { fail, roundDiv, type ExecutionResult } from './fixed-point'

export const saleCostBasisMicros = (
  positionCostBasisMicros: bigint,
  soldQuantityAtoms: bigint,
  positionQuantityAtoms: bigint,
): ExecutionResult<bigint> => {
  if (positionCostBasisMicros < 0n || soldQuantityAtoms < 0n || positionQuantityAtoms <= 0n) {
    return fail({
      _tag: 'InvalidSaleCostBasis',
      positionCostBasisMicros,
      soldQuantityAtoms,
      positionQuantityAtoms,
      reason: 'invalid-position',
    })
  }
  if (soldQuantityAtoms > positionQuantityAtoms) {
    return fail({
      _tag: 'InvalidSaleCostBasis',
      positionCostBasisMicros,
      soldQuantityAtoms,
      positionQuantityAtoms,
      reason: 'quantity-exceeds-position',
    })
  }
  return roundDiv(positionCostBasisMicros * soldQuantityAtoms, positionQuantityAtoms)
}
