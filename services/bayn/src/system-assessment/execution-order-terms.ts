import { Result } from 'effect'
import { resolveNativeOrderTerms } from '../execution/native-order-evidence'
import type { ExecutionOrderPlan } from './execution-plans'
import { SystemAssessmentError } from './economics'
import type { SystemSourceCut } from './source-cut'

type Receipt = SystemSourceCut['orders'][number]

export const nativeOrderEvidenceAssumptions = [
  'Broker order and fill observations are authentic and retain provider timestamps and atomic units.',
  'Broker-generated child identities come from the nested protection response checked against the immutable parent intent at ingestion.',
  'Retained protection intents, approved risk decisions and reconciliations are authentic records from the registered account and authority generation; their hashes identify content rather than authenticate approval.',
  'Native protection and reconciled liquidation pricing are supported only by actual broker receipts and their retained conditional order or forced-close authority.',
] as const

export const resolveExecutionOrderTerms = (
  brokerOrderId: string,
  root: Receipt,
  children: readonly Receipt[],
  plan: ExecutionOrderPlan,
) => {
  if (
    [root, ...children].some(
      (row) =>
        row.intentId !== plan.intentId ||
        row.decisionId !== plan.decisionId ||
        row.authorityGenerationHash !== plan.document.bindings.authorityGenerationHash,
    )
  )
    return Result.fail(
      new SystemAssessmentError({ message: 'Broker order differs from its sealed target or ownership' }),
    )
  return resolveNativeOrderTerms(
    brokerOrderId,
    root.order,
    children.map((row) => row.order),
    {
      intentId: plan.intentId,
      accountId: plan.document.bindings.accountId,
      target: plan.target,
      risk: plan.risk,
    },
  ).pipe(Result.mapError((message) => new SystemAssessmentError({ message })))
}
