import { describe, expect, it, mock } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readAgentsOntologyTables, withAgentsOntologySchema } from '../agents-ontology-schema'
import { type KnowledgeDelta, mergeKnowledgeDeltas, serializeBundle } from '../ontology-deltas'
import { validateOntologyAnalyses } from '../ontology-sql'

const empty = { acronyms: [], customAnalyses: [], dataSource: 'agents-db-next', rules: [], version: 1 } as const
const entry = (name: string) => ({ name, description: `Verified definition for ${name}` })
const analysis = (name: string, sql: string) => ({ ...entry(name), sql })
const delta = (changes: Partial<KnowledgeDelta> = {}): KnowledgeDelta => ({
  kind: 'knowledge-delta',
  version: 1,
  sourceCommit: 'a1b2c3d',
  verificationNote: 'Checked the source and the migration fixture.',
  ...changes,
})
const merge = (target: unknown, ...proposals: unknown[]) =>
  mergeKnowledgeDeltas(
    target,
    proposals.map((value, index) => ({ label: `proposal ${index + 1}`, value })),
  )
const seedBundle = new URL('../../../../../docs/agents/ontology/agents-knowledge.json', import.meta.url)

describe('knowledge delta merge', () => {
  it('sorts entries and keys, deduplicates exact replays and retains deterministic provenance', () => {
    const target = { ...empty, acronyms: [entry('VCSProvider')] }
    const first = delta({ acronyms: [entry('tmpfs'), entry('AgentRun')], rules: [entry('Scoped analyses')] })
    const second = delta({ sourceCommit: '012abcd', acronyms: [entry('AgentRun'), entry('CNPG')] })
    const result = merge(target, first, second)

    expect(result.acronyms.map(({ name }) => name)).toEqual(['AgentRun', 'CNPG', 'tmpfs', 'VCSProvider'])
    expect(result.acronyms[0]?.provenance).toEqual({
      sourceCommit: '012abcd',
      verificationNote: second.verificationNote,
    })
    expect(result.rules[0]?.provenance?.sourceCommit).toBe(first.sourceCommit)
    expect(serializeBundle(result)).toBe(serializeBundle(merge(target, second, first)))
    expect(serializeBundle(result)).toBe(serializeBundle(merge(result, first, second)))
    expect(Object.keys(JSON.parse(serializeBundle(result)).acronyms[0])).toEqual(['description', 'name', 'provenance'])
    expect(target.acronyms).toEqual([entry('VCSProvider')])
  })

  it('rejects collisions with the bundle or across proposals, including case-only changes', () => {
    const rule = delta({ rules: [entry('Read-only')] })
    const conflict = delta({ rules: [{ name: 'read-only', description: 'Different claim' }] })
    expect(() => merge(merge(empty, rule), conflict)).toThrow('Conflicting duplicate name in rules')
    expect(() => merge(empty, rule, conflict)).toThrow('Conflicting duplicate name in rules')
    expect(() => merge({ ...empty, rules: [entry('Read-only'), entry('Read-only')] })).toThrow(
      'Duplicate name in bundle',
    )
  })

  it.each([
    [{ sourceCommit: undefined }, 'sourceCommit'],
    [{ sourceCommit: '123456' }, 'sourceCommit'],
    [{ sourceCommit: 'g123456' }, 'sourceCommit'],
    [{ sourceCommit: 'f'.repeat(41) }, 'sourceCommit'],
    [{ verificationNote: undefined }, 'verificationNote'],
    [{ verificationNote: '  ' }, 'verificationNote'],
    [{ approved: true }, 'Unknown field(s)'],
    [{ acronyms: [{ ...entry('AgentRun'), extra: true }] }, 'Unknown field(s)'],
    [{ rules: undefined }, 'Expected at least one knowledge entry'],
  ])('fails closed on bad or missing provenance, entries and fields (%j)', (change, reason) => {
    expect(() => merge(empty, { ...delta({ rules: [entry('Test rule')] }), ...change })).toThrow(reason)
  })

  it('normalizes a valid full-length Git SHA', () => {
    const result = merge(empty, delta({ sourceCommit: 'ABC01234'.repeat(5), acronyms: [entry('AgentRun')] }))
    expect(result.acronyms[0]?.provenance?.sourceCommit).toBe('abc01234'.repeat(5))
  })

  it.each([
    ['rule API key', { rules: [{ name: 'Test rule', description: ['sk', 'proj', 'a'.repeat(24)].join('-') }] }],
    ['Bearer token', { verificationNote: ['Bearer', 'value' + '7'.repeat(16)].join(' ') }],
    [
      'private key',
      { acronyms: [{ name: 'Test', description: ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ') }] },
    ],
    ['database password', { verificationNote: ['postgres://service:', 'not-real', '@host/db'].join('') }],
    ['credential in SQL', { customAnalyses: [analysis('Secrets', "SELECT 'api_key=examplevalue' FROM agent_runs")] }],
  ])('rejects %s', (_label, change) => {
    expect(() => merge(empty, { ...delta({ rules: [entry('Test rule')] }), ...change })).toThrow('Possible credential')
  })
})

describe('reviewed SQL', () => {
  const tables = new Set(['public.agent_runs', 'agents_codex.runs'])

  it.each([
    'INSERT INTO agent_runs (id) VALUES (NULL)',
    'UPDATE agent_runs SET status = NULL',
    'DELETE FROM agent_runs',
    'DROP TABLE agent_runs',
    'ALTER TABLE agent_runs DROP COLUMN status',
    'GRANT SELECT ON agent_runs TO PUBLIC',
    'TRUNCATE TABLE agent_runs',
    'COPY agent_runs TO STDOUT',
    'SELECT id FROM agent_runs; /* extra statement */ DELETE FROM agent_runs',
    'WITH changed AS (UPDATE agent_runs SET status = NULL RETURNING id) SELECT id FROM changed',
    'SELECT id FROM agent_runs WHERE id IN (WITH gone AS (DELETE FROM agent_runs RETURNING id) SELECT id FROM gone)',
    'SELECT id INTO temp_ids FROM agent_runs',
    'SELECT id FROM agent_runs FOR SHARE',
    "SELECT id, pg_catalog.set_config('search_path', 'other', false) FROM agent_runs",
    "SELECT id, pg_read_file('anything') FROM agent_runs",
    'TABLE agent_runs',
    'VALUES (1)',
    'SELECT ctid FROM agent_runs',
    'SELECT id FROM agent_runs WHERE status = $1',
    'SELECT id FROM agent_runs WHERE id OPERATOR(public.=) id',
  ])('rejects unsafe or non-SELECT SQL before binding: %s', async (sql) => {
    const describe = mock(async () => undefined)
    await rejects(validateOntologyAnalyses([analysis('Rejected', sql)], { tables, describe }))
    expect(describe).not.toHaveBeenCalled()
  })

  it('accepts SELECT CTEs, aliases and SQL keywords inside literals or comments', async () => {
    const describe = mock(async () => undefined)
    const sql = `/* DROP */ WITH recent AS (SELECT r.id, r.status FROM "public".agent_runs r)
      SELECT count(*) FROM recent WHERE status = 'copy; delete'; -- INSERT`
    await validateOntologyAnalyses([analysis('Recent', sql)], { tables, describe })
    expect(describe).toHaveBeenCalledWith(sql)
  })

  it('rejects equivalent SQL under different names', async () => {
    const root = merge(empty, delta({ customAnalyses: [analysis('First', 'SELECT id FROM agent_runs')] }))
    const proposed = merge(
      root,
      delta({ customAnalyses: [analysis('Second', 'select id /* seen */ from agent_runs;')] }),
    )
    await rejects(
      validateOntologyAnalyses(proposed.customAnalyses, { tables, describe: mock(async () => undefined) }),
      /Duplicate SQL/,
    )
  })

  it('resolves real qualified table names and fails on drift in either proposals or the existing bundle', async () => {
    await withAgentsOntologySchema(async (pg) => {
      const fixture = { tables: await readAgentsOntologyTables(pg), describe: (sql: string) => pg.describeQuery(sql) }
      for (const name of [
        'public.agent_runs',
        'agents_comms.agent_messages',
        'agents_codex.runs',
        'memories.entries',
        'public.agent_run_relay_submissions',
        'public.agent_run_rerun_submissions',
      ])
        expect(fixture.tables.has(name)).toBe(true)

      for (const sql of [
        'SELECT id FROM agents_codex.codex_run_projection',
        'SELECT id FROM public.agent_runs WHERE id IN (SELECT projection_id FROM public.relay_submissions)',
        'SELECT oid FROM pg_catalog.pg_class',
        'SELECT name FROM agents_kysely_migration',
        'WITH a AS (SELECT oid FROM pg_class), pg_class AS (SELECT id FROM agent_runs) SELECT oid FROM a',
        'SELECT r.unknown_column FROM agent_runs r',
      ]) {
        const proposal = merge(empty, delta({ customAnalyses: [analysis('Drift', sql)] }))
        await rejects(validateOntologyAnalyses(proposal.customAnalyses, fixture), /Schema drift/)
      }

      const existing = merge({
        ...empty,
        customAnalyses: [analysis('Formerly valid', 'SELECT status FROM agent_runs')],
      })
      await validateOntologyAnalyses(existing.customAnalyses, fixture)
      await pg.exec('ALTER TABLE public.agent_runs RENAME COLUMN status TO new_status')
      await rejects(validateOntologyAnalyses(existing.customAnalyses, fixture), /unresolved table or column/)
    })
  })

  it('validates the checked-in bundle and reports observed timing, usage coverage, and unknown cost', async () => {
    const contents = await readFile(seedBundle, 'utf8')
    const bundle = merge(JSON.parse(contents))
    expect(serializeBundle(bundle)).toBe(contents)
    await withAgentsOntologySchema(async (pg) => {
      await validateOntologyAnalyses(bundle.customAnalyses, {
        tables: await readAgentsOntologyTables(pg),
        describe: (sql) => pg.describeQuery(sql),
      })
      const runner = { provider: 'codex', model: 'example-model' }
      const statuses = [
        {
          reason: 'TimedOut',
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:02:00Z',
          runner: { ...runner, telemetry: { usage: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 20 } } },
        },
        { reason: 'TimedOut', runner },
      ]
      for (const [index, status] of statuses.entries()) {
        await pg.query(
          `INSERT INTO agents_control_plane.resources_current
          (kind, namespace, name, resource, fingerprint, status_phase, spec_runtime_type, spec_agent_ref_name, resource_updated_at)
          VALUES ('AgentRun', 'agents', $1, $2, $1, 'Failed', 'job', 'example-agent', now())`,
          [`run-${index}`, { status }],
        )
      }
      const run = async (name: string) => {
        const selected = bundle.customAnalyses.find((item) => item.name === name)
        if (!selected) throw new Error(`Missing seeded analysis ${name}`)
        return (await pg.query(selected.sql)).rows
      }
      expect(await run('AgentRun failure taxonomy')).toEqual([
        { namespace: 'agents', runtime: 'job', failure_category: 'timeout', failed_runs: 2 },
      ])
      expect(await run('AgentRun duration and cost inputs by agent and model')).toEqual([
        {
          namespace: 'agents',
          agent: 'example-agent',
          provider: 'codex',
          model: 'example-model',
          terminal_runs: 2,
          runs_with_duration: 1,
          mean_duration_seconds: '120.00',
          runs_with_token_usage: 1,
          input_tokens: '50',
          cached_input_tokens: '10',
          cache_write_input_tokens: null,
          output_tokens: '20',
          billed_cost_usd: null,
        },
      ])
    })
  })
})

it('dry-runs files and directories, atomically writes once, and leaves the bundle unchanged on rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ontology-curator-'))
  try {
    const bundle = join(dir, 'bundle.json')
    const inputDir = join(dir, 'proposals')
    const inputFile = join(dir, 'one.json')
    const good = JSON.stringify(delta({ acronyms: [entry('AgentRun')] }))
    const original = serializeBundle(merge(empty))
    await mkdir(inputDir)
    await writeFile(bundle, original)
    await writeFile(inputFile, good)
    await writeFile(join(inputDir, 'two.json'), JSON.stringify(delta({ rules: [entry('Read-only queries')] })))
    await writeFile(join(inputDir, 'ignored.txt'), '{')

    const run = async (...args: string[]) => {
      const cli = fileURLToPath(new URL('../curate-ontology-deltas.ts', import.meta.url))
      const result = Bun.spawn([process.execPath, 'run', cli, '--bundle', bundle, ...args], { stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([
        result.exited,
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const args = ['--input', inputDir, '--input', inputFile]
    const preview = await run(...args)
    expect(preview).toMatchObject({ code: 0, stdout: expect.stringContaining('would update bundle') })
    expect(await readFile(bundle, 'utf8')).toBe(original)
    expect(await run(...args, '--mode', 'write')).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('bundle updated'),
    })
    const written = await readFile(bundle, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ acronyms: [entry('AgentRun')], rules: [entry('Read-only queries')] })
    expect(await run(...args, '--mode', 'write')).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('bundle unchanged'),
    })

    await writeFile(
      join(inputDir, 'bad.json'),
      JSON.stringify(delta({ customAnalyses: [analysis('Old', 'SELECT id FROM missing_table')] })),
    )
    const rejected = await run(...args, '--mode', 'write')
    expect(rejected).toMatchObject({ code: 1, stderr: expect.stringContaining('Schema drift') })
    expect(await readFile(bundle, 'utf8')).toBe(written)

    const credential = 'fabricated' + '8'.repeat(16)
    await writeFile(
      join(inputDir, 'bad.json'),
      JSON.stringify(
        delta({
          rules: [entry('Test evidence')],
          verificationNote: `Authorization: Bearer ${credential}`,
        }),
      ),
    )
    const leaked = await run(...args, '--mode', 'write')
    expect(leaked.code).toBe(1)
    expect(leaked.stderr).toContain('possible credential')
    expect(leaked.stderr).not.toContain(credential)
    expect(await readFile(bundle, 'utf8')).toBe(written)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
