import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateIdentity, invoke, proofFor } from './relay-client.mjs'

function fixtureConfiguration(keyFile) {
  return {
    keyFile, credential: 'a'.repeat(43), endpoint: 'https://proompteng.ai/api/platform/relay/agent',
    connectionId: '11111111-1111-4111-8111-111111111111',
    delegationId: '22222222-2222-4222-8222-222222222222',
    recoveryGeneration: '1', credentialGeneration: '1', connectorId: 'galactic', clientService: 'tengri-web',
    binding: { service: 'tengri', id: '33333333-3333-4333-8333-333333333333', generation: '44444444-4444-4444-8444-444444444444' },
    operations: [{ name: 'status', description: 'Read pod status', inputSchema: { type: 'object' }, readOnly: true }],
  }
}

test('stdio exposes only read-only tools and reports private-key failures without secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-stdio-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    await generateIdentity(keyFile)
    await chmod(keyFile, 0o644)
    const file = path.join(directory, 'grant.json')
    await writeFile(
      file,
      JSON.stringify(fixtureConfiguration(keyFile)),
      { mode: 0o600 },
    )
    const client = fileURLToPath(new URL('./relay-client.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [client, file], {
      input:
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}\n',
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    const replies = result.stdout.trim().split('\n').map(JSON.parse)
    assert.deepEqual(replies.find((reply) => reply.id === 1).result.tools[0].annotations, {
      readOnlyHint: true,
      openWorldHint: true,
    })
    assert.match(replies.find((reply) => reply.id === 2).error.message, /The connector request failed or was denied/)
    const oversized = spawnSync(process.execPath, [client, file], {
      input: 'x'.repeat(1048577),
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(oversized.status, 1)
    assert(!oversized.stderr.includes('a'.repeat(43)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a running MCP bridge reads replaced configuration and never retains a removed grant', { timeout: 7000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-rotation-'))
  let child
  let timeout
  try {
    const keyFile = path.join(directory, 'identity.pem')
    await generateIdentity(keyFile)
    const config = fixtureConfiguration(keyFile)
    const file = path.join(directory, 'grant.json')
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    child = spawn(process.execPath, [fileURLToPath(new URL('./relay-client.mjs', import.meta.url)), file], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    timeout = setTimeout(() => child.kill(), 5000)
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let sequence = 0
    const call = async (method, params) => {
      const id = ++sequence
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      const reply = await lines.next()
      assert.equal(reply.done, false)
      const value = JSON.parse(reply.value)
      assert.equal(value.id, id)
      return value
    }
    assert.equal((await call('initialize', { protocolVersion: '2025-11-25' })).result.protocolVersion, '2025-11-25')
    assert.equal((await call('tools/list')).result.tools[0].name, 'status')
    const rotated = {
      ...config,
      delegationId: '55555555-5555-4555-8555-555555555555', credentialGeneration: '2',
      operations: [{ name: 'logs', description: 'Read pod logs', inputSchema: { type: 'object' }, readOnly: true }],
    }
    const replacement = path.join(directory, 'replacement')
    await writeFile(replacement, JSON.stringify(rotated), { mode: 0o600 })
    await rename(replacement, file)
    assert.equal((await call('tools/list')).result.tools[0].name, 'logs')
    await writeFile(file, JSON.stringify({ ...rotated, operations: [{ ...rotated.operations[0], readOnly: false }] }), { mode: 0o600 })
    assert.equal((await call('tools/list')).error.code, -32000)
    await rm(file)
    assert.equal((await call('tools/list')).error.code, -32000)
    child.stdin.end()
    assert.equal(await exited, 0, stderr)
    assert(!stderr.includes(config.credential))
  } finally {
    clearTimeout(timeout)
    child?.kill()
    await rm(directory, { recursive: true, force: true })
  }
})

test('agent proof binds its key, grant credential, endpoint, method, and exact body bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-agent-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    const identity = await generateIdentity(keyFile)
    await assert.rejects(generateIdentity(keyFile))
    const privateKey = await readFile(keyFile, 'utf8')
    const credential = 'a'.repeat(43)
    const endpoint = 'https://proompteng.ai/api/platform/relay/agent'
    const body = Buffer.from('{"arguments":{"number":1e20},"connectionId":"fixture","operation":"search"}')
    const proof = proofFor({ endpoint, credential, privateKey, body })
    const [header, claims, signature] = proof.split('.')
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url'))
    const decoded = JSON.parse(Buffer.from(claims, 'base64url'))
    assert.equal(decodedHeader.typ, 'dpop+jwt')
    assert.equal(decodedHeader.alg, 'ES256')
    assert.equal(decoded.htm, 'POST')
    assert.equal(decoded.htu, endpoint)
    assert.equal(decoded.ath, createHash('sha256').update(credential).digest('base64url'))
    assert.equal(decoded.bht, createHash('sha256').update(body).digest('base64url'))
    assert.equal(
      identity.thumbprint,
      createHash('sha256').update(JSON.stringify(identity.publicKey)).digest('base64url'),
    )
    assert(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey({ key: decodedHeader.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    )
    assert(
      !verify(
        'sha256',
        Buffer.from(`${header}.${claims}tampered`),
        { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('direct API invocation sends a scoped grant and preserves signed bytes; unsafe key permissions fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-agent-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    await generateIdentity(keyFile)
    const config = {
      keyFile,
      endpoint: 'https://proompteng.ai/api/platform/relay/agent',
      credential: 'a'.repeat(43),
      delegationId: '11111111-1111-4111-8111-111111111111',
      connectorId: 'galactic',
      clientService: 'tengri-web',
      binding: {
        service: 'tengri',
        id: '22222222-2222-4222-8222-222222222222',
        generation: '33333333-3333-4333-8333-333333333333',
      },
    }
    let calls = 0
    let operationId
    const fetcher = async (_url, options) => {
      calls += 1
      assert.equal(JSON.parse(options.body).kind, 'execute')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, `DPoP ${config.credential}`)
      assert.equal(options.headers['x-relay-delegation'], config.delegationId)
      const raw = Buffer.from(JSON.parse(options.body).body, 'base64')
      const claims = JSON.parse(Buffer.from(options.headers.dpop.split('.')[1], 'base64url'))
      assert.equal(claims.bht, createHash('sha256').update(raw).digest('base64url'))
      const payload = JSON.parse(raw)
      operationId = payload.operationId
      assert.match(payload.operationId, /^[0-9a-f-]{36}$/)
      assert.deepEqual(payload, {
        operationId: payload.operationId,
        clientService: config.clientService,
        binding: config.binding,
        delegationId: config.delegationId,
        connectorId: config.connectorId,
        operation: 'search',
        arguments: { query: 'hello' },
      })
      assert(!options.body.includes(config.credential))
      return new Response(
        JSON.stringify({
          operationId: payload.operationId,
          result: '{"found":true}',
          contentType: 'application/json',
          authorizationReceiptId: '44444444-4444-4444-8444-444444444444',
          executionReceiptId: '55555555-5555-4555-8555-555555555555',
        }),
        { status: 200 },
      )
    }
    assert.deepEqual(await invoke(config, 'search', { query: 'hello' }, fetcher), {
      content: [{ type: 'text', text: '{"found":true}' }],
      isError: false,
      _meta: {
        relay: {
          operationId,
          outcome: 'succeeded',
          authorizationReceiptId: '44444444-4444-4444-8444-444444444444',
          executionReceiptId: '55555555-5555-4555-8555-555555555555',
        },
      },
    })
    await chmod(keyFile, 0o644)
    await assert.rejects(invoke(config, 'search', {}, fetcher), /owner-only/)
    assert.equal(calls, 1)
    await assert.rejects(
      invoke({ ...config, endpoint: 'http://proompteng.ai/api/platform/relay/agent' }, 'search', {}, fetcher),
      /HTTPS/,
    )
    assert.equal(calls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('lost guest responses use a fresh proof for status lookup and never resend execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-recovery-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    await generateIdentity(keyFile)
    const config = {
      keyFile,
      endpoint: 'https://proompteng.ai/api/platform/relay/agent',
      credential: 'a'.repeat(43),
      delegationId: '11111111-1111-4111-8111-111111111111',
      connectorId: 'galactic',
      clientService: 'tengri-web',
      binding: { service: 'tengri', id: 'workspace', generation: 'generation' },
    }
    for (const scenario of ['succeeded', 'started', 'failed', 'withheld', 'unavailable', 'invalid']) {
      const kinds = []
      const proofs = []
      let original
      const fetcher = async (_url, options) => {
        const envelope = JSON.parse(options.body)
        kinds.push(envelope.kind)
        const raw = Buffer.from(envelope.body, 'base64')
        const proof = JSON.parse(Buffer.from(options.headers.dpop.split('.')[1], 'base64url'))
        proofs.push(proof)
        assert.equal(proof.bht, createHash('sha256').update(raw).digest('base64url'))
        if (envelope.kind === 'execute') {
          original = raw
          throw new Error('fixture lost response')
        }
        assert.equal(envelope.kind, 'lookup')
        const lookup = JSON.parse(raw)
        assert.equal(lookup.executionBody, original.toString('utf8'))
        assert.deepEqual(lookup.binding, config.binding)
        assert.equal(lookup.delegationId, config.delegationId)
        if (scenario === 'unavailable') return new Response(null, { status: 503 })
        return Response.json({
          lookupReceiptId: '44444444-4444-4444-8444-444444444444',
          execution: {
            operationId: JSON.parse(original).operationId,
            outcome: scenario === 'invalid' ? 'succeeded' : scenario,
            authorizationReceiptId: '55555555-5555-4555-8555-555555555555',
            executionReceiptId: '66666666-6666-4666-8666-666666666666',
            requestHash: createHash('sha256')
              .update(scenario === 'invalid' ? 'wrong request' : original)
              .digest('base64'),
            resultHash: ['succeeded', 'withheld', 'invalid'].includes(scenario)
              ? createHash('sha256').update('fixture result').digest('base64')
              : '',
            upstreamStatus: scenario === 'failed' ? 403 : scenario === 'started' ? 0 : 200,
            updatedAtUnixMs: Date.now().toString(),
          },
        })
      }
      const result = await invoke(config, 'status', { namespace: 'fixture' }, fetcher)
      assert.deepEqual(kinds, ['execute', 'lookup'])
      assert.notEqual(proofs[0].jti, proofs[1].jti)
      assert.notEqual(proofs[0].bht, proofs[1].bht)
      assert.equal(result.isError, true)
      assert.equal(result._meta.relay.operationId, JSON.parse(original).operationId)
      assert.equal(result._meta.relay.outcome, ['invalid', 'unavailable'].includes(scenario) ? 'unknown' : scenario)
      assert.match(result.content[0].text, /The request was not resent/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
