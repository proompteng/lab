import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateIdentity, invoke, proofFor } from './relay-client.mjs'

test('stdio tools expose mutation hints and unconfirmed writes never invite automatic retries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-stdio-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    await generateIdentity(keyFile)
    await chmod(keyFile, 0o644)
    const file = path.join(directory, 'grant.json')
    await writeFile(
      file,
      JSON.stringify({
        keyFile,
        credential: 'a'.repeat(43),
        endpoint: 'https://proompteng.ai/api/tengri/connectors/agent',
        operations: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' }, readOnly: false }],
      }),
      { mode: 0o600 },
    )
    const client = fileURLToPath(new URL('./relay-client.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [client, file], {
      input:
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write","arguments":{}}}\n',
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    const replies = result.stdout.trim().split('\n').map(JSON.parse)
    assert.deepEqual(replies.find((reply) => reply.id === 1).result.tools[0].annotations, {
      readOnlyHint: false,
      openWorldHint: true,
    })
    assert.match(replies.find((reply) => reply.id === 2).error.message, /Check the provider before retrying/)
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

test('agent proof binds its key, grant credential, endpoint, method, and exact body bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-agent-'))
  try {
    const keyFile = path.join(directory, 'identity.pem')
    const identity = await generateIdentity(keyFile)
    await assert.rejects(generateIdentity(keyFile))
    const privateKey = await readFile(keyFile, 'utf8')
    const credential = 'a'.repeat(43)
    const endpoint = 'https://proompteng.ai/api/tengri/connectors/agent'
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
      endpoint: 'https://proompteng.ai/api/tengri/connectors/agent',
      credential: 'a'.repeat(43),
      grantId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
    }
    let calls = 0
    const fetcher = async (_url, options) => {
      calls += 1
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, `DPoP ${config.credential}`)
      assert.equal(options.headers['x-tengri-grant'], config.grantId)
      const raw = Buffer.from(JSON.parse(options.body).body, 'base64')
      const claims = JSON.parse(Buffer.from(options.headers.dpop.split('.')[1], 'base64url'))
      assert.equal(claims.bht, createHash('sha256').update(raw).digest('base64url'))
      assert.deepEqual(JSON.parse(raw), {
        connectionId: config.connectionId,
        operation: 'search',
        arguments: { query: 'hello' },
      })
      assert(!options.body.includes(config.credential))
      return new Response(JSON.stringify({ result: { found: true } }), { status: 200 })
    }
    assert.deepEqual(await invoke(config, 'search', { query: 'hello' }, fetcher), { found: true })
    await chmod(keyFile, 0o644)
    await assert.rejects(invoke(config, 'search', {}, fetcher), /owner-only/)
    assert.equal(calls, 1)
    await assert.rejects(
      invoke({ ...config, endpoint: 'http://proompteng.ai/api/tengri/connectors/agent' }, 'search', {}, fetcher),
      /HTTPS/,
    )
    assert.equal(calls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
