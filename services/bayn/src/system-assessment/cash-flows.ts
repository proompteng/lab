import { Result, Schema } from 'effect'
import { IsoDateSchema, Sha256Schema, SignedMicrosSchema, UtcInstantSchema } from '../schemas'
import { canonicalHashV1Result } from '../hash'

export enum CashAdjustmentKind {
  External = 'EXTERNAL',
  PassiveYield = 'PASSIVE_CASH_YIELD',
  PaidOperatingCost = 'OPERATING_COST_PAID_FROM_ACCOUNT',
}

export const cashFlowEvidenceAssumptions = [
  'Normalized cash-flow classifications and complete movement coverage are reviewed assertions; hashes do not authenticate the provider or prove that no movements were omitted.',
] as const

export const CashFlowEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.system-cash-flow-evidence.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  coverage: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
  movements: Schema.Array(
    Schema.Struct({
      movementId: Sha256Schema,
      sourceHash: Sha256Schema,
      kind: Schema.Enum(CashAdjustmentKind),
      at: UtcInstantSchema,
      amountMicros: SignedMicrosSchema,
    }),
  ),
})

export const cashFlowsMatchSession = (
  evidence: typeof CashFlowEvidenceSchema.Type,
  scope: {
    readonly accountBindingHash: string
    readonly sessionDate: string
    readonly openAt: string
    readonly closeAt: string
    readonly asOf: string
  },
) =>
  evidence.accountBindingHash === scope.accountBindingHash &&
  evidence.sessionDate === scope.sessionDate &&
  evidence.asOf >= scope.closeAt &&
  evidence.asOf <= scope.asOf &&
  evidence.movements.every((movement) => movement.at > scope.openAt && movement.at <= scope.closeAt)

export const cashFlowTotals = (evidence: typeof CashFlowEvidenceSchema.Type, at: string) => {
  let external = 0n
  let yieldAmount = 0n
  let paidOperating = 0n
  for (const movement of evidence.movements) {
    if (movement.at > at) continue
    const amount = BigInt(movement.amountMicros)
    if (movement.kind === CashAdjustmentKind.External) external += amount
    else if (movement.kind === CashAdjustmentKind.PassiveYield) yieldAmount += amount
    else paidOperating += amount
  }
  return { external, yieldAmount, paidOperating }
}

export const cashFlowsSupported = (evidence: typeof CashFlowEvidenceSchema.Type, verified: ReadonlySet<string>) =>
  Result.gen(function* () {
    const hash = yield* canonicalHashV1Result(evidence)
    return (
      evidence.coverage === 'COMPLETE' &&
      verified.has(hash) &&
      new Set(evidence.movements.map((m) => m.movementId)).size === evidence.movements.length &&
      evidence.movements.every(
        (m) =>
          verified.has(m.sourceHash) &&
          m.at <= evidence.asOf &&
          (m.kind !== CashAdjustmentKind.PaidOperatingCost || BigInt(m.amountMicros) >= 0n),
      )
    )
  })
