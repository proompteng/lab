import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import { ColabError } from './errors'
import {
  createColabRuntimePolicy,
  isOwnedRuntimeName,
  isOwnedSessionName,
  isOwnedSessionOrRuntimeRef,
  ownerPrefix,
  scopeRuntimeId,
} from './policy'
import type { ColabUpstream, UpstreamContext } from './upstream'

const runA = 'agents/run-alpha'
const runB = 'agents/run-beta'
const prefixA = ownerPrefix(runA)
const prefixB = ownerPrefix(runB)
const context = (): UpstreamContext => ({ signal: new AbortController().signal })

const mockUpstream = (
  handler: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult,
) => {
  const getToken = vi.fn(async () => 'oauth-token')
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => handler(name, args))
  const upstream = {
    initialize: vi.fn(),
    listTools: vi.fn(),
    getToken,
    callTool,
  } as unknown as ColabUpstream
  return { upstream, getToken, callTool }
}

const expectColabError = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise
    expect.unreachable(`Expected ColabError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(ColabError)
    expect((error as ColabError).code).toBe(code)
  }
}

describe('colab-mcp ownership helpers', () => {
  it('derives deterministic 17-char RFC-1035 owner prefixes per verified caller', () => {
    expect(prefixA).toMatch(/^run-[0-9a-f]{12}-$/)
    expect(prefixA).toHaveLength(17)
    expect(ownerPrefix(runA)).toBe(prefixA)
    expect(prefixA).not.toBe(prefixB)
    expect(() => ownerPrefix('')).toThrow(ColabError)
    expect(() => ownerPrefix('   ')).toThrow(ColabError)
  })

  it('validates owned runtime and session names strictly against traversal and injection', () => {
    const ownedRuntime = `runtimes/${prefixA}gpu-1`
    const ownedSession = `${ownedRuntime}/sessions/550e8400-e29b-41d4-a716-446655440000`
    const peerRuntime = `runtimes/${prefixB}gpu-1`
    const peerSession = `${peerRuntime}/sessions/sess-1`

    expect(isOwnedRuntimeName(ownedRuntime, runA)).toBe(true)
    expect(isOwnedRuntimeName(ownedRuntime, runB)).toBe(false)
    expect(isOwnedRuntimeName(peerRuntime, runA)).toBe(false)
    expect(isOwnedRuntimeName('runtimes/personal-human', runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}-bad`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}x/../${prefixB}y`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}x/sessions/s1`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}x?foo=bar`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}x#frag`, runA)).toBe(false)
    expect(isOwnedRuntimeName(`runtimes/${prefixA}x%2f..`, runA)).toBe(false)
    expect(isOwnedRuntimeName(ownedRuntime, '')).toBe(false)

    expect(isOwnedSessionName(ownedSession, runA)).toBe(true)
    expect(isOwnedSessionName(ownedSession, runB)).toBe(false)
    expect(isOwnedSessionName(peerSession, runA)).toBe(false)
    expect(isOwnedSessionName(ownedRuntime, runA)).toBe(false)
    expect(isOwnedSessionName(`${ownedRuntime}/sessions/..`, runA)).toBe(false)
    expect(isOwnedSessionName(`${ownedRuntime}/sessions/a..b`, runA)).toBe(false)
    expect(isOwnedSessionName(`${ownedRuntime}/sessions/s1/extra`, runA)).toBe(false)
    expect(isOwnedSessionName(`${ownedRuntime}/../${prefixB}gpu-1/sessions/s1`, runA)).toBe(false)
    expect(isOwnedSessionName(`${ownedRuntime}/sessions/s1?x=1`, runA)).toBe(false)

    expect(isOwnedSessionOrRuntimeRef(ownedRuntime, runA)).toBe(true)
    expect(isOwnedSessionOrRuntimeRef(ownedSession, runA)).toBe(true)
    expect(isOwnedSessionOrRuntimeRef(peerRuntime, runA)).toBe(false)
    expect(isOwnedSessionOrRuntimeRef(peerSession, runA)).toBe(false)
  })

  it('scopes runtime IDs deterministically within 63 chars and rejects peer prefixes', () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    expect(scopeRuntimeId(undefined, requestId, runA)).toBe(`${prefixA}${requestId}`)
    expect(scopeRuntimeId('gpu-1', requestId, runA)).toBe(`${prefixA}gpu-1`)
    expect(scopeRuntimeId(`${prefixA}gpu-1`, requestId, runA)).toBe(`${prefixA}gpu-1`)

    const longId = `a${'b'.repeat(61)}c`
    const clamped = scopeRuntimeId(longId, requestId, runA)
    expect(clamped.startsWith(prefixA)).toBe(true)
    expect(clamped.length).toBeLessThanOrEqual(63)
    expect(clamped).toMatch(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    expect(scopeRuntimeId(longId, requestId, runA)).toBe(clamped)
    expect(isOwnedRuntimeName(`runtimes/${clamped}`, runA)).toBe(true)

    expect(() => scopeRuntimeId(`${prefixB}gpu-1`, requestId, runA)).toThrow(ColabError)
  })
})

describe('createColabRuntimePolicy security isolation', () => {
  it('fails closed when verified caller identity is missing or blank', async () => {
    const { upstream, getToken, callTool } = mockUpstream(() => ({ content: [], structuredContent: {} }))
    const call = createColabRuntimePolicy(upstream, 5)

    await expectColabError(call('list_runtimes', {}, context(), ''), 'colab_caller_required')
    await expectColabError(call('get_subscription', {}, context(), '   '), 'colab_caller_required')
    await expectColabError(call('create_runtime', { runtime: {} }, context()), 'colab_caller_required')
    expect(getToken).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rejects unknown tool names fail-closed before fetching tokens or calling upstream', async () => {
    const { upstream, getToken, callTool } = mockUpstream(() => ({ content: [], structuredContent: {} }))
    const call = createColabRuntimePolicy(upstream, 5)

    await expectColabError(call('delete_all_runtimes', {}, context(), runA), 'colab_tool_not_allowed')
    await expectColabError(call('admin_exec', {}, context(), runA), 'colab_tool_not_allowed')
    expect(getToken).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('prefixes create_runtime runtimeId with ownerPrefix(runA) and strips connectionInfo from both structuredContent and content', async () => {
    const { upstream, callTool } = mockUpstream((name, args) => {
      if (name === 'list_runtimes') return { content: [], structuredContent: { runtimes: [] } }
      expect(name).toBe('create_runtime')
      const runtime = {
        name: `runtimes/${args.runtimeId}`,
        state: 'RUNNING',
        connectionInfo: { url: 'https://colab-proxy.internal', token: 'secret-proxy-token' },
        connection_info: { proxy_token: 'snake-secret' },
        accessToken: 'secret-access-token',
      }
      return {
        structuredContent: runtime,
        content: [{ type: 'text', text: JSON.stringify(runtime) }],
      }
    })
    const call = createColabRuntimePolicy(upstream, 5)

    const result = await call(
      'create_runtime',
      { runtime: { machineType: 'a2-highgpu-1g' }, runtimeId: 'train-job' },
      context(),
      runA,
    )
    const createCall = callTool.mock.calls.find(([tool]) => tool === 'create_runtime')
    expect(createCall?.[1].runtimeId).toBe(`${prefixA}train-job`)
    expect(result.structuredContent).toEqual({
      name: `runtimes/${prefixA}train-job`,
      state: 'RUNNING',
    })
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ name: `runtimes/${prefixA}train-job`, state: 'RUNNING' }),
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(
      /connectionInfo|connection_info|secret-proxy-token|snake-secret|accessToken/,
    )
  })

  it('filters list_runtimes to caller-owned runtimes only, redacts credentials, and fails closed on unparseable payloads', async () => {
    const runARuntime = {
      name: `runtimes/${prefixA}one`,
      state: 'RUNNING',
      connectionInfo: { url: 'https://a.example', token: 'tok-a' },
    }
    const runBRuntime = {
      name: `runtimes/${prefixB}one`,
      state: 'RUNNING',
      connectionInfo: { url: 'https://b.example', token: 'tok-b' },
      proxyToken: 'proxy-b',
      nested: { access_token: 'nested-secret', ok: true },
    }
    const humanRuntime = {
      name: 'runtimes/human-notebook',
      state: 'RUNNING',
      connectionInfo: { url: 'https://human.example', token: 'tok-human' },
    }
    let nextResponse: CallToolResult = {
      structuredContent: {
        runtimes: [runARuntime, runBRuntime, humanRuntime],
        nextPageToken: 'page-2',
        unreachable: [`runtimes/${prefixA}lost`, `runtimes/${prefixB}lost`, 'runtimes/human-lost'],
      },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            runtimes: [runARuntime, runBRuntime, humanRuntime],
            nextPageToken: 'page-2',
          }),
        },
      ],
    }
    const { upstream } = mockUpstream(() => nextResponse)
    const call = createColabRuntimePolicy(upstream, 5)

    // Run B sees only its own runtime with credentials stripped and preserves pagination token.
    const listB = await call('list_runtimes', {}, context(), runB)
    expect(listB.structuredContent).toEqual({
      runtimes: [{ name: `runtimes/${prefixB}one`, state: 'RUNNING', nested: { ok: true } }],
      nextPageToken: 'page-2',
      unreachable: [`runtimes/${prefixB}lost`],
    })
    expect(listB.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          runtimes: [{ name: `runtimes/${prefixB}one`, state: 'RUNNING', nested: { ok: true } }],
          nextPageToken: 'page-2',
        }),
      },
    ])
    expect(JSON.stringify(listB)).not.toMatch(
      /human-notebook|tok-a|tok-b|tok-human|proxy-b|nested-secret|connectionInfo/,
    )

    // A third run with no runtimes sees an empty list.
    const listC = await call('list_runtimes', {}, context(), 'agents/run-gamma')
    expect(listC.structuredContent).toEqual({ runtimes: [], nextPageToken: 'page-2', unreachable: [] })
    expect(listC.content).toEqual([{ type: 'text', text: JSON.stringify({ runtimes: [], nextPageToken: 'page-2' }) }])

    // Unparseable non-JSON text response fails closed instead of leaking raw peer runtimes.
    nextResponse = {
      content: [{ type: 'text', text: `Runtimes: runtimes/${prefixA}one token=tok-a` }],
    }
    await expectColabError(call('list_runtimes', {}, context(), runB), 'colab_runtime_list_invalid')

    // Empty response without structuredContent or content fails closed.
    nextResponse = { content: [] }
    await expectColabError(call('list_runtimes', {}, context(), runB), 'colab_runtime_list_invalid')
  })

  it('rejects cross-run, external, traversal, missing, and conflicting-alias targets before invoking upstream', async () => {
    const { upstream, getToken, callTool } = mockUpstream(() => ({ content: [], structuredContent: {} }))
    const call = createColabRuntimePolicy(upstream, 5)

    const ownedA = `runtimes/${prefixA}gpu`
    const ownedB = `runtimes/${prefixB}gpu`
    const sessionA = `${ownedA}/sessions/s1`
    const sessionB = `${ownedB}/sessions/s1`

    const deniedCalls: Array<[string, Record<string, unknown>]> = [
      // Cross-run targets (Run B targeting Run A)
      ['get_runtime', { name: ownedA }],
      ['get_runtime', { runtimeName: ownedA }],
      ['get_runtime', { runtime_name: ownedA }],
      ['delete_runtime', { name: ownedA }],
      ['delete_runtime', { runtime_name: ownedA }],
      ['list_sessions', { parent: ownedA }],
      ['list_sessions', { runtime: ownedA }],
      ['create_session', { parent: ownedA }],
      ['create_session', { parent: ownedB, session: { name: sessionA } }],
      ['delete_session', { name: sessionA }],
      ['delete_session', { session: sessionA }],
      ['delete_session', { parent: ownedA, sessionId: 's1' }],
      ['execute_code', { code: 'print(1)', session: sessionA }],
      ['execute_code', { code: 'print(1)', name: sessionA }],
      ['execute_code', { code: 'print(1)', runtime: ownedA }],
      ['execute_code', { code: 'print(1)', parent: ownedA }],
      // Human / external runtimes
      ['get_runtime', { name: 'runtimes/human-gpu' }],
      ['delete_runtime', { name: 'runtimes/human-gpu' }],
      ['list_sessions', { parent: 'runtimes/human-gpu' }],
      ['create_session', { parent: 'runtimes/human-gpu' }],
      ['delete_session', { name: 'runtimes/human-gpu/sessions/s1' }],
      ['execute_code', { code: '1', runtime: 'runtimes/human-gpu' }],
      // Path traversal and query/fragment smuggling
      ['get_runtime', { name: `runtimes/${prefixB}x/../${prefixA}y` }],
      ['delete_runtime', { name: `runtimes/${prefixB}x/../${prefixA}y` }],
      ['list_sessions', { parent: `runtimes/${prefixB}x/../${prefixA}y` }],
      ['create_session', { parent: `runtimes/${prefixB}x?a=b` }],
      ['delete_session', { name: `${ownedB}/sessions/../${prefixA}y` }],
      ['delete_session', { name: `${ownedB}/sessions/s1/extra` }],
      ['execute_code', { code: '1', session: `${ownedB}/sessions/..` }],
      ['execute_code', { code: '1', runtime: `runtimes/${prefixB}x/../${prefixA}y` }],
      // Conflicting aliases (parameter smuggling)
      ['get_runtime', { name: ownedB, runtime_name: ownedA }],
      ['delete_runtime', { name: ownedB, runtimeName: ownedA }],
      ['list_sessions', { parent: ownedB, runtime: ownedA }],
      ['create_session', { parent: ownedB, runtime: ownedA }],
      ['delete_session', { name: sessionB, session: sessionA }],
      ['delete_session', { parent: ownedB, name: sessionA }],
      ['execute_code', { code: '1', runtime: ownedB, session: sessionA }],
      ['execute_code', { code: '1', runtime: ownedB, parent: ownedA }],
      ['execute_code', { code: '1', runtime: ownedB, runtimeId: `${prefixA}gpu` }],
      // Missing or incomplete target
      ['get_runtime', {}],
      ['delete_runtime', {}],
      ['list_sessions', {}],
      ['create_session', {}],
      ['delete_session', {}],
      ['delete_session', { name: ownedB }],
      ['delete_session', { parent: ownedB }],
      ['delete_session', { session: 's1' }],
      ['execute_code', { code: '1' }],
      ['execute_code', { code: '1', session: 's1' }],
      ['execute_code', { code: '1', session: ownedB }],
      // create_runtime attempting to pass unowned runtime.name or peer prefix
      ['create_runtime', { runtime: { name: ownedA }, runtimeId: 'ok' }],
      ['create_runtime', { runtime: {}, runtimeId: `${prefixA}hijack` }],
    ]

    for (const [toolName, toolArgs] of deniedCalls) {
      await expectColabError(call(toolName, toolArgs, context(), runB), 'colab_runtime_forbidden')
    }
    expect(getToken).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('enforces global maxConcurrentRuntimes across Run A, Run B, and external runtimes while preserving idempotent retries', async () => {
    const requestId = '55555555-5555-4555-8555-555555555555'
    const runtimes: Array<{ name: string }> = [
      { name: `runtimes/${prefixA}r1` },
      { name: `runtimes/${prefixB}r2` },
      { name: 'runtimes/human-r3' },
      { name: 'runtimes/human-r4' },
    ]
    let createAttempt = 0
    const { upstream } = mockUpstream((name, args) => {
      if (name === 'list_runtimes') return { content: [], structuredContent: { runtimes } }
      if (name === 'create_runtime') {
        createAttempt++
        if (createAttempt === 1) {
          return { isError: true, content: [{ type: 'text', text: '{"error":{"status":"DEADLINE_EXCEEDED"}}' }] }
        }
        return {
          content: [],
          structuredContent: {
            name: `runtimes/${args.runtimeId}`,
            connectionInfo: { token: 'strip-me' },
          },
        }
      }
      return { content: [], structuredContent: {} }
    })
    const call = createColabRuntimePolicy(upstream, 5)

    // Run A claims the 5th global slot and gets DEADLINE_EXCEEDED.
    const timedOut = await call(
      'create_runtime',
      { runtime: { region: 'us-central1' }, runtimeId: 'r5', requestId },
      context(),
      runA,
    )
    expect(timedOut.isError).toBe(true)

    // Run B cannot claim a 6th global slot (4 active across A+B+human + 1 reserved by A = 5/5).
    await expectColabError(
      call('create_runtime', { runtime: { region: 'us-central1' }, runtimeId: 'r5', requestId }, context(), runB),
      'colab_runtime_limit_reached',
    )

    // Run B cannot hijack Run A's prefixed runtimeId reservation.
    await expectColabError(
      call(
        'create_runtime',
        { runtime: { region: 'us-central1' }, runtimeId: `${prefixA}r5`, requestId },
        context(),
        runB,
      ),
      'colab_runtime_forbidden',
    )

    // Run A's matching idempotent retry succeeds at 5/5 capacity and redacts connectionInfo.
    const retried = await call(
      'create_runtime',
      { runtime: { region: 'us-central1' }, runtimeId: 'r5', requestId },
      context(),
      runA,
    )
    expect(retried.structuredContent).toEqual({ name: `runtimes/${prefixA}r5` })
    expect(createAttempt).toBe(2)
  })
})
