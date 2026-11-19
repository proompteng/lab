import { generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createRelayMcpHandler, RELAY_AUDIENCE, RELAY_ID, verifyRelayToken } from './server'
import { invocationSchema, targetSchema } from './contract'

const target = targetSchema.parse({
  id: 'agents/lab',
  name: 'Lab',
  workspaceId: crypto.randomUUID(),
  namespace: 'agents',
  namespaceUid: crypto.randomUUID(),
  agent: 'codex-agent',
  repository: 'proompteng/lab',
  base: 'main',
  vcsRef: 'github',
  secretBindingRef: 'github',
  secrets: [],
  timeoutSeconds: 7200,
})
const invocation = invocationSchema.parse({
  operationId: crypto.randomUUID(),
  clientService: 'tengri-web',
  actor: 'human:fixture',
  authorizationReceiptId: crypto.randomUUID(),
  action: 'agents.runs.start',
  resources: [{ kind: 'agents.target', id: target.id, target: '' }],
})

const request = (method: string, params: unknown, token = 'fixture') =>
  new Request('https://agents/mcp/relay/lab', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

describe('authenticated Relay MCP', () => {
  it('requires the signed Relay workload identity, exact audience and unexpired lifetime', async () => {
    const keys = await generateKeyPair('ES256'),
      other = await generateKeyPair('ES256')
    const token = (sub: string, aud: string, exp: number) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'ES256' })
        .setSubject(sub)
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(keys.privateKey)
    const future = Math.floor(Date.now() / 1000) + 60
    await verifyRelayToken(await token(RELAY_ID, RELAY_AUDIENCE, future), async () => keys.publicKey)
    await expect(
      verifyRelayToken(
        await token('spiffe://proompteng.ai/ns/opencode/sa/opencode', RELAY_AUDIENCE, future),
        async () => keys.publicKey,
      ),
    ).rejects.toThrow()
    await expect(
      verifyRelayToken(await token(RELAY_ID, 'https://another-service', future), async () => keys.publicKey),
    ).rejects.toThrow()
    await expect(
      verifyRelayToken(await token(RELAY_ID, RELAY_AUDIENCE, 1), async () => keys.publicKey),
    ).rejects.toThrow()
    await expect(
      verifyRelayToken(await token(RELAY_ID, RELAY_AUDIENCE, future), async () => other.publicKey),
    ).rejects.toThrow()
  })
  it('protects discovery, publishes write annotations and passes only validated invocation metadata', async () => {
    const call = vi.fn(async () => ({ runId: invocation.operationId, status: 'Pending' }))
    const verify = vi.fn(async (token: string) => {
      if (token !== 'fixture') throw new Error('invalid')
    })
    const handler = createRelayMcpHandler({ targets: { lab: target }, verify, service: { call } })
    expect((await handler(request('tools/list', {}, 'other'), 'lab')).status).toBe(401)
    expect((await handler(request('tools/list', {}), 'absent')).status).toBe(404)
    const catalog = await (await handler(request('tools/list', {}), 'lab')).json()
    expect(catalog.result.tools).toHaveLength(6)
    expect(
      catalog.result.tools.find((tool: { name: string }) => tool.name === 'start_run').annotations.readOnlyHint,
    ).toBe(false)
    const missing = await (
      await handler(request('tools/call', { name: 'start_run', arguments: { task: 'test' } }), 'lab')
    ).json()
    expect(missing.result.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
    const output = await (
      await handler(
        request('tools/call', {
          name: 'start_run',
          arguments: { task: 'test' },
          _meta: { 'io.proompteng.relay': invocation },
        }),
        'lab',
      )
    ).json()
    expect(output.result.structuredContent).toMatchObject({
      kind: 'agent-run',
      targetId: target.id,
      run: { runId: invocation.operationId },
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('start_run', { task: 'test' }, invocation, target)
  })
  it('rejects oversized bodies before executing a tool', async () => {
    const call = vi.fn()
    const handler = createRelayMcpHandler({ targets: { lab: target }, verify: async () => {}, service: { call } })
    expect(
      (await handler(request('tools/call', { name: 'start_run', arguments: { task: 'x'.repeat(70_000) } }), 'lab'))
        .status,
    ).toBe(400)
    expect(call).not.toHaveBeenCalled()
  })
})
