import { readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import { getDb } from '../db'
import { createKubernetesClient } from '../kube-types'
import { createPrimitivesStore } from '../primitives-store'
import { resolveAgentRunsApiDependencies } from '../v1/runtime'
import { invocationSchema, isRelayRunTool, relayRunToolDefinitions, targetSchema, type Target } from './contract'
import { createRelayRunsService, createRelayRunsDependencies } from './service'
import { createSubmissionStore } from './store'

export const RELAY_ID = 'spiffe://proompteng.ai/ns/relay/sa/relay'
export const RELAY_AUDIENCE = 'https://agents.k8s.proompteng.ai/mcp/relay'
const jwks = createRemoteJWKSet(new URL('https://oidc.proompteng.ai/keys'), { timeoutDuration: 3000 })
export const verifyRelayToken = async (token: string, keys: Parameters<typeof jwtVerify>[1] = jwks) => {
  if (!token || token.length > 16_384) throw new Error('invalid workload token')
  await jwtVerify(token, keys, {
    audience: RELAY_AUDIENCE,
    subject: RELAY_ID,
    algorithms: ['ES256', 'RS256'],
    requiredClaims: ['sub', 'aud', 'exp'],
  })
}
const json = (status: number, error: string) => Response.json({ error }, { status })

const boundedRequest = async (request: Request) => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON required')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('request body required')
  const chunks: Uint8Array[] = []
  let bytes = 0
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(5000)])
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  deadline.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const item = await reader.read()
      deadline.throwIfAborted()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 65_536) throw new Error('request body too large')
      chunks.push(item.value)
    }
  } finally {
    deadline.removeEventListener('abort', cancel)
    await reader.cancel()
  }
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: Buffer.concat(chunks),
    signal: request.signal,
  })
}

export const createRelayMcpHandler =
  (options: {
    targets: Record<string, Target>
    verify: (token: string) => Promise<void>
    service: ReturnType<typeof createRelayRunsService>
  }) =>
  async (request: Request, targetName: string) => {
    const target = options.targets[targetName]
    if (!target) return json(404, 'target_not_found')
    const authorization = request.headers.get('authorization')
    if (!authorization?.startsWith('Bearer ')) return json(401, 'workload_identity_required')
    const token = authorization.slice(7)
    try {
      await options.verify(token)
    } catch {
      return json(401, 'invalid_workload_identity')
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    let bounded: Request
    try {
      bounded = await boundedRequest(request)
    } catch {
      return json(400, 'invalid_mcp_request')
    }
    const server = new Server({ name: 'agents-relay', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: relayRunToolDefinitions() }))
    server.setRequestHandler(CallToolRequestSchema, async (message) => {
      try {
        await options.verify(token)
        if (!isRelayRunTool(message.params.name)) throw new Error('tool is not registered')
        const invocation = invocationSchema.parse(message.params._meta?.['io.proompteng.relay'])
        const value = await options.service.call(
          message.params.name,
          message.params.arguments ?? {},
          invocation,
          target,
        )
        await options.verify(token)
        const result = { kind: 'agent-run', targetId: target.id, run: value }
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 240_000) throw new Error('run response exceeds its byte budget')
        return { content: [{ type: 'text', text: target.name }], structuredContent: result }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof z.ZodError
                  ? 'Invalid tool arguments or invocation context'
                  : error instanceof Error
                    ? error.message
                    : 'AgentRun request failed',
            },
          ],
        }
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      const response = await transport.handleRequest(bounded)
      response.headers.set('cache-control', 'no-store')
      return response
    } finally {
      await transport.close()
      await server.close()
    }
  }

let handler: ReturnType<typeof createRelayMcpHandler> | undefined
export const handleRelayMcpRequest = async (request: Request, targetName: string) => {
  if (!handler) {
    const path = process.env.AGENTS_RELAY_TARGETS_FILE
    if (!path) return json(404, 'relay_not_configured')
    const targets = z
      .record(z.string().regex(/^[a-z0-9-]{1,64}$/), targetSchema)
      .parse(JSON.parse(await readFile(path, 'utf8')))
    const db = getDb()
    const submission = await resolveAgentRunsApiDependencies()
    if (!db || !submission.ok) return json(503, 'agents_unavailable')
    handler = createRelayMcpHandler({
      targets,
      verify: verifyRelayToken,
      service: createRelayRunsService(
        createRelayRunsDependencies({
          submissions: createSubmissionStore(db),
          primitives: createPrimitivesStore,
          kube: createKubernetesClient(),
          submission: submission.value,
        }),
      ),
    })
  }
  return handler(request, targetName)
}
