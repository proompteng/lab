import { expect, test } from 'bun:test'
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../src/effect-test-support'
import { applyKnowledge, loadApplyConfig, ruleTagName } from './auto-ontology-api'
import { BaynKnowledge, strictKnowledge } from './auto-ontology-knowledge'

const seed = Schema.decodeUnknownSync(
  BaynKnowledge,
  strictKnowledge,
)(await Bun.file(new URL('../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url)).json())
const token = 'auto_ontology_fixture-token'
const origin = 'https://ontology.example.test'
const config = { AUTO_ONTOLOGY_API_URL: origin, AUTO_ONTOLOGY_API_TOKEN: token }
const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(config))
const page = (data: readonly unknown[]) => ({ data, count: data.length, total: data.length })

const mockCatalog = () => {
  const calls: string[] = []
  const acronyms: unknown[] = []
  const analyses: unknown[] = []
  const rules: unknown[] = []
  const handle = async (request: Request) => {
    const path = new URL(request.url).pathname
    const method = request.method
    calls.push(`${method} ${path}`)
    const write = async (rows: unknown[]) => {
      const body: unknown = await request.json()
      if (typeof body !== 'object' || body === null) throw new Error('Missing fixture object')
      const id = `id-${rows.length}`
      rows.push({ ...body, id, ...(path === '/api/rules' ? { tags: [{ id: 'canonical', name: ruleTagName }] } : {}) })
      return Response.json({ data: { id: rows.length } }, { status: 201 })
    }
    switch (path) {
      case '/api/datasources/dbs':
        return Response.json({ data: [{ id: 'bayn-db', name: 'bayn' }] })
      case '/api/schemas/bayn-db':
        return Response.json({ schemas: [{ id: 'bayn-public', schema_name: 'public' }] })
      case '/api/tags':
        return Response.json(page([{ id: 'canonical', name: ruleTagName }]))
      case '/api/acronyms':
        return method === 'GET' ? Response.json(acronyms) : write(acronyms)
      case '/api/rules':
        return method === 'GET' ? Response.json(page(rules)) : write(rules)
      case '/api/custom-analyses':
        return method === 'GET' ? Response.json(page(analyses)) : write(analyses)
      case '/api/custom-analyses/validate': {
        const { sql } = await request.json()
        return Response.json({ data: { sql, valid: true } })
      }
      default:
        throw new Error('Unexpected request in fixture')
    }
  }
  return { calls, handle }
}

const withTransport = (
  handler: (request: Request, signal: AbortSignal | null | undefined) => Response | Promise<Response>,
) => {
  const transport = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(new URL(request.url).origin).toBe(origin)
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(request.redirect).toBe('error')
      return Promise.resolve(handler(request, init?.signal))
    },
    { preconnect: fetch.preconnect },
  )
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideTestLayer(
      effect.pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
      ),
      Layer.mergeAll(FetchHttpClient.layer, provider, TestClock.layer()),
    )
}

test('apply prevalidates every changed analysis before writing and replay is a no-op', async () => {
  const { calls, handle } = mockCatalog()
  const apply = withTransport(handle)(applyKnowledge(seed))
  expect(await Effect.runPromise(apply)).toBe(seed.acronyms.length + seed.rules.length + seed.analyses.length)
  const posts = calls.filter((call) => call.startsWith('POST'))
  expect(posts.slice(0, seed.analyses.length)).toEqual(seed.analyses.map(() => 'POST /api/custom-analyses/validate'))
  expect(posts.slice(seed.analyses.length)).not.toContain('POST /api/custom-analyses/validate')
  calls.length = 0
  expect(await Effect.runPromise(apply)).toBe(0)
  expect(calls.every((call) => call.startsWith('GET'))).toBe(true)
})

test('an incomplete catalog or rejected validation stops before all writes and never reads an HTTP error body', async () => {
  const { calls, handle } = mockCatalog()
  for (const problem of ['incomplete', 'rejected', 'false']) {
    calls.length = 0
    const exit = await Effect.runPromiseExit(
      withTransport(async (request) => {
        const path = new URL(request.url).pathname
        if (problem === 'incomplete' && path === '/api/rules') return Response.json({ data: [], count: 0, total: 1 })
        if (problem !== 'incomplete' && path === '/api/custom-analyses/validate') {
          return problem === 'rejected'
            ? new Response(`Reflected credential ${token}`, { status: 422 })
            : Response.json({ data: { sql: 'SELECT 1', valid: false } })
        }
        return handle(request)
      })(applyKnowledge(seed)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).not.toContain(token)
      if (problem === 'rejected') expect(Cause.pretty(exit.cause)).toContain('Auto Ontology rejected the request')
    }
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true)
  }
})

test('invalid HTTPS origins, transport exceptions, and malformed response bodies use redacted error causes', async () => {
  for (const bad of [
    `https://user:${token}@ontology.example.test`,
    `not-an-origin-${token}`,
    'http://ontology.example.test',
  ]) {
    const exit = await Effect.runPromiseExit(
      loadApplyConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ...config, AUTO_ONTOLOGY_API_URL: bad }),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(token)
  }
  for (const error of ['transport', 'decode']) {
    const exit = await Effect.runPromiseExit(
      withTransport(() => {
        if (error === 'transport') throw new Error(`Reflected header ${token}`)
        return Response.json({ data: [{ id: `invalid/id/${token}` }] })
      })(applyKnowledge(seed)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).not.toContain(token)
      expect(JSON.stringify(exit)).not.toContain(token)
    }
  }
})

test('the HTTP deadline aborts the one in-flight request without retrying', async () => {
  const started = Promise.withResolvers<void>()
  let aborts = 0
  let requests = 0
  const run = withTransport((_request, signal) => {
    requests++
    return new Promise((_, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          aborts++
          reject(new Error('fixture aborted'))
        },
        { once: true },
      )
      started.resolve()
    })
  })
  const result = await Effect.runPromise(
    run(
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(Effect.result(applyKnowledge(seed)))
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust('20 seconds')
        return yield* Fiber.join(pending)
      }),
    ),
  )
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { operation: 'datasources/dbs', message: 'HTTP deadline exceeded; reconcile before retrying' },
  })
  expect(requests).toBe(1)
  expect(aborts).toBe(1)
})
