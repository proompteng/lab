import { expect, test } from 'bun:test'
import { Effect, Schema } from 'effect'

import { BaynKnowledge, strictKnowledge } from '../../tools/auto-ontology-knowledge'
import { auditReaderGrantedRelations } from './audit-reader-allowlist.test-support'
import { migrationLoader } from './migrations'

const seedJson: unknown = await Bun.file(
  new URL('../../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url),
).json()
const seed = Schema.decodeUnknownSync(BaynKnowledge, strictKnowledge)(seedJson)

test('every public relation referenced by Bayn Auto Ontology analyses is covered by the audit reader grants', () => {
  const migrations = Effect.runSync(migrationLoader)
  expect(migrations.filter(([id]) => id === 226 || id === 227 || id === 230).map(([id, name]) => [id, name])).toEqual([
    [226, 'audit_reader_grants'],
    [227, 'audit_reader_view_grant'],
    [230, 'execution_quality_audit_views'],
  ])

  const referenced = [...new Set(seed.analyses.flatMap(({ referencedTables }) => referencedTables))].toSorted()
  expect(referenced).toContain('public.broker_fee_accounting_evidence')
  expect(referenced).toContain('public.execution_order_churn_daily')
  expect(referenced).toContain('public.execution_fill_slippage_daily')
  const uncovered = referenced.filter((relation) => !auditReaderGrantedRelations.has(relation))
  expect(uncovered).toEqual([])
})
