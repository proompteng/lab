import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { BaynKnowledge, KnowledgeDelta, knowledgeDeltaJsonSchema, strictKnowledge } from './auto-ontology-knowledge'
import {
  AcronymRow,
  AnalysisRow,
  type Catalog,
  parseMode,
  planUpserts,
  prepareAnalysis,
  prepareKnowledge,
  RuleRow,
  SyncMode,
  verifyReferences,
} from './sync-auto-ontology-core'

const seedJson: unknown = await Bun.file(
  new URL('../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url),
).json()
const deltaJsonSchema: unknown = await Bun.file(
  new URL('../../../docs/bayn/ontology/knowledge-delta.schema.json', import.meta.url),
).json()
const decodeSeed = Schema.decodeUnknownResult(BaynKnowledge, strictKnowledge)
const seed = Result.getOrThrow(decodeSeed(seedJson))
const excerpt = {
  ...seed,
  acronyms: [seed.acronyms[0]],
  rules: [seed.rules[0]],
  analyses: [seed.analyses[0]],
} satisfies BaynKnowledge
const empty: Catalog = { schemaId: 'bayn-public', ruleTagId: 'canonical', acronyms: [], rules: [], analyses: [] }

test('defaults to offline dry-run and rejects unknown arguments', () => {
  expect(Result.getOrThrow(parseMode([]))).toBe(SyncMode.DryRun)
  expect(Result.getOrThrow(parseMode(['--mode', 'apply']))).toBe(SyncMode.Apply)
  expect(Result.isFailure(parseMode(['--mode', 'update']))).toBe(true)
  expect(Result.isFailure(parseMode(['--mode', 'apply', '--mode', 'dry-run']))).toBe(true)
})

test('the checked-in seed decodes strictly and every analysis uses the shared binding contract', () => {
  expect(Result.getOrThrow(prepareKnowledge(seed))).toHaveLength(8)
  expect(seed.acronyms.map(({ name }) => name)).toEqual([
    'B0',
    'F4',
    'F2',
    'O1',
    'OCO',
    'SIP',
    'IEX',
    'PDT',
    'DSR',
    'RTH',
    'ATR14',
    'VWAP',
    'MOO',
    'MOC',
    'CNPG',
    'OrderChurn',
    'ExecutionSlippage',
    'FillFeeDrag',
    'Bayn',
    'Dorvud',
  ])
  expect(Result.isFailure(decodeSeed({ ...seed, observations: [] }))).toBe(true)
  expect(
    Result.isFailure(
      decodeSeed({ ...seed, acronyms: [{ ...seed.acronyms[0], accessToken: 'not part of the wire shape' }] }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(prepareKnowledge({ ...seed, acronyms: [seed.acronyms[0], { ...seed.acronyms[0], name: 'b0' }] })),
  ).toBe(true)
})

test('the published delta wire schema matches Effect and rejects unverified shapes and common sensitive values', () => {
  expect(deltaJsonSchema).toEqual(knowledgeDeltaJsonSchema())
  const decode = Schema.decodeUnknownResult(KnowledgeDelta, strictKnowledge)
  const proposal = {
    schemaVersion: 'bayn.ontology.knowledge-delta.v1',
    sourceCommit: 'a'.repeat(40),
    referencedTables: [],
    verificationNote: 'Compared against the pinned audit and reviewed its migrations.',
    changes: [{ kind: 'acronym', ...seed.acronyms[0] }],
  }
  expect(Result.isSuccess(decode(proposal))).toBe(true)
  for (const change of [
    { sourceCommit: 'main' },
    { referencedTables: ['pg_catalog.pg_user'] },
    { referencedTables: undefined },
    { verificationNote: ' ' },
    { verificationNote: 'not allowed: auto_ontology_test-leak' },
    { verificationNote: 'not allowed: reviewer@example.test' },
    { verificationNote: 'postgres://user:pass@host/db' },
    { changes: [{ ...seed.acronyms[0], kind: 'rule' }] },
    { changes: [{ ...seed.analyses[0], kind: 'analysis' }] },
    { changes: [{ ...seed.acronyms[0], kind: 'acronym', fixture: 'raw evidence' }] },
    { changes: [] },
  ])
    expect(Result.isFailure(decode({ ...proposal, ...change }))).toBe(true)
  expect(
    Result.isSuccess(
      decode({
        ...proposal,
        referencedTables: seed.analyses[0].referencedTables,
        changes: [{ kind: 'analysis', ...seed.analyses[0] }],
      }),
    ),
  ).toBe(true)
})

test('rejects writes, non-bound placeholders, wildcards, and functions outside the reviewed SQL subset', () => {
  const source = ' FROM public.fills WHERE account_id = $1 AND occurred_at >= $2 AND occurred_at < $3'
  for (const sql of [
    `DELETE${source}`,
    `SELECT account_id${source}; SELECT 1`,
    `SELECT *${source}`,
    `SELECT account_id, pg_advisory_lock(1)${source}`,
    `SELECT account_id, public.sum(1)${source}`,
    `SELECT account_id${source} FOR UPDATE`,
    `SELECT account_id${source} /* hidden schema */`,
    `SELECT account_id${source.replace('$3', '$4')}`,
    `SELECT account_id${source.replace('$3', "'$3'")}`,
  ])
    expect(Result.isFailure(prepareAnalysis({ ...seed.analyses[0], sql }, 0))).toBe(true)

  const prepared = Result.getOrThrow(prepareAnalysis({ ...seed.analyses[0], sql: `SELECT '$1' AS label${source}` }, 0))
  expect(prepared.viewSql).toContain("SELECT '$1' AS label")
  expect(prepared.viewSql).toContain('account_id = (NULL::text)')
  expect(prepared.viewSql).toContain('occurred_at < (NULL::timestamptz)')
})

test('relation allowlist is exact: nonexistent, omitted, or extraneous dependencies fail closed', () => {
  const prepared = Result.getOrThrow(prepareAnalysis(seed.analyses[0], 0))
  const tables = prepared.analysis.referencedTables
  expect(Result.isSuccess(verifyReferences(prepared, tables.toReversed()))).toBe(true)
  expect(Result.isFailure(verifyReferences(prepared, tables.slice(1)))).toBe(true)
  expect(Result.isFailure(verifyReferences(prepared, ['public.nonexistent', ...tables.slice(1)]))).toBe(true)
  expect(Result.isFailure(verifyReferences(prepared, ['pg_catalog.pg_class', ...tables]))).toBe(true)
})

test('plans creates, minimal updates, and no writes for the same catalog without removing unrelated records', () => {
  const [acronym, rule, analysis] = Result.getOrThrow(planUpserts(excerpt, empty))
  expect([acronym, rule, analysis].map((item) => item?.method)).toEqual(['POST', 'POST', 'POST'])
  const catalog: Catalog = {
    ...empty,
    acronyms: [
      Schema.decodeUnknownSync(AcronymRow)({ id: 'a', ...acronym?.body }),
      { id: 'unrelated', name: 'Other', description: 'Leave untouched' },
    ],
    rules: [
      Schema.decodeUnknownSync(RuleRow)({
        id: 'r',
        ...rule?.body,
        tags: [{ id: empty.ruleTagId, name: 'Bayn canonical rule' }],
      }),
    ],
    analyses: [Schema.decodeUnknownSync(AnalysisRow)({ id: 's', ...analysis?.body })],
  }
  expect(Result.getOrThrow(planUpserts(excerpt, catalog))).toEqual([])
  const existing = {
    ...catalog,
    acronyms: catalog.acronyms.map((row) => ({ ...row, description: 'old' })),
    rules: catalog.rules.map((row) => ({ ...row, name: 'Bayn [nanosecond-source-time]: Old rule' })),
    analyses: catalog.analyses.map((row) => ({ ...row, sql: 'SELECT 1' })),
  }
  const changes = Result.getOrThrow(planUpserts(excerpt, existing))
  expect(changes.map(({ method, id }) => [method, id])).toEqual([
    ['PATCH', 'a'],
    ['PATCH', 'r'],
    ['PUT', 's'],
  ])
  expect(changes[1]?.body).toEqual({ name: catalog.rules[0]?.name })
  expect(
    Result.isFailure(
      planUpserts(excerpt, {
        ...catalog,
        rules: catalog.rules.map((row) => ({ ...row, filters: { ...row.filters, data: ['another-db'] } })),
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      planUpserts(excerpt, {
        ...catalog,
        acronyms: [...catalog.acronyms, { id: 'duplicate', name: 'b0', description: null }],
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      planUpserts(excerpt, {
        ...catalog,
        analyses: catalog.analyses.map((row) => ({ ...row, name: 'Different analysis name' })),
      }),
    ),
  ).toBe(true)
})
