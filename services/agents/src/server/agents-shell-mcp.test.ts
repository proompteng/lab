import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AgentsShellRunner,
  buildBearerChallenge,
  createAgentsShellRequestHandler,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  normalizeMcpAcceptHeader,
  oauthProtectedResourceMetadata,
  resolveWorkspacePath,
  startAgentsShellServer,
  type AgentsShellConfig,
  type AuthContext,
} from './agents-shell-mcp'

const tempRoots: string[] = []

const makeConfig = (): AgentsShellConfig => {
  const root = join(tmpdir(), `agents-shell-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tempRoots.push(root)
  return defaultAgentsShellConfigFromEnv({
    AGENTS_SHELL_RESOURCE: 'https://agents-shell.example.test',
    AGENTS_SHELL_OAUTH_ISSUER: 'https://auth.example.test/realms/master',
    AGENTS_SHELL_WORKSPACE_ROOT: root,
    AGENTS_SHELL_AUDIT_LOG_PATH: '',
    AGENTS_SHELL_ALLOWED_K8S_NAMESPACES: 'agents',
    AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS: '5',
    AGENTS_SHELL_MAX_TIMEOUT_SECONDS: '30',
  })
}

const makeAuth = (scopes = ['agents-shell.read', 'agents-shell.write']): AuthContext => ({
  subject: 'user-1',
  email: 'greg@proompteng.ai',
  scopes: new Set(scopes),
  payload: {
    sub: 'user-1',
    email: 'greg@proompteng.ai',
    scope: scopes.join(' '),
  },
})

const randomListenPort = () => 30_000 + Math.floor(Math.random() * 20_000)

const connectServer = async (config: AgentsShellConfig, auth = makeAuth()) => {
  const runner = new AgentsShellRunner(config)
  const server = createAgentsShellServer(config, runner, auth)
  const client = new Client({ name: 'agents-shell-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server, clientTransport, serverTransport }
}

const listToolsOnWire = async (config: AgentsShellConfig, auth = makeAuth()) => {
  const runner = new AgentsShellRunner(config)
  const server = createAgentsShellServer(config, runner, auth)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const response = await new Promise<{
    result?: {
      tools?: Array<{
        name?: string
        inputSchema?: Record<string, unknown>
        outputSchema?: Record<string, unknown>
        securitySchemes?: unknown
        _meta?: Record<string, unknown>
      }>
    }
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for tools/list response')), 1000)
    clientTransport.onmessage = (message) => {
      clearTimeout(timeout)
      resolve(
        message as {
          result?: {
            tools?: Array<{
              name?: string
              inputSchema?: Record<string, unknown>
              outputSchema?: Record<string, unknown>
              securitySchemes?: unknown
              _meta?: Record<string, unknown>
            }>
          }
        },
      )
    }
    void clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })

  await clientTransport.close()
  await serverTransport.close()
  await server.close()
  return response.result?.tools ?? []
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('agents-shell MCP OAuth metadata', () => {
  it('ignores Kubernetes service AGENTS_SHELL_PORT env when selecting its listen port', () => {
    expect(
      defaultAgentsShellConfigFromEnv({
        AGENTS_SHELL_PORT: 'tcp://10.96.0.1:80',
      }).port,
    ).toBe(8080)

    expect(
      defaultAgentsShellConfigFromEnv({
        AGENTS_SHELL_PORT: 'tcp://10.96.0.1:80',
        AGENTS_SHELL_LISTEN_PORT: '8090',
      }).port,
    ).toBe(8090)
  })

  it('publishes protected-resource metadata for ChatGPT OAuth discovery', () => {
    const config = makeConfig()
    expect(oauthProtectedResourceMetadata(config)).toEqual({
      resource: 'https://agents-shell.example.test',
      authorization_servers: ['https://auth.example.test/realms/master'],
      scopes_supported: [
        'openid',
        'email',
        'profile',
        'offline_access',
        'agents-shell.read',
        'agents-shell.write',
        'agents-shell.admin',
      ],
      bearer_methods_supported: ['header'],
    })
    expect(buildBearerChallenge(config)).toBe(
      'Bearer resource_metadata="https://agents-shell.example.test/.well-known/oauth-protected-resource"',
    )
  })

  it('normalizes MCP Accept headers for ChatGPT metadata clients', () => {
    expect(normalizeMcpAcceptHeader('application/json')).toBe('application/json, text/event-stream')
    expect(normalizeMcpAcceptHeader('*/*')).toBe('application/json, text/event-stream')
    expect(normalizeMcpAcceptHeader('application/json, text/event-stream')).toBe('application/json, text/event-stream')
  })

  it('serves MCP over a fetch-native HTTP handler', async () => {
    const config = makeConfig()
    const handler = createAgentsShellRequestHandler(config)

    const response = await handler(
      new Request('https://agents-shell.example.test/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } }
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['shell_run', 'kubectl']))
  })

  it.skipIf(typeof (globalThis as { Bun?: unknown }).Bun === 'undefined')(
    'serves MCP through Bun.serve without hanging',
    async () => {
      const config = { ...makeConfig(), host: '127.0.0.1', port: randomListenPort() }
      const server = startAgentsShellServer(config)

      try {
        const response = await fetch(`http://${server.hostname}:${server.port}/mcp`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(2000),
        })

        expect(response.status).toBe(200)
        const body = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } }
        expect(body.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['shell_run', 'kubectl']))
      } finally {
        server.stop(true)
      }
    },
  )

  it('rejects workspace paths outside the configured root', () => {
    const config = makeConfig()
    expect(() => resolveWorkspacePath(config.workspaceRoot, '../escape')).toThrow(/path must stay under/)
    expect(resolveWorkspacePath(config.workspaceRoot, '.')).toBe(config.workspaceRoot)
  })
})

describe('agents-shell MCP tools', () => {
  it('lists focused tools with annotations and OAuth metadata', async () => {
    const config = makeConfig()
    const { client, server, clientTransport, serverTransport } = await connectServer(config)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'workspace_search',
        'workspace_read_file',
        'workspace_apply_patch',
        'shell_run',
        'shell_start',
        'shell_read',
        'shell_kill',
        'shell_status',
        'git',
        'git_write',
        'kubectl',
        'kubectl_admin',
      ]),
    )
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['git_status', 'git_diff', 'k8s_get', 'k8s_apply']),
    )

    const search = tools.tools.find((tool) => tool.name === 'workspace_search')
    expect(search?.annotations?.readOnlyHint).toBe(true)
    expect(search?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }],
      ui: { visibility: ['model'] },
      'openai/visibility': 'public',
      'openai/toolInvocation/invoking': 'Running tool',
      'openai/toolInvocation/invoked': 'Tool complete',
    })

    const shellRun = tools.tools.find((tool) => tool.name === 'shell_run')
    expect(shellRun?.annotations?.destructiveHint).toBe(false)
    expect(shellRun?.annotations?.openWorldHint).toBe(true)

    const git = tools.tools.find((tool) => tool.name === 'git')
    expect(git?.annotations?.readOnlyHint).toBe(true)
    expect(git?.annotations?.destructiveHint).toBe(false)
    expect(git?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }],
    })

    const gitWrite = tools.tools.find((tool) => tool.name === 'git_write')
    expect(gitWrite?.annotations?.destructiveHint).toBe(true)
    expect(gitWrite?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.write', 'offline_access'] }],
    })

    const kubectl = tools.tools.find((tool) => tool.name === 'kubectl')
    expect(kubectl?.annotations?.readOnlyHint).toBe(true)
    expect(kubectl?.annotations?.destructiveHint).toBe(false)
    expect(kubectl?.annotations?.openWorldHint).toBe(true)
    expect(kubectl?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }],
    })

    const kubectlAdmin = tools.tools.find((tool) => tool.name === 'kubectl_admin')
    expect(kubectlAdmin?.annotations?.destructiveHint).toBe(true)
    expect(kubectlAdmin?.annotations?.openWorldHint).toBe(true)
    expect(kubectlAdmin?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.admin', 'offline_access'] }],
    })

    await clientTransport.close()
    await serverTransport.close()
    await client.close()
    await server.close()

    const rawTools = await listToolsOnWire(config)
    const rawSearch = rawTools.find((tool) => tool.name === 'workspace_search')
    expect(rawSearch?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }])
    expect(rawSearch?._meta).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }],
      ui: { visibility: ['model'] },
      'openai/visibility': 'public',
      'openai/toolInvocation/invoking': 'Running tool',
      'openai/toolInvocation/invoked': 'Tool complete',
    })
    expect(rawSearch?.inputSchema?.$schema).toBeUndefined()
    expect(rawSearch?.inputSchema?.additionalProperties).toBe(false)

    const rawShellRun = rawTools.find((tool) => tool.name === 'shell_run')
    expect(
      (rawShellRun?.inputSchema?.properties as Record<string, Record<string, unknown>>).timeoutSeconds.maximum,
    ).toBeUndefined()
    expect(
      (rawShellRun?.inputSchema?.properties as Record<string, Record<string, unknown>>).maxOutputBytes.maximum,
    ).toBeUndefined()
    expect(
      (rawShellRun?.outputSchema?.properties as Record<string, Record<string, unknown>>).exitCode.minimum,
    ).toBeUndefined()
    expect(
      (rawShellRun?.outputSchema?.properties as Record<string, Record<string, unknown>>).exitCode.anyOf,
    ).toBeUndefined()
    expect((rawShellRun?.outputSchema?.properties as Record<string, Record<string, unknown>>).exitCode.type).toEqual([
      'integer',
      'null',
    ])

    const rawKubectl = rawTools.find((tool) => tool.name === 'kubectl')
    expect(rawKubectl?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }])
    expect(rawKubectl?.inputSchema?.additionalProperties).toBe(false)
  })

  it('lists tools before OAuth but challenges protected tool calls', async () => {
    const config = makeConfig()
    const { client, server, clientTransport, serverTransport } = await connectServer(config, makeAuth([]))

    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'shell_run')).toBe(true)

    const result = await client.callTool({
      name: 'shell_run',
      arguments: { command: 'echo should-not-run' },
    })
    expect(result.isError).toBe(true)
    expect(result._meta?.['mcp/www_authenticate']).toEqual([
      'Bearer resource_metadata="https://agents-shell.example.test/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="The requested agents-shell tool requires additional OAuth scopes."',
    ])

    await clientTransport.close()
    await serverTransport.close()
    await client.close()
    await server.close()
  })

  it('reads files and blocks patch paths outside /workspace', async () => {
    const config = makeConfig()
    writeFileSync(join(config.workspaceRoot, 'hello.txt'), 'hello from agents-shell\n')
    const { client, server, clientTransport, serverTransport } = await connectServer(config)

    const read = await client.callTool({
      name: 'workspace_read_file',
      arguments: { path: 'hello.txt' },
    })
    expect((read.structuredContent as { content?: string } | undefined)?.content).toBe('hello from agents-shell\n')

    const blocked = await client.callTool({
      name: 'workspace_apply_patch',
      arguments: {
        patch:
          'diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+nope\n',
      },
    })
    expect(blocked.isError).toBe(true)
    const blockedContent = blocked.content as Array<{ type: string; text?: string }>
    expect(blockedContent[0]?.type).toBe('text')
    expect(blockedContent[0]?.text ?? '').toContain('patch path must stay under workspace')

    await clientTransport.close()
    await serverTransport.close()
    await client.close()
    await server.close()
  })

  it('returns an OAuth challenge when a tool lacks required scope', async () => {
    const config = makeConfig()
    const { client, server, clientTransport, serverTransport } = await connectServer(
      config,
      makeAuth(['agents-shell.read']),
    )

    const result = await client.callTool({
      name: 'shell_run',
      arguments: { command: 'echo should-not-run' },
    })
    expect(result.isError).toBe(true)
    expect(result._meta?.['mcp/www_authenticate']).toEqual([
      'Bearer resource_metadata="https://agents-shell.example.test/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="The requested agents-shell tool requires additional OAuth scopes."',
    ])

    await clientTransport.close()
    await serverTransport.close()
    await client.close()
    await server.close()
  })

  it('forwards generic read-only kubectl argv without using the admin tool', async () => {
    const config = makeConfig()
    const bin = join(config.workspaceRoot, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(join(bin, 'kubectl'), 0o755)

    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ''}`

    const { client, server, clientTransport, serverTransport } = await connectServer(
      config,
      makeAuth(['agents-shell.read', 'agents-shell.write', 'agents-shell.admin']),
    )

    try {
      const result = await client.callTool({
        name: 'kubectl',
        arguments: { args: ['get', 'pods', '-n', 'agents', '-o', 'wide'] },
      })
      expect(result.isError).not.toBe(true)
      expect((result.structuredContent as { stdout?: string } | undefined)?.stdout).toBe(
        'get\npods\n-n\nagents\n-o\nwide\n',
      )

      const blocked = await client.callTool({
        name: 'kubectl',
        arguments: { args: ['exec', 'pod/example', '--', 'echo', 'ok'] },
      })
      expect(blocked.isError).toBe(true)
      const blockedContent = blocked.content as Array<{ type: string; text?: string }>
      expect(blockedContent[0]?.text ?? '').toContain('use kubectl_admin')

      const admin = await client.callTool({
        name: 'kubectl_admin',
        arguments: { args: ['exec', 'pod/example', '--', 'echo', 'ok'] },
      })
      expect(admin.isError).not.toBe(true)
      expect((admin.structuredContent as { stdout?: string } | undefined)?.stdout).toBe(
        'exec\npod/example\n--\necho\nok\n',
      )
    } finally {
      await clientTransport.close()
      await serverTransport.close()
      await client.close()
      await server.close()

      if (previousPath == null) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
    }
  })
})
