import { Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import { OperatingCostError, type OperatingCostEvidence } from './operating-costs'

export type CostWindowDocument = {
  readonly identity: string
  readonly fingerprint: string
  readonly scope: string
  readonly requiredScopes: readonly string[]
}

export const costWindowConsistent = (documents: readonly CostWindowDocument[]): boolean => {
  const retained = new Map<string, { readonly fingerprint: string; readonly scopes: Set<string> }>()
  for (const document of documents) {
    const previous = retained.get(document.identity)
    if (previous === undefined)
      retained.set(document.identity, { fingerprint: document.fingerprint, scopes: new Set([document.scope]) })
    else {
      if (previous.fingerprint !== document.fingerprint) return false
      previous.scopes.add(document.scope)
    }
  }
  return documents.every((document) =>
    document.requiredScopes.every((scope) => retained.get(document.identity)?.scopes.has(scope) === true),
  )
}

export const validateOperatingCostWindow = (evidence: readonly OperatingCostEvidence[]) =>
  Result.gen(function* () {
    const scopes = new Set(evidence.map((row) => `${row.accountBindingHash}:${row.sessionDate}`))
    const documents: CostWindowDocument[] = []
    for (const row of evidence) {
      const scope = `${row.accountBindingHash}:${row.sessionDate}`
      const observed: { identity: string; material: unknown; requiredScopes: readonly string[] }[] = []
      const document = (provider: string, documentId: string, source: string, role: string) => {
        const identity = JSON.stringify([provider, documentId])
        observed.push(
          { identity: `document:${identity}`, material: { source, role }, requiredScopes: [] },
          { identity: `artifact:${source}`, material: { identity, role }, requiredScopes: [] },
        )
      }
      for (const line of row.consumption) {
        document(line.provider, line.documentId, line.sourceHash, 'consumption')
        const identity = JSON.stringify([line.provider, line.documentId, line.lineId])
        observed.push({
          identity: `line:${identity}`,
          material: {
            ...line,
            credits: line.credits.toSorted((a, b) => a.documentId.localeCompare(b.documentId)),
            allocations: line.allocations.toSorted((a, b) =>
              `${a.accountBindingHash}:${a.sessionDate}`.localeCompare(`${b.accountBindingHash}:${b.sessionDate}`),
            ),
          },
          requiredScopes: line.allocations.flatMap((allocation) => {
            const target = `${allocation.accountBindingHash}:${allocation.sessionDate}`
            return BigInt(allocation.amountMicros) > 0n && scopes.has(target) ? [target] : []
          }),
        })
        for (const credit of line.credits) {
          document(line.provider, credit.documentId, credit.sourceHash, 'credit')
          observed.push({
            identity: `credit:${JSON.stringify([line.provider, credit.documentId])}`,
            material: { ...credit, owner: identity },
            requiredScopes: [],
          })
        }
      }
      for (const funding of row.prepaidFunding) {
        document(funding.provider, funding.documentId, funding.invoiceSourceHash, 'funding')
        const identity = JSON.stringify([funding.provider, funding.documentId])
        observed.push({ identity: `funding:${identity}`, material: funding, requiredScopes: [] })
        if (funding.payment !== null)
          observed.push({
            identity: `artifact:${funding.payment.receiptSourceHash}`,
            material: { identity, role: 'payment' },
            requiredScopes: [],
          })
      }
      for (const item of observed)
        documents.push({
          identity: item.identity,
          fingerprint: yield* canonicalHashV1Result(item.material),
          scope,
          requiredScopes: item.requiredScopes,
        })
    }
    if (!costWindowConsistent(documents))
      return yield* Result.fail(
        new OperatingCostError({
          message:
            'Operating-cost window has conflicting document identities, allocations or omitted allocated expenses',
        }),
      )
  })
