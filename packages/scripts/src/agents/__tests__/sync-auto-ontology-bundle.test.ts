import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncBundle } from '../sync-auto-ontology-bundle'
import { prepareBundle } from '../sync-auto-ontology-bundle-core'

const externalOrigin = 'https://auto-ontology.ide-newton.ts.net'
const internalOrigin = 'http://frontend.auto-ontology.svc.cluster.local:3000'
const token = 'auto_ontology_synthetic_test_only'
const env = { AUTO_ONTOLOGY_API_URL: externalOrigin, AUTO_ONTOLOGY_API_TOKEN: token }

const fixture = (dataSource = 'example') => ({
  version: 1,
  dataSource,
  acronyms: [{ name: `${dataSource} CLI`, description: 'Command-line interface' }],
  rules: [{ name: 'Review', description: 'Review changes', searchTerm: 'audit' }],
  customAnalyses: [
    {
      name: `${dataSource} daily totals`,
      description: 'Daily totals',
      sql: `SELECT COUNT(*) FROM ${dataSource}.${dataSource}_audit.events`,
    },
  ],
})

type Row = Record<string, unknown> & { id: string }
const page = (data: Row[]) => ({ data, count: data.length, total: data.length })
const pathOf = (resource: string) => `/api/${resource}`

const mockCatalog = () => {
  const catalog: Record<string, Row[]> = { acronyms: [], rules: [], 'custom-analyses': [] }
  const databases = [
    { name: 'example', id: 'db-1' },
    { name: 'second', id: 'db-2' },
  ]
  const tags: Row[] = [
    { name: 'example canonical rule', id: 'tag-1' },
    { name: 'second canonical rule', id: 'tag-2' },
  ]
  const schemas = {
    'db-1': [{ schema_name: 'example_audit', id: 'schema-1' }],
    'db-2': [{ schema_name: 'second_audit', id: 'schema-2' }],
  }
  const tables = {
    'schema-1': [{ name: 'events', id: 'table-1' }],
    'schema-2': [{ name: 'events', id: 'table-2' }],
  }
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  let validation: (sql: unknown) => Response = (sql) => Response.json({ data: { valid: true, sql } })
  const fetch = async (url: string, init: RequestInit) => {
    const { origin, pathname: path } = new URL(url)
    expect([externalOrigin, internalOrigin]).toContain(origin)
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe(token)
    expect(headers.has('authorization')).toBe(false)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const method = init.method ?? 'GET'
    calls.push({ path, method, body })
    if (path === pathOf('datasources/dbs')) return Response.json(page(databases))
    if (path === pathOf('tags')) return Response.json(page(tags))
    if (path === pathOf('custom-analyses/validate')) return validation(body?.sql)
    const [, , resource, id] = path.split('/')
    if (resource === 'schemas' && (id === 'db-1' || id === 'db-2')) {
      return Response.json({ schemas: schemas[id], schemas_count: schemas[id].length })
    }
    if (resource === 'tables' && (id === 'schema-1' || id === 'schema-2')) {
      expect(new URL(url).searchParams.get('database_name')).toBe(databases[id === 'schema-1' ? 0 : 1].name)
      return Response.json(page(tables[id]))
    }
    const rows = resource && catalog[resource]
    if (!rows) throw new Error('Unexpected endpoint')
    if (method === 'GET') return Response.json(resource === 'acronyms' ? rows : page(rows))
    if (method === 'POST') {
      const references = body?.tags
      const tagsOnRule =
        resource === 'rules' && Array.isArray(references)
          ? tags.filter((tag) => references.some((reference: Row) => reference.id === tag.id))
          : undefined
      rows.push({ ...body, id: `${resource}-${rows.length + 1}`, ...(tagsOnRule && { tags: tagsOnRule }) })
      return new Response(null, { status: 201 })
    }
    const row = rows.find((row) => row.id === id)
    if (!row) throw new Error('Unexpected update')
    Object.assign(row, body)
    return new Response(null, { status: 200 })
  }
  return {
    catalog,
    databases,
    tags,
    schemas,
    tables,
    calls,
    fetch,
    setValidation: (handler: typeof validation) => {
      validation = handler
    },
  }
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ontology-sync-test-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const writeBundle = async (input: unknown) => {
  const path = join(dir, `${crypto.randomUUID()}.json`)
  await Bun.write(path, JSON.stringify(input))
  return ['--bundle', path]
}

describe('ontology bundle preflight', () => {
  test('validates the checked-in Agents bundle offline without credentials or network', async () => {
    const path = new URL('../../../../../docs/agents/ontology/agents-knowledge.json', import.meta.url).pathname
    const fetch = () => Promise.reject(new Error('must not call fetch'))
    const result = await syncBundle(['--bundle', path], {}, fetch)
    expect(result).toMatchObject({ mode: 'dry-run', writes: 0 })
    expect(result.customAnalyses).toBeGreaterThan(0)
    const input: unknown = await Bun.file(path).json()
    expect((await prepareBundle(input, true)).database).toBe('agents')
  })

  test('matches CTE sources in their scope and accepts read-only subqueries and a trailing semicolon', async () => {
    const data = fixture()
    data.customAnalyses[0].sql =
      'WITH events AS (SELECT id FROM example.example_audit.events) SELECT COUNT(*) FROM (SELECT id FROM events) sub;'
    expect((await prepareBundle(data, true)).database).toBe('example')
  })

  test.each([
    'ALTER TABLE example.example_audit.events ADD COLUMN bogus text',
    'SELECT 1; UPDATE example.example_audit.events SET id = 0',
    'WITH writes AS (DELETE FROM example.example_audit.events RETURNING id) SELECT id FROM writes',
    'SELECT n FROM (WITH writes AS (INSERT INTO example.example_audit.events VALUES (1) RETURNING id) SELECT id FROM writes) AS n',
    'SELECT id INTO example.example_audit.copy FROM example.example_audit.events',
    'SELECT id FROM example.example_audit.events FOR NO KEY UPDATE',
    "SELECT set_config('search_path', 'public', false)",
    'SELECT "pg_catalog"."nextval"(\'sequence\')',
    'SELECT public.count(id) FROM example.example_audit.events',
    'SELECT 1::public.custom_type',
    'SELECT 1 OPERATOR(public.+) 2',
    'SELECT * FROM example.example_audit.events',
    'SELECT password_hash FROM example.example_audit.accounts',
    'SELECT session_id FROM example.example_audit.access_tokens',
    'SELECT id FROM pg_catalog.pg_roles',
    'SELECT id FROM wrong_db.audit.events',
    'SELECT id FROM unqualified_table',
  ])('rejects SQL outside the read-only subset: %s', async (sql) => {
    const data = fixture()
    data.customAnalyses[0].sql = sql
    await rejects(prepareBundle(data, false), { message: /^customAnalyses\[0\]/ })
  })

  test('requires a catalogued relation for apply before sending credentials', async () => {
    const data = fixture()
    data.customAnalyses[0].sql = 'SELECT 1'
    const args = await writeBundle(data)
    const mock = mockCatalog()
    expect((await syncBundle(args, {}, mock.fetch)).writes).toBe(0)
    await rejects(syncBundle([...args, '--mode', 'apply'], env, mock.fetch), {
      message: /Apply requires a catalogued relation/,
    })
    expect(mock.calls).toEqual([])
  })

  test.each([
    { ...fixture(), unknownField: token },
    { ...fixture(), acronyms: [{ name: token, description: 'test' }] },
    { ...fixture(), rules: [{ name: 'test', description: 'password=synthetic-credential' }] },
    { ...fixture(), rules: [{ name: 'test', description: 'AUTO_ONTOLOGY_API_TOKEN=synthetic-credential' }] },
    {
      ...fixture(),
      customAnalyses: [{ name: 'test', description: 'test', sql: "SELECT 'postgres://u:synthetic@db.local/agents'" }],
    },
    {
      ...fixture(),
      customAnalyses: [{ name: 'test', description: 'test', sql: "SELECT E'\\x61uto_ontology_synthetic_test_only'" }],
    },
    {
      ...fixture(),
      acronyms: [{ name: 'id', description: 'test', provenance: { sourceCommit: 'abcd123', verificationNote: token } }],
    },
    {
      ...fixture(),
      rules: [
        { name: 'Review', description: 'one' },
        { name: 'review', description: 'two' },
      ],
    },
    { ...fixture(), customAnalyses: [fixture().customAnalyses[0], { ...fixture().customAnalyses[0], name: 'Other' }] },
  ])('rejects unsafe, unknown or duplicate bundle content before network', async (input) => {
    const mock = mockCatalog()
    const args = await writeBundle(input)
    try {
      await syncBundle([...args, '--mode', 'apply'], env, mock.fetch)
      throw new Error('Accepted invalid bundle')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toMatch(/Invalid bundle|Duplicate|Possible credential/)
      expect(message).not.toMatch(/synthetic|unknownField/)
    }
    expect(mock.calls).toEqual([])
  })

  test('fails closed on invalid JSON or ambiguous CLI mode flags', async () => {
    const args = await writeBundle(fixture())
    const path = join(dir, 'invalid.json')
    await Bun.write(path, token)
    const mock = mockCatalog()
    await rejects(syncBundle(['--bundle', path], {}, mock.fetch), {
      message: 'Could not read a JSON bundle from --bundle',
    })
    await rejects(syncBundle([...args, '--mode', 'dry-run', '--mode', 'apply'], env, mock.fetch), {
      message: /dry-run\|apply/,
    })
    expect(mock.calls).toEqual([])
  })
})

describe('Auto Ontology apply', () => {
  test('prevalidates analyses before creates, updates only changed rows, and replays without writes', async () => {
    const mock = mockCatalog()
    const data = fixture()
    const args = [...(await writeBundle(data)), '--mode', 'apply']
    expect((await syncBundle(args, env, mock.fetch)).writes).toBe(3)
    expect(mock.calls.filter(({ method }) => method === 'POST').map(({ path }) => path)).toEqual([
      '/api/custom-analyses/validate',
      '/api/acronyms',
      '/api/rules',
      '/api/custom-analyses',
    ])
    expect(mock.catalog.rules).toEqual([
      expect.objectContaining({
        name: 'example ["Review"]: Review changes',
        search_term: 'audit',
        filters: { data: ['db-1'], description: false, synonyms: false },
      }),
    ])
    mock.calls.length = 0
    expect((await syncBundle(args, env, mock.fetch)).writes).toBe(0)
    expect(mock.calls.every(({ method }) => method === 'GET')).toBe(true)

    data.acronyms[0].description = 'Updated acronym'
    data.rules[0].description = 'Review updated changes'
    data.customAnalyses[0].sql += ' WHERE id > 1'
    mock.calls.length = 0
    const updated = [...(await writeBundle(data)), '--mode', 'apply']
    expect((await syncBundle(updated, env, mock.fetch)).writes).toBe(3)
    expect(mock.calls.filter(({ method }) => method !== 'GET')).toEqual([
      { path: '/api/custom-analyses/validate', method: 'POST', body: { sql: data.customAnalyses[0].sql } },
      { path: '/api/acronyms/acronyms-1', method: 'PATCH', body: data.acronyms[0] },
      { path: '/api/rules/rules-1', method: 'PATCH', body: { name: 'example ["Review"]: Review updated changes' } },
      { path: '/api/custom-analyses/custom-analyses-1', method: 'PUT', body: data.customAnalyses[0] },
    ])
    expect((await syncBundle(updated, env, mock.fetch)).writes).toBe(0)
  })

  test('supports a different bundle without renaming rules from the first source', async () => {
    const mock = mockCatalog()
    const args = [...(await writeBundle(fixture())), '--mode', 'apply']
    await syncBundle(args, env, mock.fetch)
    const second = fixture('second')
    const secondArgs = [...(await writeBundle(second)), '--mode', 'apply']
    expect((await syncBundle(secondArgs, { ...env, AUTO_ONTOLOGY_API_URL: internalOrigin }, mock.fetch)).writes).toBe(3)
    expect(mock.catalog.rules?.map(({ name, filters }) => ({ name, filters }))).toEqual([
      { name: 'example ["Review"]: Review changes', filters: { data: ['db-1'], description: false, synonyms: false } },
      { name: 'second ["Review"]: Review changes', filters: { data: ['db-2'], description: false, synonyms: false } },
    ])
    expect((await syncBundle(args, env, mock.fetch)).writes).toBe(0)
  })

  test('keeps provenance local and supports an explicit catalog database name', async () => {
    const mock = mockCatalog()
    const data = fixture()
    mock.databases[0].name = 'actual'
    data.customAnalyses[0].sql = 'SELECT COUNT(*) FROM example_audit.events'
    const input = {
      ...data,
      database: 'actual',
      acronyms: [{ ...data.acronyms[0], provenance: { sourceCommit: 'abcdef1', verificationNote: 'Checked source' } }],
    }
    const args = [...(await writeBundle(input)), '--mode', 'apply']
    expect((await syncBundle(args, env, mock.fetch)).writes).toBe(3)
    expect(mock.catalog.acronyms).toEqual([{ ...data.acronyms[0], id: 'acronyms-1' }])
  })

  test.each(['reject', 'changed sql', 'non-JSON', 'HTTP 422'])(
    'validation %s prevents all catalog writes',
    async (failure) => {
      const mock = mockCatalog()
      const data = fixture()
      data.customAnalyses.push({
        name: 'Second analysis',
        description: 'test',
        sql: 'SELECT id FROM example.example_audit.events',
      })
      mock.setValidation((sql) =>
        sql === data.customAnalyses[0].sql
          ? Response.json({ data: { valid: true, sql } })
          : failure === 'HTTP 422'
            ? new Response(token, { status: 422 })
            : failure === 'non-JSON'
              ? new Response(token)
              : Response.json({ data: { valid: failure === 'changed sql', sql: token } }),
      )
      const args = [...(await writeBundle(data)), '--mode', 'apply']
      await rejects(syncBundle(args, env, mock.fetch), { message: /^custom-analyses\/validate:/ })
      expect(mock.calls.filter(({ method }) => method !== 'GET').map(({ path }) => path)).toEqual([
        '/api/custom-analyses/validate',
        '/api/custom-analyses/validate',
      ])
      expect(mock.catalog).toEqual({ acronyms: [], rules: [], 'custom-analyses': [] })
    },
  )

  test.each(['search', 'scope', 'tag'])(
    'immutable rule %s drift fails closed before writing other changes',
    async (kind) => {
      const mock = mockCatalog()
      const data = fixture()
      const args = [...(await writeBundle(data)), '--mode', 'apply']
      await syncBundle(args, env, mock.fetch)
      const rule = mock.catalog.rules?.[0]
      if (rule === undefined) throw new Error('Missing rule fixture')
      if (kind === 'search') rule.search_term = 'unrelated'
      if (kind === 'scope') rule.filters = { data: ['db-2'], description: false, synonyms: false }
      if (kind === 'tag') rule.tags = [mock.tags[1]]
      mock.calls.length = 0
      data.acronyms[0].description = 'Changed'
      await rejects(syncBundle([...(await writeBundle(data)), '--mode', 'apply'], env, mock.fetch), {
        message: /rule has search, scope or tag drift/,
      })
      expect(mock.calls.every(({ method }) => method === 'GET')).toBe(true)
    },
  )

  test('rejects ambiguous or incomplete catalog reads instead of creating duplicates', async () => {
    const mock = mockCatalog()
    const args = [...(await writeBundle(fixture())), '--mode', 'apply']
    mock.catalog.acronyms?.push(
      { id: '1', name: 'example CLI', description: '' },
      { id: '2', name: 'example cli', description: '' },
    )
    await rejects(syncBundle(args, env, mock.fetch), { message: /Ambiguous catalog identity/ })
    const fetch = (url: string, init: RequestInit) =>
      url.endsWith('/api/rules')
        ? Promise.resolve(Response.json({ data: [], count: 0, total: 2 }))
        : mock.fetch(url, init)
    await rejects(syncBundle(args, env, fetch), { message: 'rules: invalid Auto Ontology response' })
    expect(mock.calls.every(({ method }) => method === 'GET')).toBe(true)
  })

  test('rejects duplicate schema names even for database-qualified SQL', async () => {
    const mock = mockCatalog()
    mock.schemas['db-2'][0].schema_name = 'example_audit'
    const args = [...(await writeBundle(fixture())), '--mode', 'apply']
    await rejects(syncBundle(args, env, mock.fetch), { message: /Referenced schema is missing or ambiguous/ })
    expect(mock.calls.every(({ method }) => method === 'GET')).toBe(true)
  })

  test('rejects a query if any joined relation is absent from the selected catalog', async () => {
    const mock = mockCatalog()
    const data = fixture()
    data.customAnalyses[0].sql += ' CROSS JOIN example.example_audit.missing'
    const args = [...(await writeBundle(data)), '--mode', 'apply']
    await rejects(syncBundle(args, env, mock.fetch), { message: /Referenced relation is missing/ })
    expect(mock.calls.every(({ method }) => method === 'GET')).toBe(true)
  })

  test.each([
    {},
    { ...env, AUTO_ONTOLOGY_API_TOKEN: '' },
    { ...env, AUTO_ONTOLOGY_API_TOKEN: `${token}\r\nX-Foo: hi` },
    { ...env, AUTO_ONTOLOGY_API_URL: `https://user:${token}@auto-ontology.ide-newton.ts.net` },
    { ...env, AUTO_ONTOLOGY_API_URL: `${externalOrigin}/?token=${token}` },
    { ...env, AUTO_ONTOLOGY_API_URL: 'http://backend.auto-ontology.svc.cluster.local:3001' },
    { ...env, AUTO_ONTOLOGY_API_URL: 'https://wrong.example' },
  ])('does not call fetch with missing or unsafe API configuration', async (configuration) => {
    const mock = mockCatalog()
    const args = [...(await writeBundle(fixture())), '--mode', 'apply']
    await rejects(syncBundle(args, configuration, mock.fetch), { message: /^Set AUTO_ONTOLOGY_API_/ })
    expect(mock.calls).toEqual([])
  })

  test('redacts transport and response secrets and does not retry a failed write', async () => {
    const args = [...(await writeBundle(fixture())), '--mode', 'apply']
    const mock = mockCatalog()
    await rejects(
      syncBundle(args, env, () => Promise.reject(new Error(token))),
      { message: 'datasources/dbs: Auto Ontology request failed; reconcile before retrying' },
    )
    let attempts = 0
    const fetch = (url: string, init: RequestInit) => {
      if (url.endsWith('/api/acronyms') && init.method === 'POST') {
        attempts += 1
        return Promise.resolve(new Response(token, { status: 409 }))
      }
      return mock.fetch(url, init)
    }
    await rejects(syncBundle(args, env, fetch), {
      message: 'acronyms: Auto Ontology returned HTTP 409; reconcile before retrying',
    })
    expect(attempts).toBe(1)
    expect(mock.catalog).toEqual({ acronyms: [], rules: [], 'custom-analyses': [] })
  })
})
