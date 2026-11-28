import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { expect, it } from 'vitest'

import { AutoOntologyIdentityError } from './identity'
import { createAutoOntologyGatewayHandler } from './server'
import { createAutoOntologyUpstream } from './upstream'

it('runs the stdio bridge through the HTTP gateway and rereads the projected token on rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-ontology-bridge-'))
  const tokenPath = join(directory, 'token')
  let token = 'projected-token-1'
  const upstream = createAutoOntologyUpstream({
    url: new URL('http://localhost:3000'),
    maxResponseBytes: 1024,
    token: 'auto_ontology_gateway_test',
    timeoutMs: 1000,
    chatTimeoutMs: 1000,
    fetch: async (input, init) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('auto_ontology_gateway_test')
      expect(String(input)).toBe('http://localhost:3000/api/terms?limit=25')
      return Response.json({ data: [{ id: 'term-1' }] })
    },
  })
  const handler = createAutoOntologyGatewayHandler({
    upstream,
    maxRequestBytes: 8192,
    verify: async (candidate) => {
      if (candidate !== token) throw new AutoOntologyIdentityError(401, 'invalid_token')
    },
  })
  const http = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const result = await handler(
      new Request(`http://localhost${request.url}`, {
        method: request.method,
        headers: new Headers(request.headers as Record<string, string>),
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }),
    )
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  const client = new Client({ name: 'stdio-test', version: '1' })
  try {
    await writeFile(tokenPath, `${token}\n`)
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('test gateway did not receive a TCP port')
    const transport = new StdioClientTransport({
      command: 'bun',
      args: [fileURLToPath(new URL('../../scripts/codex/auto-ontology-mcp-bridge.ts', import.meta.url))],
      env: {
        AUTO_ONTOLOGY_MCP_GATEWAY_URL: `http://127.0.0.1:${address.port}/mcp`,
        AGENTS_MCP_IDENTITY_TOKEN_PATH: tokenPath,
      },
    })
    await client.connect(transport, { timeout: 5000 })
    expect((await client.listTools()).tools).toHaveLength(12)
    const call = () => client.callTool({ name: 'search_terms' }, CallToolResultSchema, { timeout: 5000 })
    const expected = { data: [{ id: 'term-1' }] }
    expect((await call()).structuredContent).toEqual(expected)
    token = 'projected-token-2'
    await writeFile(tokenPath, token)
    expect((await call()).structuredContent).toEqual(expected)
  } finally {
    await client.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
