#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
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
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > limit ||
        (process.getuid && metadata.uid !== process.getuid()))
      throw new Error('Connector credentials require an owner-only regular file')
    const bytes = Buffer.alloc(limit + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total > limit) throw new Error('Connector credentials exceed their byte budget')
    return bytes.subarray(0, total).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readConfiguration(file) {
  const config = JSON.parse(await privateFile(file))
  const generation = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
  if (!config || !uuid(config.connectionId) || !uuid(config.delegationId) ||
      !generation(config.recoveryGeneration) || !generation(config.credentialGeneration) ||
      config.clientService !== 'tengri-web' || config.binding?.service !== 'tengri' ||
      !uuid(config.binding.id) || !uuid(config.binding.generation) ||
      typeof config.keyFile !== 'string' || !config.keyFile || typeof config.endpoint !== 'string' ||
      typeof config.connectorId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(config.connectorId) ||
      typeof config.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.credential) ||
      !Array.isArray(config.operations) || config.operations.length < 1 || config.operations.length > 128 ||
      config.operations.some((operation) => !operation || typeof operation.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(operation.name) || operation.readOnly !== true || operation.inputSchema?.type !== 'object') ||
      new Set(config.operations.map((operation) => operation.name)).size !== config.operations.length)
    throw new Error('Invalid read-only connector configuration')
  return config
}

async function readRelayResponse(response) {
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function lookupExecution(config, body, operationId, send, httpStatus) {
  const failure = httpStatus ? `Relay returned HTTP ${httpStatus}` : 'Relay did not return a usable result'
  const prefix = `${failure} for operation ${operationId}.`
  const unknown = {
    content: [
      {
        type: 'text',
        text: `${prefix} Its outcome could not be confirmed. The request was not resent.`,
      },
    ],
    isError: true,
    _meta: { relay: { operationId, outcome: 'unknown' } },
  }
  try {
    const lookup = Buffer.from(
      JSON.stringify({
        executionBody: body.toString('utf8'),
        binding: config.binding,
        delegationId: config.delegationId,
      }),
    )
    const response = await send('lookup', lookup)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Execution lookup unavailable')
    }
    const result = await readRelayResponse(response)
    const execution = result?.execution
    const status = execution?.upstreamStatus ?? 0
    const resultHash = execution?.resultHash ?? ''
    if (
      !execution ||
      execution.operationId !== operationId ||
      execution.requestHash !== createHash('sha256').update(body).digest('base64') ||
      !['started', 'succeeded', 'failed', 'withheld'].includes(execution.outcome) ||
      !uuid(execution.authorizationReceiptId) ||
      !uuid(execution.executionReceiptId) ||
      !uuid(result.lookupReceiptId) ||
      !Number.isInteger(status) ||
      status < 0 ||
      status > 599 ||
      typeof execution.updatedAtUnixMs !== 'string' ||
      !/^[0-9]{1,16}$/.test(execution.updatedAtUnixMs) ||
      !Number.isSafeInteger(Number(execution.updatedAtUnixMs)) ||
      Number(execution.updatedAtUnixMs) <= 0 ||
      (resultHash !== '' && (typeof resultHash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(resultHash))) ||
      (['succeeded', 'withheld'].includes(execution.outcome) && resultHash === '')
    )
      throw new Error('Invalid execution snapshot')
    const metadata = {
      operationId,
      outcome: execution.outcome,
      authorizationReceiptId: execution.authorizationReceiptId,
      executionReceiptId: execution.executionReceiptId,
      lookupReceiptId: result.lookupReceiptId,
      upstreamStatus: status,
      updatedAtUnixMs: execution.updatedAtUnixMs,
    }
    const text = `${prefix} Relay recorded its outcome as ${execution.outcome}. The original result is unavailable. The request was not resent.`
    return { content: [{ type: 'text', text }], isError: true, _meta: { relay: metadata } }
  } catch {
    return unknown
  }
}

export async function invoke(config, operation, args, fetcher = fetch) {
  const endpoint = new URL(config.endpoint)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/platform/relay/agent'
  )
    throw new Error('An HTTPS Relay client endpoint is required')
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.credential) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(operation))
    throw new Error('Invalid connector grant configuration')
  const operationId = randomUUID()
  const body = Buffer.from(
    JSON.stringify({
      operationId,
      clientService: config.clientService,
      connectorId: config.connectorId,
      operation,
      arguments: args,
      binding: config.binding,
      delegationId: config.delegationId,
    }),
  )
  if (body.length > 65536) throw new Error('Connector arguments exceed their byte budget')
  const privateKey = await privateFile(config.keyFile, 16384)
  const send = (kind, bytes) =>
    fetcher(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(40000),
      headers: {
        'content-type': 'application/json',
        authorization: `DPoP ${config.credential}`,
        dpop: proofFor({ endpoint: endpoint.toString(), credential: config.credential, privateKey, body: bytes }),
        'x-relay-delegation': config.delegationId,
      },
      body: JSON.stringify({ kind, body: bytes.toString('base64') }),
    })
  let response
  try {
    response = await send('execute', body)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Relay execution failed')
    }
    const result = await readRelayResponse(response)
    if (
      result?.operationId !== operationId ||
      !uuid(result.authorizationReceiptId) ||
      !uuid(result.executionReceiptId) ||
      typeof result.result !== 'string'
    )
      throw new Error('Relay execution receipt is invalid')
    return {
      content: [{ type: 'text', text: result.result }],
      isError: false,
      _meta: {
        relay: {
          operationId,
          outcome: 'succeeded',
          authorizationReceiptId: result.authorizationReceiptId,
          executionReceiptId: result.executionReceiptId,
        },
      },
    }
  } catch {
    return lookupExecution(config, body, operationId, send, response?.ok === false ? response.status : undefined)
  }
}

async function main() {
  if (process.argv[2] === 'keygen') {
    if (!process.argv[3]) throw new Error('Supply an exclusive private-key file path')
    process.stdout.write(`${JSON.stringify(await generateIdentity(process.argv[3]))}\n`)
    return
  }
  const file = process.argv[2]
  if (!file) throw new Error('Supply the owner-only connector grant configuration file')
  await readConfiguration(file)
  if (process.argv[3] === 'call') {
    const config = await readConfiguration(file)
    if (!config.operations.some((operation) => operation.name === process.argv[4]))
      throw new Error('Operation is not in this connector connection')
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
      const config = await readConfiguration(file)
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
            tools: config.operations.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
              annotations: { readOnlyHint: true, openWorldHint: true },
            })),
          }
          break
        case 'tools/call': {
          const operation = config.operations.find((operation) => operation.name === request.params?.name)
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
      if (request && Object.hasOwn(request, 'id'))
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'The connector request failed or was denied.' } })}\n`,
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
