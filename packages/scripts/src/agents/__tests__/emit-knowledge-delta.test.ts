import { describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { prepareKnowledgeDelta } from '../emit-knowledge-delta-core'
import { mergeKnowledgeDeltas } from '../ontology-deltas'
import { validateOntologyBundles } from '../validate-ontology-bundles'

const headCommit = 'ab01cd23'.repeat(5)
const note = 'Checked the registered migration and confirmed the terminal phase is persisted.'
const acronym = { name: 'Terminal phase', description: 'The observed end state of an AgentRun.' }
const draft = { verificationNote: note, acronyms: [acronym] }
const prepare = (value: unknown) => prepareKnowledgeDelta(JSON.stringify(value), { headCommit })
const select = (sql: string) => ({
  ...draft,
  customAnalyses: [{ name: 'Retained runs', description: 'Counts runs.', sql }],
})
const rejectsWith = (result: Promise<unknown>, reason: string, hidden?: string) =>
  rejects(result, (error) => {
    if (!(error instanceof Error)) return false
    expect(error.message).toContain(reason)
    if (hidden) expect(error.message).not.toContain(hidden)
    return true
  })

describe('knowledge delta preflight', () => {
  test('stamps metadata and emits canonical, byte-identical JSON for different key order and whitespace', async () => {
    const canonical = await prepare(draft)
    expect(canonical).toBe(
      [
        '{',
        '  "acronyms": [',
        '    {',
        '      "description": "The observed end state of an AgentRun.",',
        '      "name": "Terminal phase"',
        '    }',
        '  ],',
        '  "kind": "knowledge-delta",',
        '  "sourceCommit": "' + headCommit + '",',
        '  "verificationNote": "' + note + '",',
        '  "version": 1',
        '}',
        '',
      ].join('\n'),
    )
    expect(
      await prepare({
        acronyms: [{ description: acronym.description, name: acronym.name }],
        kind: 'knowledge-delta',
        version: 1,
        sourceCommit: headCommit.toUpperCase(),
        verificationNote: '  ' + note + ' \n',
      }),
    ).toBe(canonical)
    expect(await prepareKnowledgeDelta(canonical, { headCommit, check: true })).toBe(canonical)
  })

  test('checks the exact canonical artifact, including metadata, formatting, and unique keys', async () => {
    const canonical = await prepare(draft)
    await rejectsWith(
      prepareKnowledgeDelta(canonical.trimEnd(), { headCommit, check: true }),
      'Expected canonical knowledge-delta JSON',
    )
    await rejectsWith(prepareKnowledgeDelta(JSON.stringify(draft), { headCommit, check: true }), 'sourceCommit')
    const duplicate = canonical.replace('"version": 1', '"version": 2, "\\u0076ersion": 1')
    await rejectsWith(prepareKnowledgeDelta(duplicate, { headCommit }), 'Duplicate JSON key')
    await rejectsWith(prepareKnowledgeDelta(duplicate, { headCommit, check: true }), 'Duplicate JSON key')
  })

  test.each([
    ['an abbreviated SHA', headCommit.slice(0, 12)],
    ['a ref', 'refs/heads/main'],
    ['a different full SHA', 'f'.repeat(40)],
    ['an SHA containing a trailing newline', headCommit + '\n'],
  ])('rejects %s instead of overwriting it with HEAD', async (_, sourceCommit) => {
    await rejectsWith(prepare({ ...draft, sourceCommit }), 'sourceCommit', sourceCommit)
  })

  test.each([
    ['no entries', { verificationNote: note }, 'Expected at least one knowledge entry'],
    ['empty evidence', { ...draft, verificationNote: '  ' }, 'verificationNote'],
    ['empty sections', { ...draft, rules: [] }, 'rules'],
    ['wrong version', { ...draft, version: 2 }, 'version'],
    ['raw prompt field', { ...draft, prompt: 'Do not publish this text.' }, 'Unknown field(s)'],
    ['raw results field', { ...draft, acronyms: [{ ...acronym, rows: [] }] }, 'Unknown field(s)'],
  ])('rejects %s', async (_, value, reason) => {
    await rejectsWith(prepare(value), reason)
  })

  test.each([
    ['catalog credential', 'auto_ontology_' + 'x'.repeat(20), 'Possible credential'],
    ['passwordless database URL', ['postgresql:', '//db.invalid/example'].join(''), 'Possible credential'],
    ['password assignment', 'DB_PASSWORD=' + 'sample'.repeat(4), 'Possible credential'],
    ['email address', 'sample@example.invalid', 'personal data'],
    ['phone number', '(202) 555-0100', 'personal data'],
    ['copied conversation', 'System: Example transcript instruction.', 'Possible raw prompt'],
    ['prompt markup', '[INST] Example task', 'Possible raw prompt'],
  ])('rejects %s without echoing it', async (_, description, reason) => {
    await rejectsWith(prepare({ ...draft, acronyms: [{ ...acronym, description }] }), reason, description)
  })

  test('scans escaped JSON keys and text before emitting or reporting schema errors', async () => {
    const key = 'auto_ontology_' + 'x'.repeat(20)
    for (const escaped of [
      JSON.stringify({ ...draft, [key]: true }).replace(key, '\\u0061' + key.slice(1)),
      JSON.stringify({ ...draft, verificationNote: key }).replace(key, '\\u0061' + key.slice(1)),
    ]) {
      await rejectsWith(prepareKnowledgeDelta(escaped, { headCommit }), 'Possible credential', key)
    }
  })
})

describe('knowledge delta saved SQL', () => {
  test('binds an offline, read-only CTE query against the Agents migrations', async () => {
    const sql = 'WITH retained AS (SELECT id FROM public.agent_runs) SELECT count(id) FROM retained'
    expect(JSON.parse(await prepare(select(sql))).customAnalyses[0].sql).toBe(sql)
  })

  test.each([
    ['malformed query', 'SELECT id FROM', 'Invalid PostgreSQL SQL'],
    ['multiple statements', 'SELECT id FROM public.agent_runs; SELECT 1', 'Expected one read-only SELECT'],
    [
      'a write in a CTE',
      'WITH removed AS (DELETE FROM public.agent_runs RETURNING id) SELECT id FROM removed',
      'CTEs must be read-only SELECTs',
    ],
    ['a nonexistent column', 'SELECT missing_column FROM public.agent_runs', 'Schema drift'],
    [
      'escaped personal data in a literal',
      "SELECT E'person\\x40example.invalid' AS label FROM public.agent_runs",
      'Possible credential or personal data',
    ],
    [
      'escaped personal data in a CTE alias',
      'WITH retained (U&"person\\0040example.invalid") AS (SELECT id FROM public.agent_runs) SELECT count(*) FROM retained',
      'Possible credential or personal data',
    ],
  ])('rejects %s', async (_, sql, reason) => {
    await rejectsWith(prepare(select(sql)), reason, sql)
  })
})

test('CLI emits and checks an artifact accepted by the curator and repository validator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-delta-'))
  try {
    const outputDirectory = join(root, 'docs/agents/ontology')
    await mkdir(outputDirectory, { recursive: true })
    const input = join(root, 'draft.json')
    const output = join(outputDirectory, 'knowledge-delta.json')
    const run = (...args: string[]) => runCli(root, '--input', input, ...args)
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot })
    expect(head.exitCode).toBe(0)
    const sourceCommit = head.stdout.toString().trim()

    await writeFile(input, JSON.stringify({ ...draft, sourceCommit: '0'.repeat(40) }))
    expect(run('--output', output)).toMatchObject({ code: 1, stderr: expect.stringContaining('sourceCommit') })
    expect(await readdir(outputDirectory)).toEqual([])

    await writeFile(input, JSON.stringify(draft))
    expect(run('--output', output)).toMatchObject({ code: 0, stdout: 'Wrote validated knowledge delta.\n', stderr: '' })
    const canonical = await readFile(output, 'utf8')
    expect(JSON.parse(canonical).sourceCommit).toBe(sourceCommit)
    expect(runCli(root, '--check', '--input', output)).toMatchObject({
      code: 0,
      stdout: 'Validated canonical knowledge delta.\n',
      stderr: '',
    })
    expect(await validateOntologyBundles(root)).toEqual({ files: 1, errors: [] })
    const bundle = { acronyms: [], customAnalyses: [], rules: [], version: 1, dataSource: 'agents-db-next' }
    expect(mergeKnowledgeDeltas(bundle, [{ label: 'proposal', value: JSON.parse(canonical) }]).acronyms).toEqual([
      { ...acronym, provenance: { sourceCommit, verificationNote: note } },
    ])

    expect(run('--output', output)).toMatchObject({ code: 1, stderr: expect.stringContaining('must be a new path') })
    expect(await readFile(output, 'utf8')).toBe(canonical)
    expect(await readdir(outputDirectory)).toEqual(['knowledge-delta.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI failures do not write an artifact or echo payloads, filesystem paths, or argument values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-delta-'))
  try {
    const sample = 'auto_ontology_' + 'x'.repeat(20)
    const output = join(root, 'knowledge-delta.json')
    const input = join(root, 'draft.json')
    const link = join(root, 'linked.json')
    await symlink(input, link)

    await writeFile(input, JSON.stringify({ ...draft, verificationNote: sample }))
    const rejected = runCli(root, '--input', input, '--output', output)
    expect(rejected.code).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(rejected.stderr).toContain('Possible credential')
    expect(rejected.stderr).not.toContain(sample)

    const usageError = runCli(root, '--' + sample)
    expect(usageError.code).toBe(1)
    expect(usageError.stderr).toContain('Usage:')
    expect(usageError.stderr).not.toContain(sample)
    for (const path of [join(root, sample), link]) {
      const result = runCli(root, '--input', path, '--output', output)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('regular UTF-8 JSON file')
      expect(result.stderr).not.toContain(path)
    }

    await writeFile(input, '{"verificationNote":"' + sample)
    const malformed = runCli(root, '--input', input, '--output', output)
    expect(malformed.code).toBe(1)
    expect(malformed.stderr).toContain('Invalid JSON')
    expect(malformed.stderr).not.toContain(sample)

    await writeFile(input, Uint8Array.of(0xff))
    expect(runCli(root, '--input', input, '--output', output)).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('regular UTF-8 JSON file'),
    })
    expect((await readdir(root)).sort()).toEqual(['draft.json', 'linked.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const runCli = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../emit-knowledge-delta.ts'), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}
