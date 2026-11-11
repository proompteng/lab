import { describe, expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { parseBrokerPollRetirementArgs, retireBrokerPolls } from './retire-broker-polls'

const key = 'a'.repeat(64),
  sourceRevision = 'b'.repeat(40),
  oldRevision = 'c'.repeat(40)
const input = {
  adminUrl: 'http://localhost:19072',
  controllerKey: key,
  sourceRevision,
  obsoleteSourceRevisions: [oldRevision],
  apply: false,
}
const id = 'inv_old1',
  deploymentId = 'dp_current'
const timer = { sourceRevision: oldRevision, epoch: 7, sequence: 19 }
const service = {
  name: 'BaynBrokerObservations',
  ty: 'VirtualObject',
  deployment_id: deploymentId,
  revision: 2,
  metadata: { 'bayn.source-revision': sourceRevision, 'bayn.broker-identity-hash': key },
  handlers: ['notify', 'accept', 'capture', 'freshness', 'activate', 'status'].map((name) => ({
    name,
    public: name === 'notify',
  })),
}
const invocation = {
  id,
  target_service_name: 'BaynBrokerObservations',
  target_service_key: key,
  target_handler_name: 'poll',
  status: 'paused',
  idempotency_key: `broker-observations:${oldRevision}:7:19`,
  invoked_by: 'service',
  invoked_by_service_name: 'BaynBrokerObservations',
  invoked_by_id: 'inv_parent',
}
const payload = (value: unknown) => Array.from(Buffer.from(JSON.stringify(value)))
const inputEntry = (value: unknown) => ({
  entry_type: 'Command: Input',
  entry_json: JSON.stringify({ Command: { Input: { payload: payload(value), headers: [], name: '' } } }),
})
const sendEntry = (value: unknown) => ({
  entry_type: 'Command: OneWayCall',
  entry_json: JSON.stringify({
    Command: {
      OneWayCall: {
        request: {
          invocation_id: id,
          invocation_target: {
            VirtualObject: {
              name: 'BaynBrokerObservations',
              key,
              handler: 'poll',
              handler_ty: 'Exclusive',
              scope: null,
            },
          },
          parameter: payload(value),
          idempotency_key: invocation.idempotency_key,
        },
      },
    },
  }),
})
const harness = (
  options: {
    service?: unknown
    row?: unknown
    entry?: unknown
    send?: unknown
    noInput?: boolean
    drift?: boolean
  } = {},
) => {
  const calls: Array<{ method: string; path: string }> = []
  let killed = false,
    reads = 0
  const client = HttpClient.make((request, url) => {
    calls.push({ method: request.method, path: url.pathname })
    let body: unknown
    if (url.pathname === '/services/BaynBrokerObservations')
      body = options.service ?? { ...service, revision: options.drift === true && ++reads > 1 ? 3 : 2 }
    else if (url.pathname === `/deployments/${deploymentId}`)
      body = {
        type: 'http',
        id: deploymentId,
        uri: 'http://bayn-endpoint:9080',
        services: [service, { name: 'BaynExecutionController', revision: 8, deployment_id: deploymentId }],
      }
    else if (url.pathname === `/invocations/${id}/kill`) {
      killed = true
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
    } else if (url.pathname === '/query') {
      if (request.body._tag !== 'Uint8Array') return Effect.die('expected encoded Admin query')
      const parsed: unknown = JSON.parse(Buffer.from(request.body.body).toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || !('query' in parsed) || typeof parsed.query !== 'string')
        return Effect.die('invalid query')
      const sql = parsed.query
      if (sql.includes('sys_locks')) body = { rows: killed ? [] : [{ acquired_by: id }] }
      else if (sql.includes('sys_journal') && sql.includes('OneWayCall'))
        body = { rows: options.send === undefined ? [sendEntry(timer)] : [options.send] }
      else if (sql.includes('sys_journal'))
        body = { rows: options.noInput === true ? [] : [options.entry ?? inputEntry(timer)] }
      else if (sql.includes(`WHERE id = '${id}'`))
        body = { rows: [{ ...(options.row ?? invocation), status: killed ? 'completed' : 'paused' }] }
      else body = { rows: killed ? [] : [options.row ?? invocation] }
    } else return Effect.die(`unexpected path ${url.pathname}`)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      ),
    )
  })
  const run = (apply = false) =>
    Effect.runPromiseExit(
      retireBrokerPolls({ ...input, apply }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
  return { run, calls, killed: () => killed }
}

describe('scoped obsolete broker polling retirement', () => {
  test('reports a typed HTTP failure without retaining response secrets or mutating anything', async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response('private-token', { status: 502 }))),
    )
    const exit = await Effect.runPromiseExit(
      retireBrokerPolls({ ...input, apply: true }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('HTTP 502')
    expect(JSON.stringify(exit)).not.toContain('private-token')
  })
  test('propagates defects instead of reporting a successful empty retirement', async () => {
    const client = HttpClient.make(() => Effect.die('injected Admin transport defect'))
    const exit = await Effect.runPromiseExit(
      retireBrokerPolls({ ...input, apply: true }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
  })
  test('interrupts a stalled Admin request and finalizes it once', async () => {
    let finalized = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const client = HttpClient.make(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++
              }),
            ),
          ),
        )
        const fiber = yield* retireBrokerPolls({ ...input, apply: true }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      }),
    )
    expect(finalized).toBe(1)
  })
  test('defaults to a reviewable dry run, with no cancellation, kills, state edits or SQL writes', async () => {
    const h = harness(),
      exit = await h.run()
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isFailure(exit)) return
    expect(exit.value).toMatchObject({
      apply: false,
      deploymentId,
      serviceRevision: 2,
      candidates: [{ id, ...timer }],
      retired: [],
    })
    expect(h.killed()).toBe(false)
    expect(h.calls.every((call) => call.method === 'GET' || call.path === '/query')).toBe(true)
  })
  test('uses the supported exact caller journal send when a scheduled input is not retained yet', async () => {
    const h = harness({ noInput: true })
    const exit = await h.run()
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test('explicit apply kills only the proved invocation ID and verifies its lock is gone', async () => {
    const h = harness(),
      exit = await h.run(true)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isFailure(exit)) return
    expect(exit.value.retired).toEqual([id])
    expect(h.calls.filter((call) => call.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: `/invocations/${id}/kill` },
    ])
  })
  test.each([
    ['source', { ...service, metadata: { ...service.metadata, 'bayn.source-revision': 'd'.repeat(40) } }],
    ['account', { ...service, metadata: { ...service.metadata, 'bayn.broker-identity-hash': 'd'.repeat(64) } }],
    ['legacy handler', { ...service, handlers: [...service.handlers, { name: 'poll', public: false }] }],
    ['public capture', { ...service, handlers: service.handlers.map((handler) => ({ ...handler, public: true })) }],
  ] as const)('refuses current remote %s drift before mutations', async (_name, current) => {
    const h = harness({ service: current })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test.each([
    ['financial tick', { ...invocation, target_service_name: 'BaynExecutionController', target_handler_name: 'tick' }],
    ['inference', { ...invocation, target_service_name: 'BaynEntryInference', target_handler_name: 'evaluate' }],
    ['capture', { ...invocation, target_handler_name: 'capture' }],
    ['another account', { ...invocation, target_service_key: 'd'.repeat(64) }],
    ['scoped object', { ...invocation, scope: 'unexpected' }],
    ['external request', { ...invocation, invoked_by: 'ingress' }],
    ['unknown timer label', { ...invocation, idempotency_key: 'untrusted' }],
  ] as const)('refuses unexpected %s evidence even if an Admin query returns it', async (_name, row) => {
    const h = harness({ row })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test.each([
    ['current source', { ...timer, sourceRevision }],
    ['unknown source', { ...timer, sourceRevision: 'e'.repeat(40) }],
    ['sequence disagreement', { ...timer, sequence: 20 }],
    ['extra payload fields', { ...timer, arbitrary: true }],
  ] as const)('refuses %s payloads', async (_name, tick) => {
    const h = harness({ entry: inputEntry(tick) })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test('refuses absent source evidence without guessing from an invocation label', async () => {
    const h = harness({ noInput: true, send: { entry_type: 'Command: OneWayCall', entry_json: null } })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test('refuses an unknown source even when its payload and timer label agree', async () => {
    const unknownSource = 'e'.repeat(40)
    const h = harness({
      row: { ...invocation, idempotency_key: `broker-observations:${unknownSource}:7:19` },
      entry: inputEntry({ ...timer, sourceRevision: unknownSource }),
    })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test('refuses a registration that changes between planning and apply', async () => {
    const h = harness({ drift: true })
    expect(Exit.isFailure(await h.run(true))).toBe(true)
    expect(h.killed()).toBe(false)
  })
  test('parses explicit target arguments with opt-in apply only', () => {
    const args = [
      '--admin-url',
      input.adminUrl,
      '--controller-key',
      key,
      '--source-revision',
      sourceRevision,
      '--obsolete-source-revisions',
      oldRevision,
    ]
    expect(Result.getOrThrow(parseBrokerPollRetirementArgs(args))).toEqual(input)
    expect(Result.getOrThrow(parseBrokerPollRetirementArgs([...args, '--apply']))).toEqual({ ...input, apply: true })
    expect(Result.isFailure(parseBrokerPollRetirementArgs([...args, '--force']))).toBe(true)
  })
})
