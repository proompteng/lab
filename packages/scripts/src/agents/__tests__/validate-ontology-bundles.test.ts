import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { format } from 'oxfmt'

import { readMigrationRelations } from '../ontology-migration-relations'
import { validateOntologyBundles } from '../validate-ontology-bundles'

const knowledge = 'docs/other/ontology/other-knowledge.json'
const agentsKnowledge = 'docs/agents/ontology/agents-knowledge.json'
const baynKnowledge = 'docs/bayn/ontology/bayn-knowledge.json'
const agentsMigrations = 'services/agents/src/server/migrations'
const baynMigrations = 'services/bayn/migrations'
const sourceCommit = 'a'.repeat(40)
const analysis = (sql: string, referencedTables?: string[]) => ({
  description: 'Counts the retained readings.',
  name: 'Readings by status',
  ...(referencedTables === undefined ? {} : { referencedTables }),
  sql,
})
const bundle = (sql = 'SELECT 1', tables?: string[]) => ({
  acronyms: [{ description: 'Observed reading.', name: 'Reading' }],
  customAnalyses: [analysis(sql, tables)],
  rules: [],
  version: 1,
})
const agentsBundle = (sql: string, tables?: string[]) => {
  const { acronyms, customAnalyses, rules, version } = bundle(sql, tables)
  return { acronyms, customAnalyses, dataSource: 'agents-db-next', database: 'agents', rules, version }
}
const sources = ['https://github.com/proompteng/lab/pull/1']
const baynAnalysis = (sql: string) => ({
  name: 'Bayn: Readings',
  description: 'Lists the retained readings.',
  sql,
  referencedTables: ['public.readings'],
  sources,
})
const baynBundle = (sql: string) => ({
  schemaVersion: 'bayn.ontology.knowledge.v1',
  acronyms: [{ name: 'Reading', description: 'Observed reading.', sources }],
  rules: [{ key: 'readings', description: 'Read only.', searchTerm: 'readings', sources }],
  analyses: [baynAnalysis(sql)],
})
const writeSql = 'CREATE TABLE readings (id int, status text)'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ontology-validator-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const put = async (path: string, data: string | Uint8Array) => {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, data)
}
const json = async (path: string, value: unknown) => {
  const { code } = await format('knowledge.json', JSON.stringify(value, null, 2), { printWidth: 120 })
  await put(path, code)
}
const runCli = () =>
  Bun.spawnSync([process.execPath, join(import.meta.dir, '../validate-ontology-bundles.ts')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })

describe('discovery and JSON contracts', () => {
  test('succeeds with no docs or bundles and ignores unrelated JSON files', async () => {
    expect(await validateOntologyBundles(root)).toEqual({ files: 0, errors: [] })
    await put('docs/agents/ontology/metadata.json', 'not a bundle')
    await put('docs/agents/other/subfolder/ontology/agents-knowledge.json', 'not a bundle')
    const result = runCli()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('Validated 0')
  })

  test('validates multiple owners and both seed/delta formats in a single run', async () => {
    await put(`${agentsMigrations}/0001.sql`, 'CREATE TABLE audit.readings (status text)')
    await put(`${baynMigrations}/0001.sql`, writeSql)
    await json(agentsKnowledge, {
      ...agentsBundle('SELECT status FROM audit.readings'),
      rules: [{ description: 'Retained readings have a status.', name: 'Reading status', searchTerm: 'Reading' }],
    })
    await json(baynKnowledge, baynBundle('SELECT id FROM public.readings WHERE id = $1'))
    await json('docs/agents/ontology/knowledge-delta-rules.json', {
      kind: 'knowledge-delta',
      rules: [{ description: 'Retained readings have a status.', name: 'Reading status' }],
      sourceCommit,
      verificationNote: 'Checked the migration.',
      version: 1,
    })
    await json('docs/bayn/ontology/knowledge-delta-analyses.json', {
      schemaVersion: 'bayn.ontology.knowledge-delta.v1',
      sourceCommit,
      referencedTables: ['public.readings'],
      verificationNote: 'Checked the migration.',
      changes: [{ kind: 'analysis', ...baynAnalysis('SELECT id FROM public.readings') }],
    })
    await json(knowledge, bundle())
    expect(await validateOntologyBundles(root)).toEqual({ files: 5, errors: [] })
    expect(runCli().exitCode).toBe(0)
  })

  test('reports every invalid file in deterministic order and exits nonzero', async () => {
    await put('docs/zeta/ontology/z-knowledge.json', '{')
    await put('docs/alpha/ontology/knowledge-delta.json', '{')
    await json(knowledge, bundle())
    const result = runCli()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString().trim().split('\n')).toEqual([
      '"docs/alpha/ontology/knowledge-delta.json": Invalid JSON',
      '"docs/zeta/ontology/z-knowledge.json": Invalid JSON',
      'Ontology validation failed: 2 of 3 file(s)',
    ])
  })

  test.each([
    ['unsorted keys', '{"version":1,"rules":[],"customAnalyses":[],"acronyms":[]}'],
    [
      'duplicate keys',
      '{\n  "acronyms": [],\n  "customAnalyses": [],\n  "rules": [],\n  "version": 2,\n  "version": 1\n}\n',
    ],
    ['missing final newline', '{\n  "acronyms": [],\n  "customAnalyses": [],\n  "rules": [],\n  "version": 1\n}'],
  ])('rejects noncanonical JSON: %s', async (_, source) => {
    await put(knowledge, source)
    expect((await validateOntologyBundles(root)).errors[0]).toContain('Expected canonical JSON')
  })

  test('rejects Bayn objects that change the schema field order', async () => {
    const { acronyms, analyses, rules, schemaVersion } = baynBundle('SELECT id FROM public.readings')
    await json(baynKnowledge, { acronyms, analyses, rules, schemaVersion })
    expect((await validateOntologyBundles(root)).errors[0]).toContain('Bayn schema field order')
  })

  test.each([
    ['a root array', [], 'expected an object'],
    ['missing collections', { version: 1 }, 'missing acronyms'],
    ['wrong version', { ...bundle(), version: '1' }, 'Unsupported knowledge bundle version'],
    ['nonarray analyses', { ...bundle(), customAnalyses: {} }, 'expected an array'],
    ['missing description', { ...bundle(), rules: [{ name: 'Rule' }] }, 'missing description'],
    ['empty description', { ...bundle(), rules: [{ description: '  \t', name: 'Rule' }] }, 'expected non-empty text'],
    [
      'unexpected field',
      { ...bundle(), rules: [{ description: 'Text', name: 'Rule', payload: 'Not allowed' }] },
      'unexpected field',
    ],
  ])('rejects %s', async (_, value, error) => {
    await json(knowledge, value)
    expect((await validateOntologyBundles(root)).errors[0]).toContain(error)
  })

  test('requires provenance and at least one entry for deltas', async () => {
    const path = 'docs/other/ontology/knowledge-delta.json'
    await json(path, { kind: 'knowledge-delta', sourceCommit: 'latest', verificationNote: 'Checked', version: 1 })
    expect((await validateOntologyBundles(root)).errors[0]).toContain('expected a Git commit SHA')
    await json(path, { kind: 'knowledge-delta', sourceCommit, verificationNote: 'Checked', version: 1 })
    expect((await validateOntologyBundles(root)).errors[0]).toContain('expected at least one knowledge entry')
  })

  test('recognizes generated delta schemas without mistaking regex markers for tokens', async () => {
    const path = 'docs/bayn/ontology/knowledge-delta.schema.json'
    await json(path, {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { verificationNote: { pattern: '(?!.*(?:auto_ontology_|AKIA|sk-|-----BEGIN [^x]+PRIVATE KEY))' } },
      required: ['verificationNote'],
      additionalProperties: false,
    })
    expect(await validateOntologyBundles(root)).toEqual({ files: 1, errors: [] })
    await json(path, bundle('DELETE FROM readings'))
    expect((await validateOntologyBundles(root)).errors[0]).toContain('missing $schema')
  })

  test('rejects a matching symlink and invalid UTF-8 instead of silently skipping them', async () => {
    await put(knowledge, Uint8Array.of(0xff))
    const link = 'docs/other/ontology/linked-knowledge.json'
    await symlink('other-knowledge.json', join(root, link))
    const result = await validateOntologyBundles(root)
    expect(result.files).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every((error) => error.includes('Could not read a regular UTF-8 JSON file'))).toBe(true)
  })
})

describe('disclosure checks', () => {
  test.each([
    'auto_ontology_not-a-token',
    'sk-not-a-token',
    'AKIA_NOT_A_KEY',
    'ghp_not_a_token',
    'Bearer not-a-token',
    '-----BEGIN PRIVATE KEY-----',
    'postgres://reader:fake-password@db.invalid/example',
    'person@example.invalid',
    '999-00-1234',
    '202-555-0100',
  ])('rejects synthetic test pattern %# without echoing it', async (sample) => {
    await json(knowledge, { ...bundle(), rules: [{ description: sample, name: 'Rule' }] })
    const result = runCli()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Possible credential or personal data')
    expect(result.stderr.toString()).not.toContain(sample)
  })

  test('scans decoded keys, not just raw input or description fields', async () => {
    await put(knowledge, '{"safe":{"\\u0061uto_ontology_synthetic":true}}')
    const { errors } = await validateOntologyBundles(root)
    expect(errors[0]).toContain('Possible credential or personal data')
    expect(errors[0]).not.toContain('synthetic')
  })

  test('scans SQL, evidence links, and verification notes before logging errors', async () => {
    await json(knowledge, bundle("SELECT 'person@example.invalid'"))
    await json(baynKnowledge, {
      ...baynBundle('SELECT id FROM public.readings'),
      acronyms: [{ sources: ['https://reader:fake@db.invalid'] }],
    })
    await json('docs/other/ontology/knowledge-delta.json', {
      kind: 'knowledge-delta',
      sourceCommit,
      verificationNote: 'ghp_not_a_token',
      version: 1,
    })
    const { errors } = await validateOntologyBundles(root)
    expect(errors).toHaveLength(3)
    expect(errors.every((error) => error.includes('Possible credential or personal data'))).toBe(true)
  })

  test('checks decoded PostgreSQL string literals as well as decoded JSON strings', async () => {
    await json(knowledge, bundle(String.raw`SELECT E'\x61uto_ontology_not-a-token'`))
    const { errors } = await validateOntologyBundles(root)
    expect(errors[0]).toContain('customAnalyses[0].sql: Possible credential or personal data')
    expect(errors[0]).not.toContain('not-a-token')
  })
})

describe('read-only SQL', () => {
  test.each([
    'INSERT INTO readings (id) VALUES (1)',
    'UPDATE readings SET id = 1',
    'DELETE FROM readings',
    'DROP TABLE readings',
    'ALTER TABLE readings ADD COLUMN code int',
    'GRANT SELECT ON readings TO somebody',
    'TRUNCATE readings',
    'COPY readings TO STDOUT',
    'SELECT 1; SELECT 2',
    'SELECT 1;;',
    'WITH changed AS (DELETE FROM readings RETURNING id) SELECT id FROM changed',
    'WITH data AS (SELECT 1) UPDATE readings SET id = 2',
    'WITH data AS (SELECT 1) TABLE data',
    'SELECT id INTO new_readings FROM readings',
    'SELECT id FROM readings FOR SHARE',
    'SELECT arbitrary_function()',
    'SELECT 1::custom_type',
    'SELECT 1 +',
  ])('rejects %s even without migration configuration', async (sql) => {
    await json(knowledge, bundle(sql))
    expect((await validateOntologyBundles(root)).errors[0]).toContain('customAnalyses[0].sql:')
  })

  test('accepts SELECT with parameters, nesting, CTEs, comments and semicolons inside literals', async () => {
    await put(`${agentsMigrations}/0001.sql`, `${writeSql}; CREATE TABLE "Daily Counts" (reading_id int)`)
    await json(
      agentsKnowledge,
      agentsBundle(
        `/* Read-only */ with seed as (
          select id, $$INSERT; DROP$$ as label from public.readings where id = $1
        ), counted as (
          select seed.label from seed join public."Daily Counts" d on d.reading_id = seed.id
        )
        select count(*) from (select label from counted where label <> 'café; UPDATE') result; -- Note`,
        ['readings', 'public."Daily Counts"'],
      ),
    )
    expect(await validateOntologyBundles(root)).toEqual({ files: 1, errors: [] })
  })
})

describe('migration-backed relation names', () => {
  test('indexes the actual service migration formats and excludes retired relations', async () => {
    const checkout = fileURLToPath(new URL('../../../../../', import.meta.url))
    const agents = await readMigrationRelations(join(checkout, agentsMigrations))
    expect(agents.has('agents_codex.runs')).toBe(true)
    expect(agents.has('agents_comms.agent_messages')).toBe(true)
    expect(agents.has('memories.entries')).toBe(true)
    expect(agents.has('agents_audit.agent_run_activity')).toBe(true)
    expect(agents.has('agents_audit.memory_notes')).toBe(true)
    const bayn = await readMigrationRelations(join(checkout, baynMigrations))
    expect(bayn.has('public.orders')).toBe(true)
    expect(bayn.has('public.broker_fee_accounting_evidence')).toBe(true)
    expect(bayn.has('public.broker_errors')).toBe(false)
  })

  test.each([
    'SELECT id FROM missing.readings',
    'SELECT id FROM readings JOIN missing AS m USING (id)',
    'SELECT id FROM readings, missing',
    'SELECT EXISTS (SELECT FROM missing)',
    'WITH hidden AS (SELECT id FROM missing) SELECT id FROM hidden',
    'SELECT id FROM (WITH hidden AS (SELECT id FROM readings) SELECT id FROM hidden) d, hidden',
    'WITH first AS (SELECT id FROM second), second AS (SELECT id FROM readings) SELECT id FROM first',
  ])('rejects unresolved relations in %s', async (sql) => {
    await put(`${agentsMigrations}/0001.sql`, writeSql)
    await json(agentsKnowledge, agentsBundle(sql))
    expect((await validateOntologyBundles(root)).errors[0]).toContain('not declared by the owning service')
  })

  test('does not search another service or accept a mismatched declared dependency', async () => {
    await put(`${agentsMigrations}/0001.sql`, 'CREATE TABLE agent_only (id int)')
    await put(`${baynMigrations}/0001.sql`, `${writeSql}; CREATE TABLE other (id int)`)
    await json(agentsKnowledge, agentsBundle('SELECT id FROM public.readings'))
    await json(baynKnowledge, baynBundle('SELECT id FROM public.other'))
    const { errors } = await validateOntologyBundles(root)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('not declared by the owning service')
    expect(errors[1]).toContain('must match the SQL table dependencies')
  })

  test('checks delta referencedTables even without SQL', async () => {
    await put(`${baynMigrations}/0001.sql`, writeSql)
    await json('docs/bayn/ontology/knowledge-delta.json', {
      schemaVersion: 'bayn.ontology.knowledge-delta.v1',
      sourceCommit,
      referencedTables: ['public.missing'],
      verificationNote: 'Checked the migration.',
      changes: [{ kind: 'acronym', name: 'Reading', description: 'Observed reading.', sources }],
    })
    expect((await validateOntologyBundles(root)).errors[0]).toContain(
      'delta.referencedTables: a table or view is not declared',
    )
  })

  test('requires delta referencedTables to cover the included analysis', async () => {
    await put(`${baynMigrations}/0001.sql`, writeSql)
    await json('docs/bayn/ontology/knowledge-delta.json', {
      schemaVersion: 'bayn.ontology.knowledge-delta.v1',
      sourceCommit,
      referencedTables: [],
      verificationNote: 'Checked the migration.',
      changes: [{ kind: 'analysis', ...baynAnalysis('SELECT id FROM readings') }],
    })
    expect((await validateOntologyBundles(root)).errors[0]).toContain('SQL table dependency is missing from the delta')
  })

  test('tracks DDL in filename order and ignores comments, strings, and rollbacks', async () => {
    await put(
      `${agentsMigrations}/0002.sql`,
      `
      ALTER TABLE readings RENAME TO observations;
      ALTER TABLE observations SET SCHEMA audit;
      CREATE VIEW audit.summary AS SELECT id FROM audit.observations;
      DROP TABLE IF EXISTS public.obsolete, public.also_obsolete;
      -- CREATE TABLE audit.commented (id int)
      SELECT 'CREATE TABLE audit.quoted (id int)';
    `,
    )
    await put(
      `${agentsMigrations}/0001.ts`,
      `
      export const up = () => {
        sql\`CREATE SCHEMA audit; ${writeSql}; CREATE TABLE obsolete (id int); CREATE TABLE also_obsolete (id int)\`
      }
      export const down = () => {
        sql\`DROP VIEW audit.summary; CREATE TABLE rolled_back (id int)\`
      }
    `,
    )
    const relations = await readMigrationRelations(join(root, agentsMigrations))
    expect([...relations].sort()).toEqual(['audit.observations', 'audit.summary'])
    await json(agentsKnowledge, agentsBundle('SELECT id FROM audit.summary'))
    expect(await validateOntologyBundles(root)).toEqual({ files: 1, errors: [] })
  })

  test('fails closed if configured migrations are unavailable or cannot describe the relation', async () => {
    await json(agentsKnowledge, agentsBundle('SELECT id FROM readings'))
    expect((await validateOntologyBundles(root)).errors[0]).toContain(
      'Could not read the configured migrations directory',
    )
    await put(`${agentsMigrations}/0001.ts`, 'export const up = () => sql`CREATE TABLE ${dynamicName} (id int)`')
    expect((await validateOntologyBundles(root)).errors[0]).toContain('Could not read relation DDL from migration 1')
  })
})
