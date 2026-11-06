import { expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import { z } from 'zod'

const subject = 'spiffe://proompteng.ai/ns/relay/sa/relay'
const audience =
  '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/proompteng-ai/providers/spire'
const scope = 'https://www.googleapis.com/auth/devstorage.read_only'
const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token'
const schema = {
  type: 'object',
  properties: { query: { type: 'string', maxLength: 128 } },
  required: ['query'],
  additionalProperties: false,
}
const claimsSchema = z.object({
  sub: z.literal(subject),
  aud: z.tuple([z.literal(audience)]),
  exp: z.number(),
  iss: z.string(),
})
const resultsSchema = z.array(
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), body: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
)

test('federation fetches exact JWT identities, exchanges over TLS, renews once, and fails closed through HTTP and MCP', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'relay-federation-'))
  const cert = path.join(directory, 'cert.pem')
  const key = path.join(directory, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ],
    { stdio: 'ignore' },
  )
  let mode = 'normal'
  let kid = 'first'
  const keys = new Map([['first', generateKeyPairSync('rsa', { modulusLength: 2048 })]])
  let fetches = 0
  let exchanges = 0
  let resourceCalls = 0
  let discoveryCalls = 0
  let issuer = ''
  const issued = new Map<string, number>()
  const failures: string[] = []
  const ca = readFileSync(cert)
  const getJson = (url: string) =>
    new Promise<unknown>((resolve, reject) => {
      get(url, { ca }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      }).on('error', reject)
    })
  const validate = (token: string) => {
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature) throw new Error('malformed JWT')
    const parsed = z
      .object({ alg: z.literal('RS256'), kid: z.string() })
      .parse(JSON.parse(Buffer.from(header, 'base64url').toString()))
    const pair = keys.get(parsed.kid)
    if (
      !pair ||
      !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url'))
    )
      throw new Error('invalid JWT signature')
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
    if (claims.exp <= Date.now() / 1000) throw new Error('expired JWT')
    return { claims, header, payload, signature, kid: parsed.kid }
  }
  const api = createServer({ cert: ca, key: readFileSync(key) }, async (request, response) => {
    try {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/.well-known/openid-configuration') {
        discoveryCalls++
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys` }))
        return
      }
      if (request.url === '/keys') {
        response.end(
          JSON.stringify({
            keys: [...keys].map(([id, pair]) => ({
              ...pair.publicKey.export({ format: 'jwk' }),
              kid: id,
              alg: 'RS256',
              use: 'sig',
            })),
          }),
        )
        return
      }
      if (request.url === '/token') {
        exchanges++
        expect(request.method).toBe('POST')
        expect(request.headers.authorization).toBeUndefined()
        expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
        let body = ''
        for await (const chunk of request) body += chunk
        const params = new URLSearchParams(body)
        expect([...params.keys()].sort()).toEqual([
          'audience',
          'grant_type',
          'requested_token_type',
          'scope',
          'subject_token',
          'subject_token_type',
        ])
        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
        expect(params.get('requested_token_type')).toBe(accessTokenType)
        expect(params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt')
        expect(params.get('audience')).toBe(audience)
        expect(params.get('scope')).toBe(scope)
        const jwt = validate(params.get('subject_token') ?? '')
        const discovery = z
          .object({ issuer: z.literal(issuer), jwks_uri: z.literal(`${issuer}/keys`) })
          .parse(await getJson(`${issuer}/.well-known/openid-configuration`))
        const jwks = z
          .object({ keys: z.array(z.object({ kty: z.literal('RSA'), n: z.string(), e: z.string(), kid: z.string() })) })
          .parse(await getJson(discovery.jwks_uri))
        const publicKey = jwks.keys.find((entry) => entry.kid === jwt.kid)
        if (
          !publicKey ||
          !verify(
            'RSA-SHA256',
            Buffer.from(`${jwt.header}.${jwt.payload}`),
            createPublicKey({ key: publicKey, format: 'jwk' }),
            Buffer.from(jwt.signature, 'base64url'),
          ) ||
          jwt.claims.iss !== issuer ||
          mode === 'denied'
        ) {
          response.writeHead(403).end(JSON.stringify({ error: 'PRIVATE_PROVIDER_ERROR' }))
          return
        }
        if (mode === 'redirect') {
          response.writeHead(302, { location: `${issuer}/records` }).end()
          return
        }
        if (mode === 'oversized') {
          response.end('x'.repeat(32_769))
          return
        }
        if (mode === 'lost') {
          request.socket.destroy()
          return
        }
        const token = `PRIVATE_TOKEN_${exchanges}`
        issued.set(token, Date.now() + 2000)
        response.end(
          JSON.stringify({
            access_token: token,
            token_type: mode === 'wrong-type' ? 'DPoP' : 'Bearer',
            issued_token_type:
              mode === 'wrong-issued-type' ? 'urn:ietf:params:oauth:token-type:id_token' : accessTokenType,
            expires_in: mode === 'expired-access' ? 0 : 2,
            scope: mode === 'wrong-scope' ? 'write' : scope,
          }),
        )
        return
      }
      const authorization = request.headers.authorization ?? ''
      const expires = issued.get(authorization.replace(/^Bearer /, '')) ?? 0
      if (!authorization.startsWith('Bearer ') || expires <= Date.now()) {
        response.writeHead(401).end()
        return
      }
      if (request.url === '/mcp') {
        let body = ''
        for await (const chunk of request) body += chunk
        const message = z
          .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
          .parse(JSON.parse(body))
        if (message.id === undefined) {
          response.writeHead(202).end()
          return
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'federation-fixture', version: '1' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    { name: 'read', inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false } },
                  ],
                }
              : { content: [{ type: 'text', text: 'authorized fixture result' }] }
        if (message.method === 'tools/call') resourceCalls++
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      } else {
        expect(request.url).toBe('/records?query=approved')
        resourceCalls++
        response.end(JSON.stringify({ result: 'authorized fixture result' }))
      }
    } catch (error) {
      failures.push(String(error))
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  const address = api.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  issuer = `https://localhost:${address.port}`
  const proto = path.resolve(import.meta.dir, '../../../../../services/tengri/proto/spiffe/workloadapi.proto')
  const descriptor = grpc.loadPackageDefinition(loader.loadSync(proto, { defaults: true }))
  const Constructor = descriptor.SpiffeWorkloadAPI
  if (typeof Constructor !== 'function' || !('service' in Constructor))
    throw new Error('invalid Workload API descriptor')
  const server = new grpc.Server()
  server.addService(Constructor.service as grpc.ServiceDefinition, {
    FetchJWTSVID(
      call: grpc.ServerUnaryCall<{ audience: string[]; spiffeId: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      fetches++
      try {
        expect(call.metadata.get('workload.spiffe.io')).toEqual(['true'])
        expect(call.request).toEqual({ audience: [audience], spiffeId: subject })
        const pair = keys.get(kid)
        if (!pair) throw new Error('signing key unavailable')
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')
        const payload = Buffer.from(
          JSON.stringify({
            sub: mode === 'wrong-subject' ? 'spiffe://proompteng.ai/ns/other/sa/other' : subject,
            aud: [mode === 'wrong-audience' ? 'other' : audience],
            exp: Math.floor(Date.now() / 1000) + (mode === 'expired-jwt' ? -60 : 300),
            iat: Math.floor(Date.now() / 1000),
            iss: mode === 'wrong-issuer' ? 'https://other.invalid' : issuer,
          }),
        ).toString('base64url')
        const signer =
          mode === 'bad-signature' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : pair.privateKey
        callback(null, {
          svids: [
            {
              spiffeId: subject,
              svid: `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer).toString('base64url')}`,
            },
          ],
        })
      } catch (error) {
        failures.push(String(error))
        callback({ code: grpc.status.INTERNAL, details: 'fixture failed' })
      }
    },
    ValidateJWTSVID(
      call: grpc.ServerUnaryCall<{ audience: string; svid: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      try {
        expect(call.request.audience).toBe(audience)
        validate(call.request.svid)
        callback(null, { spiffeId: subject })
      } catch {
        callback({ code: grpc.status.INVALID_ARGUMENT, details: 'PRIVATE_INVALID_JWT' })
      }
    },
  })
  const socket = `unix://${directory}/api.sock`
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(socket, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve())),
  )
  const operation = {
    name: 'read',
    description: 'Read fixture',
    action: 'fixture.status.read',
    target: { name: 'Fixture', kind: 'fixture.account', id: 'fixture/account' },
    input_schema: schema,
    read_only: true,
  }
  const authentication = {
    type: 'workload_identity',
    federation: { spiffe_id: subject, audience, token_endpoint: `${issuer}/token`, scopes: [scope], ca_file: cert },
  }
  const config = path.join(directory, 'config.json')
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      connectors: [
        {
          type: 'http',
          id: 'fixture',
          endpoint: `${issuer}/`,
          ca_file: cert,
          authentication,
          operations: [{ operation, method: 'GET', path: '/records' }],
        },
        {
          type: 'mcp',
          id: 'fixture-mcp',
          transport: { type: 'http', endpoint: `${issuer}/mcp`, ca_file: cert, authentication },
          operations: [{ operation, tool: 'read' }],
        },
      ],
    }),
  )
  const binary = process.env.RELAY_FEDERATION_FIXTURE_BIN
  if (!binary) throw new Error('run services/relay/test-client.sh to build the federation fixture')
  const child = spawn(binary, [], {
    env: { ...process.env, SPIFFE_ENDPOINT_SOCKET: socket, RELAY_CONFIG_FILE: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const invoke = async (index = 0) => {
    child.stdin.write(`${index}\n`)
    const line = await lines.next()
    if (line.done) throw new Error(`fixture exited: ${stderr}`)
    return resultsSchema.parse(JSON.parse(line.value))
  }
  try {
    const initial = await invoke()
    expect(failures).toEqual([])
    expect(initial).toEqual(
      Array.from({ length: 8 }, () => ({ ok: true, body: JSON.stringify({ result: 'authorized fixture result' }) })),
    )
    expect({ fetches, exchanges, resourceCalls, discoveryCalls }).toEqual({
      fetches: 1,
      exchanges: 1,
      resourceCalls: 8,
      discoveryCalls: 1,
    })
    await invoke()
    expect(exchanges).toBe(1)
    keys.set('rotated', generateKeyPairSync('rsa', { modulusLength: 2048 }))
    keys.delete('first')
    kid = 'rotated'
    await Bun.sleep(2100)
    expect((await invoke()).every((result) => result.ok)).toBe(true)
    expect(exchanges).toBe(2)
    expect((await invoke(1)).every((result) => result.ok)).toBe(true)
    expect(exchanges).toBe(3)
    expect(resourceCalls).toBe(32)
    await Bun.sleep(2100)
    for (const failure of [
      'wrong-subject',
      'wrong-audience',
      'expired-jwt',
      'bad-signature',
      'wrong-issuer',
      'denied',
      'redirect',
      'oversized',
      'lost',
      'wrong-type',
      'wrong-issued-type',
      'expired-access',
      'wrong-scope',
    ]) {
      mode = failure
      const before = resourceCalls
      const result = await invoke()
      expect(result.every((entry) => !entry.ok)).toBe(true)
      expect(resourceCalls).toBe(before)
      expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    }
    mode = 'normal'
    expect((await invoke()).every((result) => result.ok)).toBe(true)
    expect(stderr).not.toContain('PRIVATE_')
    expect(failures).toEqual([])
  } finally {
    child.kill('SIGKILL')
    server.forceShutdown()
    api.closeAllConnections()
    api.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
