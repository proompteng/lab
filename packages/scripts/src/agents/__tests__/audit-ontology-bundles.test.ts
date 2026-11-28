import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { auditOntologyBundles } from '../audit-ontology-bundles-core'

const agents = 'docs/agents/ontology/agents-knowledge.json'
const bayn = 'docs/bayn/ontology/bayn-knowledge.json'
const cluster = 'docs/cluster/nested/ontology/cluster-knowledge.json'
const cli = join(import.meta.dir, '../audit-ontology-bundles.ts')
const source = (path: string) => `https://github.com/proompteng/lab/blob/${'a'.repeat(40)}/${path}`
const bundle = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  acronyms: [],
  rules: [],
  customAnalyses: [],
  ...overrides,
})
const baynBundle = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'bayn.ontology.knowledge.v1',
  acronyms: [],
  rules: [],
  analyses: [],
  ...overrides,
})

let workspace: string
let root: string
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ontology-audit-'))
  root = join(workspace, 'checkout')
  await mkdir(root)
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const put = async (path: string, content: string | Uint8Array) => {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
const json = (path: string, value: unknown) => put(path, JSON.stringify(value))
const runCli = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', cli, ...args], { cwd: workspace })

test('discovers nested bundles and groups name/alias and alias/alias matches across files only', async () => {
  await json(
    agents,
    bundle({ acronyms: [{ name: 'CNPG', aliases: ['Read Replica', 'same-bundle'] }, { name: 'SAME-BUNDLE' }] }),
  )
  await json(bayn, baynBundle({ acronyms: [{ name: 'replica', aliases: [' read replica ', 'cnpg'] }] }))
  await json(cluster, bundle({ acronyms: [{ name: 'CnPg' }] }))
  for (const ignored of [
    'docs/agents/ontology/knowledge-delta.json',
    'docs/agents/spec/agents-knowledge.json',
    'external/ontology/external-knowledge.json',
  ]) {
    await put(ignored, 'not JSON')
  }

  expect(await auditOntologyBundles(root)).toEqual({
    bundles: [agents, bayn, cluster],
    findings: [
      {
        code: 'acronym-collision',
        locations: [
          { bundle: 0, path: '$.acronyms[0].name' },
          { bundle: 1, path: '$.acronyms[0].aliases[1]' },
          { bundle: 2, path: '$.acronyms[0].name' },
        ],
      },
      {
        code: 'acronym-collision',
        locations: [
          { bundle: 0, path: '$.acronyms[0].aliases[0]' },
          { bundle: 1, path: '$.acronyms[0].aliases[0]' },
        ],
      },
    ],
  })
  expect((await auditOntologyBundles(root, [agents, `./${agents}`, join(root, agents)])).findings).toEqual([])
})

test('checks repo file citations without fetching remote links or requiring an old ref checkout', async () => {
  await put('AGENTS.md', '')
  await put('docs/live.md', '')
  await put('docs/with space.md', '')
  await put('tools/launch', '')
  await mkdir(join(root, 'docs/directory.md'))
  await put('../external.md', '')
  await symlink(join(workspace, 'external.md'), join(root, 'docs/escaped.md'))
  await symlink('live.md', join(root, 'docs/linked.md'))
  await json(
    agents,
    bundle({
      rules: [
        { description: 'Read AGENTS.md, docs/live.md:2-3, and `docs/removed.md`.' },
        {
          description: 'See [the guide](./docs/linked.md#info) and [stale](docs/archive.md#topic).',
          provenance: { verificationNote: 'Checked docs/previous.md.' },
          evidence: [{ path: 'docs/with space.md' }, { path: 'missing path.md' }, 'tools/launch', 'tools/deleted'],
        },
      ],
    }),
  )
  await json(
    bayn,
    baynBundle({
      rules: [
        {
          sources: [
            source('docs/with%20space.md#L2-L3'),
            source('docs/deleted.ts#L1'),
            source('docs/directory.md'),
            source('docs/escaped.md'),
            source('%2E%2E/external.md'),
            'https://github.com/proompteng/lab/pull/1',
            'https://github.com/another/repo/blob/main/docs/deleted.ts',
          ],
        },
      ],
      acronyms: [{ name: 'Pod', sources: [source('docs/old.md')] }],
    }),
  )

  const { findings } = await auditOntologyBundles(root)
  expect(findings.map(({ code }) => code)).toEqual(Array(10).fill('citation-drift'))
  expect(findings.flatMap(({ locations }) => locations.map(({ path }) => path))).toEqual([
    '$.rules[0].description',
    '$.rules[1].description',
    '$.rules[1].provenance.verificationNote',
    '$.rules[1].evidence[1].path',
    '$.rules[1].evidence[3]',
    '$.acronyms[0].sources[0]',
    '$.rules[0].sources[1]',
    '$.rules[0].sources[2]',
    '$.rules[0].sources[3]',
    '$.rules[0].sources[4]',
  ])
  expect(findings[0].locations[0].offset).toBe('Read AGENTS.md, docs/live.md:2-3, and `'.length + 1)
})

test('rejects mutating and unsupported SQL in both analysis formats but accepts read-only CTEs', async () => {
  await json(
    agents,
    bundle({
      customAnalyses: [
        { sql: 'WITH changes AS (DELETE FROM entries RETURNING id) SELECT id FROM changes' },
        { sql: 'SELECT id INTO archive FROM entries' },
        { sql: 'SELECT id FROM entries FOR UPDATE' },
        { sql: 'SELECT id FROM entries; SELECT 2' },
        { sql: "SELECT nextval('counter')" },
        { sql: "WITH entries AS (SELECT 'DELETE FROM entries' AS label) SELECT label FROM entries" },
      ],
    }),
  )
  await json(
    bayn,
    baynBundle({ analyses: [{ sql: 'UPDATE entries SET id = 1' }, { sql: 'SELECT count(*) FROM entries' }] }),
  )

  const { findings } = await auditOntologyBundles(root)
  expect(findings).toEqual([
    ...Array.from({ length: 5 }, (_, index) => ({
      code: 'unsafe-sql',
      locations: [{ bundle: 0, path: `$.customAnalyses[${index}].sql` }],
    })),
    { code: 'unsafe-sql', locations: [{ bundle: 1, path: '$.analyses[0].sql' }] },
  ])
})

test('keeps synthetic credentials out of filenames, field names, collision values, SQL, and CLI errors', async () => {
  const token = `ghp_${'fake'.repeat(9)}`
  const opaque = 'opaque-fixture-value'
  const auth = `Bearer ${'auth-fixture'.repeat(3)}`
  const dsn = ['postgresql:', '//', 'db.invalid/test'].join('')
  const decoded = `auto_ontology_${'fixture'.repeat(2)}`
  const labeled = `docs/private/ontology/${token}-knowledge.json`
  await json(
    agents,
    bundle({
      acronyms: [{ name: 'Safe', aliases: [opaque] }],
      rules: [
        { description: `password=${opaque}`, evidence: { apiKey: opaque, [token]: 'example', endpoint: dsn, auth } },
        { description: 'Print only authorization: Bearer [REDACTED] and x-api-key=$REDACTED.' },
      ],
      customAnalyses: [{ sql: String.raw`SELECT E'\x61${decoded.slice(1)}'` }],
      other: { clientSecret: '[REDACTED]', authorization: 'Bearer <redacted>' },
    }),
  )
  await json(bayn, baynBundle({ acronyms: [{ name: opaque }] }))
  await put(labeled, `{"broken": ${token}`)

  const report = await auditOntologyBundles(root)
  expect(report.bundles).toEqual([agents, bayn, '[redacted bundle path]'])
  expect(
    report.findings.filter(({ code }) => code === 'possible-secret').flatMap(({ locations }) => locations),
  ).toEqual([
    { bundle: 0, path: '$.rules[0].description' },
    { bundle: 0, path: '$.rules[0].evidence{#1}' },
    { bundle: 0, path: '$.rules[0].evidence{#2}' },
    { bundle: 0, path: '$.rules[0].evidence{#3}' },
    { bundle: 0, path: '$.rules[0].evidence{#4}' },
    { bundle: 0, path: '$.customAnalyses[0].sql' },
  ])
  const runs = [
    runCli('--root', root, '--format', 'json'),
    runCli('--root', root, '--format', 'markdown'),
    runCli('--root', root, '--format', token),
    runCli('--root', join(root, token)),
  ]
  expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 2, 2])
  for (const run of runs) {
    const output = run.stdout.toString() + run.stderr.toString()
    expect([token, opaque, auth, dsn, decoded, root].every((text) => !output.includes(text))).toBe(true)
  }
})

test('reports bad inputs individually and continues auditing the other bundles', async () => {
  await put(agents, '{')
  await put(bayn, Uint8Array.of(0xff))
  await json(cluster, bundle({ acronyms: [{ name: 'Valid', aliases: 'not an array' }], customAnalyses: [{}] }))
  await put('../outside.json', JSON.stringify(bundle()))
  await symlink(join(workspace, 'outside.json'), join(root, 'linked.json'))

  const { findings } = await auditOntologyBundles(root, [agents, bayn, cluster, '../outside.json', 'linked.json'])
  expect(findings.map(({ code, locations }) => [code, locations[0].path])).toEqual([
    ['bundle-read-error', '$'],
    ['invalid-json', '$'],
    ['bundle-read-error', '$'],
    ['invalid-bundle', '$.acronyms[0].aliases'],
    ['invalid-bundle', '$.customAnalyses[0].sql'],
    ['bundle-read-error', '$'],
  ])
})

test('rejects ambiguous JSON that could hide evidence or SQL behind a duplicate key', async () => {
  await put(
    agents,
    String.raw`{"version":1,"acronyms":[],"rules":[],"customAnalyses":[{"sql":"DELETE FROM entries","\u0073ql":"SELECT 1"}]}`,
  )
  expect((await auditOntologyBundles(root)).findings).toEqual([
    { code: 'invalid-json', locations: [{ bundle: 0, path: '$' }] },
  ])
})

test('CLI honors explicit bundles, deterministic formats, and opt-in failure', async () => {
  await put(agents, 'excluded from explicit audit')
  const a = 'fixtures/a.json'
  const b = 'fixtures/b.json'
  await json(a, bundle({ acronyms: [{ name: 'CRI' }] }))
  await json(b, bundle({ acronyms: [{ name: 'cri' }] }))
  const before = await readFile(join(root, a), 'utf8')
  for (const format of ['json', 'markdown']) {
    const first = runCli('--root', 'checkout', '--bundles', b, a, '--format', format)
    const second = runCli(
      '--bundles',
      join(root, a),
      b,
      `./${b}`,
      '--root',
      root,
      '--format',
      format,
      '--fail-on-error',
    )
    expect([first.exitCode, second.exitCode]).toEqual([0, 1])
    expect(first.stdout.toString()).toEqual(second.stdout.toString())
    expect(first.stdout.toString()).toContain('acronym-collision')
    expect(first.stdout.toString()).not.toContain(agents)
    expect(first.stderr.toString() + second.stderr.toString()).toBe('')
  }
  expect(runCli('--root', root, '--bundles', a, '--fail-on-error').exitCode).toBe(0)
  expect(await readFile(join(root, a), 'utf8')).toBe(before)
  expect(runCli('--bundles').exitCode).toBe(2)
  expect(runCli(a).exitCode).toBe(2)
})

test('empty roots have no findings', async () => {
  expect(await auditOntologyBundles(root)).toEqual({ bundles: [], findings: [] })
  const result = runCli('--root', root, '--fail-on-error')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('No bundles found.')
})
