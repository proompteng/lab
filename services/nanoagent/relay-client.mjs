#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const digest = (bytes) => createHash('sha256').update(bytes).digest('base64url')
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

export async function generateIdentity(file) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await handle.sync()
  } finally {
    await handle.close()
  }
  const { crv, kty, x, y } = publicKey.export({ format: 'jwk' })
  return { thumbprint: digest(JSON.stringify({ crv, kty, x, y })), publicKey: { crv, kty, x, y } }
}

export function proofFor({ endpoint, credential, privateKey, body, now = Date.now() }) {
  const key = createPrivateKey(privateKey)
  const { crv, kty, x, y } = createPublicKey(key).export({ format: 'jwk' })
  if (kty !== 'EC' || crv !== 'P-256') throw new Error('A P-256 connector identity is required')
  const header = encode({ typ: 'dpop+jwt', alg: 'ES256', jwk: { crv, kty, x, y } })
  const claims = encode({
    htu: endpoint,
    htm: 'POST',
    iat: Math.floor(now / 1000),
    jti: randomUUID(),
    ath: digest(credential),
    bht: digest(body),
  })
  const payload = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${payload}.${signature}`
}

async function privateFile(file, limit = 524288) {
  const metadata = await stat(file)
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > limit ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error('Connector credentials require an owner-only regular file')
  return readFile(file, 'utf8')
}

export async function invoke(config, operation, args, fetcher = fetch) {
  const endpoint = new URL(config.endpoint)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/tengri/connectors/agent'
  )
    throw new Error('An HTTPS Tengri connector endpoint is required')
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.credential) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(operation))
    throw new Error('Invalid connector grant configuration')
  const body = Buffer.from(JSON.stringify({ connectionId: config.connectionId, operation, arguments: args }))
  if (body.length > 1048576) throw new Error('Connector arguments exceed their byte budget')
  const privateKey = await privateFile(config.keyFile, 16384)
  const proof = proofFor({ endpoint: endpoint.toString(), credential: config.credential, privateKey, body })
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(40000),
    headers: {
      'content-type': 'application/json',
      authorization: `DPoP ${config.credential}`,
      dpop: proof,
      'x-tengri-grant': config.grantId,
    },
    body: JSON.stringify({ body: body.toString('base64') }),
  })
  if (!response.ok) throw new Error('Connector access was denied or the connection is unavailable')
  if (!response.body) throw new Error('The connector response is missing')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.length
      if (total > 2097152 + 65536) {
        await reader.cancel()
        throw new Error('Connector response exceeded its byte budget')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).result
}

async function main() {
  if (process.argv[2] === 'keygen') {
    if (!process.argv[3]) throw new Error('Supply an exclusive private-key file path')
    process.stdout.write(`${JSON.stringify(await generateIdentity(process.argv[3]))}\n`)
    return
  }
  const file = process.argv[2]
  if (!file) throw new Error('Supply the owner-only connector grant configuration file')
  const config = JSON.parse(await privateFile(file))
  if (process.argv[3] === 'call') {
    process.stdout.write(
      `${JSON.stringify(await invoke(config, process.argv[4], JSON.parse(process.argv[5] || '{}')))}\n`,
    )
    return
  }
  let active = 0
  const handle = async (line) => {
    let request
    let counted = false
    try {
      if (Buffer.byteLength(line) > 1048576) throw new Error('MCP request exceeded its byte budget')
      request = JSON.parse(line)
      if (request.jsonrpc !== '2.0' || Array.isArray(request)) throw new Error('Invalid MCP request')
      if (!Object.hasOwn(request, 'id')) return
      if (active >= 8) throw new Error('Connector client is busy')
      active += 1
      counted = true
      let result
      switch (request.method) {
        case 'initialize':
          if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(request.params?.protocolVersion))
            throw new Error('Unsupported MCP protocol')
          result = {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'Relay', version: '0.1.0' },
          }
          break
        case 'ping':
          result = {}
          break
        case 'tools/list':
          result = {
            tools: (config.operations || []).map(({ name, description, inputSchema, readOnly }) => ({
              name,
              description,
              inputSchema,
              annotations: { readOnlyHint: readOnly === true, openWorldHint: true },
            })),
          }
          break
        case 'tools/call': {
          const operation = (config.operations || []).find((operation) => operation.name === request.params?.name)
          if (!operation) throw new Error('Operation is not in this connector grant')
          const value = await invoke(config, operation.name, request.params?.arguments || {})
          result =
            value && Array.isArray(value.content) ? value : { content: [{ type: 'text', text: JSON.stringify(value) }] }
          break
        }
        default:
          throw new Error('Unsupported MCP method')
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
    } catch {
      const mutation =
        request?.method === 'tools/call' &&
        (config.operations || []).some(
          (operation) => operation.name === request.params?.name && operation.readOnly !== true,
        )
      if (request && Object.hasOwn(request, 'id'))
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: mutation ? 'This change could not be confirmed. Check the provider before retrying.' : 'The connector request failed or was denied.' } })}\n`,
        )
    } finally {
      if (counted) active -= 1
    }
  }
  let pending = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    const buffer = Buffer.concat([pending, chunk])
    let start = 0
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      if (end - start > 1048576) throw new Error('MCP request exceeded its byte budget')
      void handle(buffer.subarray(start, end).toString('utf8'))
      start = end + 1
    }
    pending = buffer.subarray(start)
    if (pending.length > 1048576) throw new Error('MCP request exceeded its byte budget')
  }
  if (pending.length) void handle(pending.toString('utf8'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Relay client failed. Check the private grant configuration and connection.\n')
    process.exitCode = 1
  })
}
