import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentsShellRunner,
  buildBearerChallenge,
  createAgentsShellRequestHandler,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  normalizeMcpAcceptHeader,
  oauthIdentityAllowed,
  oauthProtectedResourceMetadata,
  resolveWorkspacePath,
} from './agents-shell-mcp'
import {
  cleanupFixtures,
  closeFixtureConnection,
  connectFixture,
  findTestExecutable,
  fixtureExecutables,
  listToolsOnWire,
  makeAuth,
  makeFixture,
  writeTrustedExecutable,
} from './agents-shell-test-helpers'

const linkedOauthScheme = [{ type: 'oauth2', scopes: ['agents-shell.read', 'offline_access'] }]

const mcpRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://agents-shell.example.test/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agents-shell-test', version: '0.0.0' },
  },
}

afterEach(() => {
  cleanupFixtures()
  vi.restoreAllMocks()
})

describe('agents-shell OAuth and HTTP transport', () => {
  it('stops the Bun server and exits after SIGTERM', async () => {
    const fixture = makeFixture()
    const script = join(fixture.root, 'termination-server.ts')
    const httpModule = pathToFileURL(resolve(process.cwd(), 'src/server/agents-shell/http.ts')).href
    const helperModule = pathToFileURL(resolve(process.cwd(), 'src/server/agents-shell-test-helpers.ts')).href
    writeFileSync(
      script,
      `import { startAgentsShellServer } from ${JSON.stringify(httpModule)}
import { makeFixture } from ${JSON.stringify(helperModule)}
const fixture = makeFixture()
fixture.config.port = 0
const server = startAgentsShellServer(fixture.config)
console.log('termination-server-ready:' + server.port)
`,
    )

    const child = spawn(findTestExecutable('bun'), [script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    try {
      await Promise.race([
        new Promise<void>((resolveReady, reject) => {
          const inspect = () => {
            if (stdout.includes('termination-server-ready:')) resolveReady()
            else if (child.exitCode != null) reject(new Error(`termination server exited early: ${stderr || stdout}`))
            else setTimeout(inspect, 10)
          }
          inspect()
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`termination server did not become ready: ${stderr || stdout}`)), 3000),
        ),
      ])
      child.kill('SIGTERM')
      const outcome = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
          child.once('close', (code, signal) => resolveClose({ code, signal }))
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`termination server remained alive after SIGTERM: ${stderr || stdout}`)),
            2000,
          ),
        ),
      ])
      expect(outcome).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    }
  }, 10_000)

  it('ignores Kubernetes service env when selecting the listen port', () => {
    expect(defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_PORT: 'tcp://10.96.0.1:80' }).port).toBe(8080)
    expect(
      defaultAgentsShellConfigFromEnv({
        AGENTS_SHELL_PORT: 'tcp://10.96.0.1:80',
        AGENTS_SHELL_LISTEN_PORT: '8090',
      }).port,
    ).toBe(8090)
  })

  it('publishes protected-resource metadata and normalizes ChatGPT Accept headers', () => {
    const fixture = makeFixture()
    expect(oauthProtectedResourceMetadata(fixture.config)).toEqual({
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
    expect(buildBearerChallenge(fixture.config)).toBe(
      'Bearer resource_metadata="https://agents-shell.example.test/.well-known/oauth-protected-resource"',
    )
    expect(normalizeMcpAcceptHeader('*/*')).toBe('application/json, text/event-stream')
    expect(normalizeMcpAcceptHeader('application/json, text/event-stream')).toBe('application/json, text/event-stream')
  })

  it('allows configured email or username identities', () => {
    const config = defaultAgentsShellConfigFromEnv({
      AGENTS_SHELL_ALLOWED_EMAILS: 'greg@proompteng.ai',
      AGENTS_SHELL_ALLOWED_USERNAMES: 'admin,agents-shell-chatgpt',
    })
    expect(oauthIdentityAllowed(config, { subject: '1', email: 'greg@proompteng.ai', username: null })).toBe(true)
    expect(oauthIdentityAllowed(config, { subject: '2', email: null, username: 'admin' })).toBe(true)
    expect(oauthIdentityAllowed(config, { subject: '3', email: null, username: 'unknown' })).toBe(false)
  })

  it('keeps stateless tools/list compatibility while rejecting ephemeral lease acquisition', async () => {
    const fixture = makeFixture()
    const handler = createAgentsShellRequestHandler(fixture.config)
    const list = await handler(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
    expect(list.status).toBe(200)
    const body = (await list.json()) as { result?: { tools?: Array<{ name?: string }> } }
    expect(body.result?.tools?.map((tool) => tool.name)).toContain('workspace_acquire')

    const acquire = await handler(
      mcpRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'workspace_acquire',
          arguments: { task: 'ephemeral', existingPath: fixture.existingWorkspace },
        },
      }),
    )
    expect(acquire.status).toBe(200)
    expect(((await acquire.json()) as { result?: { isError?: boolean } }).result?.isError).toBe(true)
  })

  it('issues an unforgeable stateful MCP session during initialize', async () => {
    const fixture = makeFixture()
    const auth = makeAuth()
    const verifier = { verify: vi.fn(async () => auth) }
    const handler = createAgentsShellRequestHandler(fixture.config, undefined, verifier)
    const initialized = await handler(mcpRequest(initializeBody, { authorization: 'Bearer valid' }))
    expect(initialized.status).toBe(200)
    const sessionId = initialized.headers.get('mcp-session-id')
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const acquired = await handler(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'workspace_acquire',
            arguments: { task: 'stateful', existingPath: fixture.existingWorkspace },
          },
        },
        { authorization: 'Bearer valid', 'mcp-session-id': sessionId! },
      ),
    )
    expect(acquired.status).toBe(200)
    const acquiredBody = (await acquired.json()) as { result?: { isError?: boolean; structuredContent?: unknown } }
    expect(acquiredBody.result?.isError).not.toBe(true)
    expect(acquiredBody.result?.structuredContent).toMatchObject({ status: 'active' })
    expect(readFileSync(fixture.auditLogPath, 'utf8')).not.toContain(sessionId!)
  })

  it('keeps overlapping stateful request authentication immutable and request-local', async () => {
    const fixture = makeFixture()
    const owner = makeAuth(undefined, 'owner-subject')
    const foreign = makeAuth(undefined, 'foreign-subject')
    let markForeignAuthenticated!: () => void
    const foreignAuthenticated = new Promise<void>((resolve) => {
      markForeignAuthenticated = resolve
    })
    const verifier = {
      verify: vi.fn(async (token: string) => {
        if (token === 'owner-token') return owner
        if (token === 'foreign-token') {
          markForeignAuthenticated()
          return foreign
        }
        throw new Error('unexpected token')
      }),
    }
    let enteredAnonymousDispatch!: () => void
    let releaseAnonymousDispatch!: () => void
    const anonymousDispatchEntered = new Promise<void>((resolve) => {
      enteredAnonymousDispatch = resolve
    })
    const anonymousDispatchReleased = new Promise<void>((resolve) => {
      releaseAnonymousDispatch = resolve
    })
    const handler = createAgentsShellRequestHandler(fixture.config, undefined, verifier, {
      beforeStatefulDispatch: async (auth) => {
        if (auth.subject !== 'unauthenticated') return
        enteredAnonymousDispatch()
        await anonymousDispatchReleased
      },
    })
    const initialized = await handler(mcpRequest(initializeBody, { authorization: 'Bearer owner-token' }))
    const sessionId = initialized.headers.get('mcp-session-id')!
    const kubectlCall = (id: number, headers: Record<string, string>) =>
      handler(
        mcpRequest(
          {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'kubectl', arguments: { args: ['version', '--client'] } },
          },
          { 'mcp-session-id': sessionId, ...headers },
        ),
      )

    const anonymousRequest = kubectlCall(2, {})
    await anonymousDispatchEntered
    const foreignRequest = kubectlCall(3, { authorization: 'Bearer foreign-token' })
    await foreignAuthenticated
    releaseAnonymousDispatch()

    const [anonymousResponse, foreignResponse] = await Promise.all([anonymousRequest, foreignRequest])
    expect(foreignResponse.status).toBe(404)
    expect(JSON.stringify(await foreignResponse.json())).not.toContain('kubectl-fixture')
    expect(anonymousResponse.status).toBe(200)
    const anonymousBody = (await anonymousResponse.json()) as { result?: { isError?: boolean } }
    expect(anonymousBody.result?.isError).toBe(true)
    expect(JSON.stringify(anonymousBody)).not.toContain('kubectl-fixture')
    expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('token_revoked_or_missing')
  })

  it('rejects unauthenticated initialize without retaining stateful sessions', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const verifier = { verify: vi.fn(async () => Promise.reject(new Error('invalid token'))) }
    const handler = createAgentsShellRequestHandler(fixture.config, runner, verifier)
    try {
      const unauthenticatedHeaders: Array<Record<string, string>> = [{}, { authorization: 'Bearer invalid' }]
      for (const headers of unauthenticatedHeaders) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await handler(mcpRequest(initializeBody, headers))
          expect(response.status).toBe(401)
          expect(response.headers.get('mcp-session-id')).toBeNull()
          expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
        }
      }
      const ready = await handler(new Request('https://agents-shell.example.test/readyz'))
      expect(await ready.json()).toMatchObject({ activeSessions: 0 })
      expect(readFileSync(fixture.auditLogPath, 'utf8')).not.toContain('mcp_session_issued')
    } finally {
      runner.shutdown()
    }
  })

  it('keeps invalid bearer tokens inside the MCP OAuth challenge flow', async () => {
    const fixture = makeFixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const verifier = { verify: vi.fn(async () => Promise.reject(new Error('bad token'))) }
    const handler = createAgentsShellRequestHandler(fixture.config, undefined, verifier)
    const response = await handler(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'shell_run', arguments: { command: 'echo should-not-run' } },
        },
        { authorization: 'Bearer not-a-jwt' },
      ),
    )
    const body = (await response.json()) as { result?: { isError?: boolean; _meta?: Record<string, unknown> } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?._meta?.['mcp/www_authenticate']).toEqual([
      'Bearer resource_metadata="https://agents-shell.example.test/.well-known/oauth-protected-resource", error="invalid_token", error_description="The access token is invalid or expired."',
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-a-jwt')
  })
})

describe('agents-shell tool contract', () => {
  it('lists the bounded measured tool schema with OAuth metadata', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture)
    try {
      const tools = await connection.client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [
          'workspace_acquire',
          'workspace_status',
          'workspace_release',
          'search',
          'read_file',
          'apply_patch',
          'agent_guide',
          'shell_run',
          'shell_start',
          'shell_read',
          'shell_kill',
          'shell_status',
          'git',
          'git_write',
          'kubectl',
          'kubectl_admin',
          'agent_start',
          'agent_status',
          'agent_read',
          'agent_cancel',
        ].sort(),
      )
      for (const tool of tools.tools) {
        expect(tool.description?.length ?? 0).toBeLessThanOrEqual(140)
        expect(tool.inputSchema.additionalProperties).toBe(false)
      }
      expect(tools.tools.find((tool) => tool.name === 'workspace_acquire')?.annotations?.destructiveHint).toBe(true)
      expect(tools.tools.find((tool) => tool.name === 'read_file')?.annotations?.readOnlyHint).toBe(true)
    } finally {
      await closeFixtureConnection(connection)
    }

    const rawTools = await listToolsOnWire(fixture)
    const bytes = Buffer.byteLength(JSON.stringify({ tools: rawTools }))
    expect(bytes).toBe(19_744)
    expect(bytes).toBeLessThanOrEqual(fixture.config.maxToolSchemaBytes)
    for (const tool of rawTools) {
      expect(tool.securitySchemes).toEqual(linkedOauthScheme)
      expect(tool.inputSchema?.additionalProperties).toBe(false)
    }
  })

  it('fails startup rather than truncating a tool schema over the explicit ceiling', () => {
    const fixture = makeFixture({ maxToolSchemaBytes: 100 })
    const runner = new AgentsShellRunner(fixture.config)
    expect(() => createAgentsShellServer(fixture.config, runner, makeAuth(), crypto.randomUUID())).toThrow(
      /tool schema is .* exceeding explicit ceiling 100/,
    )
    runner.shutdown()
  })

  it('lists tools before OAuth but challenges protected calls', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture, { auth: makeAuth([]) })
    try {
      expect((await connection.client.listTools()).tools.some((tool) => tool.name === 'shell_run')).toBe(true)
      const result = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'echo should-not-run' },
      })
      expect(result.isError).toBe(true)
      expect(result._meta?.['mcp/www_authenticate']).toBeDefined()
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('requires a lease for mutation and supports the normal one-task path', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture)
    try {
      const blocked = await connection.client.callTool({ name: 'shell_run', arguments: { command: 'touch blocked' } })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('active workspace lease is required')

      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'normal', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      const success = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf normal > normal.txt && git add normal.txt && git commit -m normal' },
      })
      expect(success.isError).not.toBe(true)
      expect((success.structuredContent as { exitCode?: number }).exitCode).toBe(0)
      expect(readFileSync(join(fixture.existingWorkspace, 'normal.txt'), 'utf8')).toBe('normal')
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('reads only the seed before acquisition and the owned workspace after acquisition', async () => {
    const fixture = makeFixture()
    writeFileSync(join(fixture.seedPath, 'seed-only.txt'), 'seed-readable\n')
    const connection = await connectFixture(fixture)
    try {
      const seed = await connection.client.callTool({ name: 'read_file', arguments: { path: 'seed-only.txt' } })
      expect((seed.structuredContent as { content?: string }).content).toBe('seed-readable\n')
      await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'read', existingPath: fixture.existingWorkspace },
      })
      writeFileSync(join(fixture.existingWorkspace, 'owned.txt'), 'owned\n')
      const owned = await connection.client.callTool({ name: 'read_file', arguments: { path: 'owned.txt' } })
      expect((owned.structuredContent as { content?: string }).content).toBe('owned\n')
      const foreign = await connection.client.callTool({ name: 'read_file', arguments: { path: fixture.seedPath } })
      expect(foreign.isError).toBe(true)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('inspects the root-owned read-only seed with only a server-controlled safe.directory', async () => {
    const fixture = makeFixture()
    mkdirSync(join(fixture.seedPath, 'nested'))
    const connection = await connectFixture(fixture)
    try {
      const status = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['status', '--short'], cwd: 'nested' },
      })
      expect(status.isError).not.toBe(true)
      expect((status.structuredContent as { exitCode?: number }).exitCode).toBe(0)
      expect(connection.runner.leases.inspectionEnvironment(null, join(fixture.seedPath, 'nested'))).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: fixture.seedPath,
      })
      const injected = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['-c', 'safe.directory=*', 'status'] },
      })
      expect(injected.isError).toBe(true)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('validates patch traversal and applies a normal Codex patch', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture, { acquire: true })
    try {
      const blocked = await connection.client.callTool({
        name: 'apply_patch',
        arguments: {
          patch: '*** Begin Patch\n*** Add File: ../../escape.txt\n+escape\n*** End Patch\n',
        },
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('must stay under leased workspace')

      const applied = await connection.client.callTool({
        name: 'apply_patch',
        arguments: {
          patch: '*** Begin Patch\n*** Add File: safe.txt\n+safe\n*** End Patch\n',
        },
      })
      expect(applied.isError).not.toBe(true)
      expect(readFileSync(join(fixture.existingWorkspace, 'safe.txt'), 'utf8')).toBe('safe\n')
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('rejects read-only Git selectors and external command hooks', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture, { acquire: true })
    try {
      for (const args of [
        ['-C', fixture.seedPath, 'status'],
        ['--git-dir', join(fixture.seedPath, '.git'), 'status'],
        ['--work-tree', fixture.seedPath, 'status'],
        ['-c', 'core.pager=touch /tmp/pwn', 'status'],
        ['diff', '--ext-diff'],
      ]) {
        const result = await connection.client.callTool({ name: 'git', arguments: { args } })
        expect(result.isError).toBe(true)
      }
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('rejects every git grep pager command form before command, secret, or cluster action', async () => {
    const fixture = makeFixture()
    const commandMarker = join(fixture.root, 'grep-pager-command')
    const secretMarker = join(fixture.root, 'grep-pager-secret')
    const clusterMarker = join(fixture.root, 'grep-pager-cluster')
    const serviceAccountToken = join(fixture.root, 'service-account-token')
    writeFileSync(serviceAccountToken, 'service-account-secret\n')
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'pager-kubectl',
      `#!${fixtureExecutables.bash}\nprintf cluster-action > ${JSON.stringify(clusterMarker)}\n`,
    )
    const pager = writeTrustedExecutable(
      fixture.trustedBin,
      'hostile-grep-pager',
      `#!${fixtureExecutables.bash}\nprintf invoked > ${JSON.stringify(commandMarker)}\ncat ${JSON.stringify(
        serviceAccountToken,
      )} > ${JSON.stringify(secretMarker)}\n${JSON.stringify(fakeKubectl)} get secrets\n`,
    )
    const connection = await connectFixture(fixture, { acquire: true })
    const previousToken = process.env.GH_TOKEN
    const previousHost = process.env.KUBERNETES_SERVICE_HOST
    process.env.GH_TOKEN = 'mounted-github-secret'
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    try {
      for (const args of [
        ['grep', '-O', pager, 'seed'],
        ['grep', `-O${pager}`, 'seed'],
        ['grep', `-nO${pager}`, 'seed'],
        ['grep', '--open-files-in-pager', 'seed'],
        ['grep', `--open-files-in-pager=${pager}`, 'seed'],
        ['grep', `--open-files-in-page=${pager}`, 'seed'],
        ['grep', `--open-files-in-p=${pager}`, 'seed'],
        ['grep', `--open-files=${pager}`, 'seed'],
      ]) {
        const result = await connection.client.callTool({ name: 'git', arguments: { args } })
        expect(result.isError, args.join(' ')).toBe(true)
        expect(JSON.stringify(result.content)).toContain('rejects explicit pager commands')
      }
      const normal = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['grep', 'seed', '--', 'README.md'] },
      })
      expect(normal.isError).not.toBe(true)
      expect(existsSync(commandMarker)).toBe(false)
      expect(existsSync(secretMarker)).toBe(false)
      expect(existsSync(clusterMarker)).toBe(false)
    } finally {
      if (previousToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
      if (previousHost == null) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = previousHost
      await closeFixtureConnection(connection)
    }
  })

  it('disables repository-configured execution during read-only Git inspection', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'git-helper-invoked')
    const helper = writeTrustedExecutable(
      fixture.trustedBin,
      'git-config-helper',
      `#!${fixtureExecutables.bash}\nprintf invoked >> ${JSON.stringify(marker)}\n`,
    )
    writeFileSync(join(fixture.existingWorkspace, '.gitattributes'), 'README.md diff=hostile filter=hostile\n')
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'add', '.gitattributes'])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'commit', '-m', 'test: hostile attributes'])
    for (const [key, value] of [
      ['diff.hostile.command', helper],
      ['diff.hostile.textconv', helper],
      ['diff.external', helper],
      ['core.fsmonitor', helper],
      ['pager.diff', helper],
      ['interactive.diffFilter', helper],
      ['filter.hostile.clean', helper],
      ['filter.hostile.smudge', helper],
      ['filter.hostile.process', `${helper} process`],
      ['filter.hostile.required', 'true'],
    ]) {
      execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', key, value])
    }

    const connection = await connectFixture(fixture, { acquire: true })
    try {
      const changed = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf changed > README.md' },
      })

      expect(changed.isError).not.toBe(true)
      for (const args of [
        ['diff', '--', 'README.md'],
        ['status', '--short'],
        ['log', '-1', '--', 'README.md'],
        ['show', 'HEAD:README.md'],
      ]) {
        const result = await connection.client.callTool({ name: 'git', arguments: { args } })
        expect(result.isError, args.join(' ')).not.toBe(true)
      }
      expect(existsSync(marker)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('neutralizes core.alternateRefsCommand before accepted log inspection can expose readable credentials', async () => {
    const fixture = makeFixture()
    const alternate = join(fixture.root, 'alternate-object-repository')
    const marker = join(fixture.root, 'alternate-refs-invoked')
    const token = join(fixture.root, 'projected-service-account-token')
    const helper = join(fixture.root, 'alternate-refs-helper')
    mkdirSync(alternate)
    execFileSync(fixtureExecutables.git, ['init', '--quiet', '--initial-branch=main', alternate])
    execFileSync(fixtureExecutables.git, ['-C', alternate, 'config', 'user.name', 'Alternate Ref Test'])
    execFileSync(fixtureExecutables.git, ['-C', alternate, 'config', 'user.email', 'alternate@example.test'])
    writeFileSync(join(alternate, 'ALT'), 'alternate\n')
    execFileSync(fixtureExecutables.git, ['-C', alternate, 'add', 'ALT'])
    execFileSync(fixtureExecutables.git, ['-C', alternate, 'commit', '-m', 'test: alternate object'])
    mkdirSync(join(fixture.existingWorkspace, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(
      join(fixture.existingWorkspace, '.git', 'objects', 'info', 'alternates'),
      `${join(alternate, '.git', 'objects')}\n`,
    )
    writeFileSync(token, 'mounted-service-account-secret\n', { mode: 0o644 })
    writeFileSync(
      helper,
      `#!${fixtureExecutables.bash}\nprintf invoked > ${JSON.stringify(marker)} || true\ncat ${JSON.stringify(token)}\n`,
      { mode: 0o755 },
    )
    execFileSync(fixtureExecutables.git, [
      '-C',
      fixture.existingWorkspace,
      'config',
      'core.alternateRefsCommand',
      helper,
    ])
    const raw = execFileSync(
      fixtureExecutables.git,
      ['-C', fixture.existingWorkspace, 'log', '--alternate-refs', '-1'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    expect(raw).toContain('commit')
    expect(readFileSync(marker, 'utf8')).toBe('invoked')
    rmSync(marker)

    const connection = await connectFixture(fixture, { acquire: true, sessionId: 'alternate-refs-owner' })
    try {
      const inspected = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['log', '--alternate-refs', '-1'] },
      })
      expect(inspected.isError).not.toBe(true)
      expect(JSON.stringify(inspected)).not.toContain('mounted-service-account-secret')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('neutralizes format-specific GPG verifier programs before accepted signature inspection', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'gpg-verifier-invoked')
    const token = join(fixture.root, 'projected-signature-token')
    const leak = join(fixture.root, 'gpg-verifier-leak')
    const helper = join(fixture.root, 'gpg-openpgp-helper')
    const parent = execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const tree = execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim()
    const identity = 'Signature Test <signature@example.test> 1700000000 +0000'
    const commit = execFileSync(
      fixtureExecutables.git,
      ['-C', fixture.existingWorkspace, 'hash-object', '-t', 'commit', '-w', '--stdin'],
      {
        input: [
          `tree ${tree}`,
          `parent ${parent}`,
          `author ${identity}`,
          `committer ${identity}`,
          'gpgsig -----BEGIN PGP SIGNATURE-----',
          ' fake-signature',
          ' -----END PGP SIGNATURE-----',
          '',
          'synthetic signed commit',
          '',
        ].join('\n'),
        encoding: 'utf8',
      },
    ).trim()
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'update-ref', 'refs/heads/main', commit])
    writeFileSync(token, 'mounted-signature-secret\n', { mode: 0o644 })
    writeFileSync(
      helper,
      `#!${fixtureExecutables.bash}\nprintf invoked > ${JSON.stringify(marker)}\ncat ${JSON.stringify(token)} > ${JSON.stringify(leak)}\nexit 1\n`,
      { mode: 0o755 },
    )
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', 'gpg.format', 'openpgp'])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', 'gpg.openpgp.program', helper])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'log', '--show-signature', '-1'])
    expect(readFileSync(marker, 'utf8')).toBe('invoked')
    expect(readFileSync(leak, 'utf8')).toBe('mounted-signature-secret\n')
    rmSync(marker)
    rmSync(leak)

    const connection = await connectFixture(fixture, { acquire: true, sessionId: 'gpg-verifier-owner' })
    try {
      const inspected = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['log', '--show-signature', '-1'] },
      })
      expect(inspected.isError).not.toBe(true)
      expect(JSON.stringify(inspected)).not.toContain('mounted-signature-secret')
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(leak)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('rejects recursive submodule rendering before child repository filters execute', async () => {
    const fixture = makeFixture()
    const child = join(fixture.root, 'hostile-submodule')
    const marker = join(fixture.root, 'submodule-filter-invoked')
    const helper = writeTrustedExecutable(
      fixture.trustedBin,
      'submodule-clean-filter',
      `#!${fixtureExecutables.bash}\nprintf invoked >> ${JSON.stringify(marker)}\ncat\n`,
    )
    execFileSync(fixtureExecutables.git, ['init', '--quiet', child])
    execFileSync(fixtureExecutables.git, ['-C', child, 'config', 'user.name', 'Submodule Fixture'])
    execFileSync(fixtureExecutables.git, ['-C', child, 'config', 'user.email', 'submodule@example.test'])
    writeFileSync(join(child, 'file.txt'), 'base\n')
    writeFileSync(join(child, '.gitattributes'), 'file.txt filter=hostile\n')
    execFileSync(fixtureExecutables.git, ['-C', child, 'add', '.'])
    execFileSync(fixtureExecutables.git, ['-C', child, 'commit', '-m', 'test: hostile submodule'])
    execFileSync(fixtureExecutables.git, [
      '-c',
      'protocol.file.allow=always',
      '-C',
      fixture.seedPath,
      'submodule',
      'add',
      '--quiet',
      child,
      'hostile-submodule',
    ])
    execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'commit', '-am', 'test: add hostile submodule'])
    const initialized = join(fixture.seedPath, 'hostile-submodule')
    execFileSync(fixtureExecutables.git, ['-C', initialized, 'config', 'filter.hostile.clean', helper])
    execFileSync(fixtureExecutables.git, ['-C', initialized, 'config', 'filter.hostile.required', 'true'])
    writeFileSync(join(initialized, 'file.txt'), 'changed\n')

    execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'diff', '--submodule=diff'])
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const connection = await connectFixture(fixture)
    try {
      for (const args of [
        ['diff', '--submodule=diff'],
        ['diff', '--submodule', 'diff'],
        ['diff', '--ignore-submodules=none'],
        ['grep', '--recurse-submodules', 'base'],
        ['ls-files', '--recurse-submodules'],
      ]) {
        const result = await connection.client.callTool({ name: 'git', arguments: { args } })
        expect(result.isError, args.join(' ')).toBe(true)
        expect(JSON.stringify(result.content)).toContain('rejects recursive submodule')
      }
      const normal = await connection.client.callTool({ name: 'git', arguments: { args: ['diff'] } })
      expect(normal.isError).not.toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('isolates shell jobs by MCP session', async () => {
    const firstFixture = makeFixture()
    const sharedRunner = new AgentsShellRunner(firstFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const first = await connectFixture(firstFixture, {
      acquire: true,
      sessionId: 'session-one',
      runner: sharedRunner,
    })
    const second = await connectFixture(firstFixture, { sessionId: 'session-two', runner: sharedRunner })
    try {
      const started = await first.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 10', timeoutSeconds: 20 },
      })
      const jobId = (started.structuredContent as { jobId: string }).jobId
      const foreignRead = await second.client.callTool({ name: 'shell_read', arguments: { jobId } })
      expect(foreignRead.isError).toBe(true)
      const foreignKill = await second.client.callTool({ name: 'shell_kill', arguments: { jobId } })
      expect(foreignKill.isError).toBe(true)
      const killed = await first.client.callTool({ name: 'shell_kill', arguments: { jobId, signal: 'SIGKILL' } })
      expect(killed.isError).not.toBe(true)
    } finally {
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      sharedRunner.shutdown()
    }
  })

  it('pins trusted executables before user-controlled PATH changes', async () => {
    const fixture = makeFixture()
    const fakeRg = writeTrustedExecutable(fixture.trustedBin, 'trusted-rg', '#!/bin/sh\nprintf trusted-rg\n')
    fixture.config.trustedExecutables.executables.rg = fakeRg
    const connection = await connectFixture(fixture)
    const previousPath = process.env.PATH
    process.env.PATH = fixture.workspaceRoot
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await connection.client.callTool({ name: 'search', arguments: { query: 'anything' } })
        expect((result.structuredContent as { stdout?: string }).stdout).toBe('trusted-rg')
      }
    } finally {
      process.env.PATH = previousPath
      await closeFixtureConnection(connection)
    }
  })

  it('preserves in-cluster discovery without leaking secrets to read-only kubectl calls', async () => {
    const fixture = makeFixture()
    const execMarker = join(fixture.root, 'kubectl-exec-plugin-invoked')
    const kubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'kubectl-in-cluster',
      `#!${fixtureExecutables.bash}\nset -euo pipefail\nif [[ -x "\${HOME:-}/.kube/exec-plugin" ]]; then "\${HOME}/.kube/exec-plugin"; fi\ntest "\${HOME:-}" = /nonexistent\ntest "\${KUBECONFIG:-}" = /dev/null\ntest "\${KUBERNETES_SERVICE_HOST:-}" = 10.96.0.1\ntest "\${KUBERNETES_SERVICE_PORT:-}" = 443\ntest -z "\${GH_TOKEN:-}"\nprintf '{"kind":"List","items":[]}\\n'\n`,
    )
    fixture.config.trustedExecutables.executables.kubectl = kubectl
    const previousHost = process.env.KUBERNETES_SERVICE_HOST
    const previousPort = process.env.KUBERNETES_SERVICE_PORT
    const previousToken = process.env.GH_TOKEN
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    process.env.GH_TOKEN = 'must-not-reach-read-only-kubectl'
    const connection = await connectFixture(fixture, { sessionId: 'in-cluster-read-owner', acquire: true })
    try {
      const planted = await connection.client.callTool({
        name: 'shell_run',
        arguments: {
          command: `mkdir -p "$HOME/.kube" && printf '%s\n' '#!${fixtureExecutables.bash}' 'printf invoked > ${execMarker}' > "$HOME/.kube/exec-plugin" && chmod +x "$HOME/.kube/exec-plugin" && printf 'users: [{name: hostile, user: {exec: {command: %s}}}]\n' "$HOME/.kube/exec-plugin" > "$HOME/.kube/config"`,
        },
      })
      expect(planted.isError).not.toBe(true)
      const direct = await connection.client.callTool({
        name: 'kubectl',
        arguments: { args: ['get', 'pods', '-n', 'agents', '-o', 'json'] },
      })
      expect(direct.isError).not.toBe(true)
      const status = await connection.client.callTool({
        name: 'agent_status',
        arguments: { agentRunName: 'fixture-agent' },
      })
      expect(status.isError).not.toBe(true)
      const read = await connection.client.callTool({
        name: 'agent_read',
        arguments: { agentRunName: 'fixture-agent' },
      })
      expect(read.isError).not.toBe(true)
      expect(existsSync(execMarker)).toBe(false)
    } finally {
      if (previousHost == null) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = previousHost
      if (previousPort == null) delete process.env.KUBERNETES_SERVICE_PORT
      else process.env.KUBERNETES_SERVICE_PORT = previousPort
      if (previousToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
      await closeFixtureConnection(connection)
    }
  })

  it('rejects caller-controlled kubectl client loading, credentials, endpoints, and impersonation', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'kubectl-exec-plugin-invoked')
    const plugin = writeTrustedExecutable(
      fixture.trustedBin,
      'hostile-kubectl-exec-plugin',
      `#!${fixtureExecutables.bash}\nprintf invoked > ${JSON.stringify(marker)}\nprintf '%s\\n' '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"hostile"}}'\n`,
    )
    const kubeconfig = join(fixture.root, 'hostile-kubeconfig')
    writeFileSync(
      kubeconfig,
      `apiVersion: v1\nkind: Config\nclusters:\n- name: hostile\n  cluster:\n    server: https://127.0.0.1:1\n    insecure-skip-tls-verify: true\nusers:\n- name: hostile\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: ${plugin}\n      interactiveMode: Never\ncontexts:\n- name: hostile\n  context:\n    cluster: hostile\n    user: hostile\ncurrent-context: hostile\n`,
    )
    const kubectl = findTestExecutable('kubectl')
    try {
      execFileSync(kubectl, ['get', 'pods', `--kubeconfig=${kubeconfig}`, '--request-timeout=1s'])
    } catch {
      // The hostile endpoint is intentionally unreachable after the plugin runs.
    }
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const connection = await connectFixture(fixture, { acquire: true })
    try {
      for (const args of [
        ['get', 'pods', '--kubeconfig', kubeconfig],
        ['get', 'pods', `--kubeconfig=${kubeconfig}`],
        ['get', 'pods', '--server=https://127.0.0.1:1'],
        ['get', 'pods', '-s', 'https://127.0.0.1:1'],
        ['get', 'pods', '-shttps://127.0.0.1:1'],
        ['get', 'pods', '--token=hostile'],
        ['get', 'pods', '--client-certificate', 'client.crt'],
        ['get', 'pods', '--client-key=client.key'],
        ['get', 'pods', '--certificate-authority=ca.crt'],
        ['get', 'pods', '--insecure-skip-tls-verify=true'],
        ['get', 'pods', '--context=hostile'],
        ['get', 'pods', '--cluster=hostile'],
        ['get', 'pods', '--user=hostile'],
        ['get', 'pods', '--username=hostile'],
        ['get', 'pods', '--password=hostile'],
        ['get', 'pods', '--as=system:admin'],
        ['get', 'pods', '--as-group=system:masters'],
        ['get', 'pods', '--as-uid=0'],
        ['get', 'pods', '--tls-server-name=hostile'],
      ]) {
        const result = await connection.client.callTool({ name: 'kubectl', arguments: { args } })
        expect(result.isError, args.join(' ')).toBe(true)
        expect(JSON.stringify(result.content)).toContain('rejects caller-controlled client authentication')
      }
      expect(existsSync(marker)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('returns operating guidance centered on server-owned workspace leases', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture)
    try {
      const result = await connection.client.callTool({ name: 'agent_guide', arguments: {} })
      const guide = (result.structuredContent as { guide?: string }).guide ?? ''
      expect(guide).toContain('workspace_acquire')
      expect(guide).toContain('server-issued')
      expect(guide).toContain('shared read-only seed')
      expect(guide).not.toContain('worktree add -B')
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('rejects paths outside the configured workspace root', () => {
    const fixture = makeFixture()
    expect(() => resolveWorkspacePath(fixture.config.workspaceRoot, '../escape')).toThrow(/path must stay under/)
  })
})
