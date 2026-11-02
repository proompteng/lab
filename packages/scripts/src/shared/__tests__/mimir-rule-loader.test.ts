import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const manifest = new URL(
  '../../../../../argocd/applications/observability/observability-mimir-rule-loader.yaml',
  import.meta.url,
)
const loader: unknown = YAML.parseAllDocuments(readFileSync(manifest, 'utf8'))[0]?.getIn(['data', 'load-rules.sh'])
if (typeof loader !== 'string') throw new Error('Mimir rule loader script is missing')

test.each([0, 2, 4, 8])('prunes stale groups with %i-space Mimir YAML indentation', async (indentation) => {
  const directory = mkdtempSync(join(tmpdir(), 'mimir-rule-loader-'))
  const script = join(directory, 'load-rules.sh')
  const rules = join(directory, 'rules.yaml')
  const requests: string[] = []
  let uploaded = ''
  const stale = ['torghut-clickhouse.guardrails.rules', 'torghut-freshness.rules']
  const prefix = ' '.repeat(indentation)
  const current = `lab:\n${['retained.rules', ...stale].map((name) => `${prefix}- name: ${name}\n${prefix}  rules: []`).join('\n')}\n`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('X-Scope-OrgID') !== 'test-tenant') return new Response('wrong tenant', { status: 401 })
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      if (request.method === 'GET') return new Response(current)
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      if (request.method === 'POST') {
        uploaded = await request.text()
        return new Response(null, { status: 202 })
      }
      return new Response(null, { status: 405 })
    },
  })
  try {
    writeFileSync(script, loader)
    writeFileSync(
      rules,
      'groups:\n  - name: retained.rules\n    rules:\n      - record: retained:up\n        expr: vector(1)\n',
    )
    const child = Bun.spawn(['sh', script], {
      env: {
        ...process.env,
        RULES_FILE: rules,
        MIMIR_TENANT_ID: 'test-tenant',
        MIMIR_RULER_URL: `http://127.0.0.1:${server.port}/rules/lab`,
        TMPDIR: directory,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(requests).toEqual([
      'GET /rules/lab',
      ...stale.map((group) => `DELETE /rules/lab/${group}`),
      'POST /rules/lab',
    ])
    expect(YAML.parse(uploaded)).toEqual({
      name: 'retained.rules',
      rules: [{ record: 'retained:up', expr: 'vector(1)' }],
    })
    expect(stdout).toContain('uploaded')
  } finally {
    await server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
})
