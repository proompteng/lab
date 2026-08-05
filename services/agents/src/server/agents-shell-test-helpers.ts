import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  AgentsShellRunner,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  type AgentsShellConfig,
  type AuthContext,
} from './agents-shell-mcp'

const roots = new Set<string>()

export const findTestExecutable = (name: string) => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error(`test executable not found: ${name}`)
}

const git = findTestExecutable('git')
const bash = findTestExecutable('bash')
const python3 = findTestExecutable('python3')
const applyPatchScript = realpathSync(join(process.cwd(), 'scripts', 'apply_patch.py'))

const runGit = (args: string[]) =>
  execFileSync(git, args, {
    encoding: 'utf8',
    env: {
      HOME: '/nonexistent',
      PATH: dirname(git),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()

export type AgentsShellFixture = {
  root: string
  workspaceRoot: string
  seedPath: string
  leaseRoot: string
  existingWorkspace: string
  trustedBin: string
  auditLogPath: string
  config: AgentsShellConfig
}

export const makeAuth = (scopes = ['agents-shell.read', 'agents-shell.write'], subject = 'user-1'): AuthContext => ({
  subject,
  email: `${subject}@example.test`,
  username: subject,
  scopes: new Set(scopes),
  payload: {
    sub: subject,
    email: `${subject}@example.test`,
    preferred_username: subject,
    scope: scopes.join(' '),
  },
})

export const writeTrustedExecutable = (trustedBin: string, name: string, body: string) => {
  const path = join(trustedBin, name)
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

const writeLandlockFixture = (trustedBin: string) =>
  writeTrustedExecutable(
    trustedBin,
    'agents-shell-landlock',
    `#!${bash}
set -euo pipefail
if [[ "\${1:-}" == "--check" ]]; then
  printf '%s\n' 'landlock-abi=fixture'
  exit 0
fi
cwd_fd=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid|--gid|--parent-pid|--write-root|--write-file) shift 2 ;;
    --cwd-fd) cwd_fd="$2"; shift 2 ;;
    --read-only) shift ;;
    --) shift; break ;;
    *) printf 'unexpected confinement argument: %s\n' "$1" >&2; exit 126 ;;
  esac
done
[[ -n "$cwd_fd" ]] || { printf 'missing cwd fd\n' >&2; exit 126; }
cd "/proc/self/fd/$cwd_fd"
exec "$@"
`,
  )

const initializeRepositoryFixture = (root: string, workspaceRoot: string, seedPath: string, leaseRoot: string) => {
  const originPath = join(root, 'origin.git')
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o755 })
  mkdirSync(leaseRoot, { recursive: true, mode: 0o755 })
  runGit(['init', '--quiet', '--bare', '--initial-branch=main', originPath])
  runGit(['init', '--quiet', '-b', 'main', seedPath])
  runGit(['-C', seedPath, 'config', 'user.name', 'Agents Shell Test'])
  runGit(['-C', seedPath, 'config', 'user.email', 'agents-shell@example.test'])
  writeFileSync(join(seedPath, 'README.md'), 'seed\n')
  runGit(['-C', seedPath, 'add', 'README.md'])
  runGit(['-C', seedPath, 'commit', '-m', 'test: seed'])
  runGit(['-C', seedPath, 'remote', 'add', 'origin', originPath])
  runGit(['-C', seedPath, 'push', '--quiet', '-u', 'origin', 'main'])
  runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  const existingWorkspace = join(leaseRoot, 'existing-workspace')
  runGit(['clone', '--quiet', '--no-hardlinks', '--branch', 'main', originPath, existingWorkspace])
  runGit(['-C', existingWorkspace, 'config', 'user.name', 'Agents Shell Test'])
  runGit(['-C', existingWorkspace, 'config', 'user.email', 'agents-shell@example.test'])
  return { originPath, existingWorkspace }
}

export const makeFixture = (
  options: {
    leaseTtlSeconds?: number
    maxToolSchemaBytes?: number
    executableOverrides?: Partial<Record<'apply_patch' | 'git' | 'kubectl' | 'rg', string>>
  } = {},
): AgentsShellFixture => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-test-'))
  roots.add(root)
  const workspaceRoot = join(root, 'workspace')
  const seedPath = join(workspaceRoot, 'lab')
  const leaseRoot = join(workspaceRoot, 'worktrees', 'lab')
  const trustedBin = join(root, 'trusted-bin')
  const auditLogPath = join(workspaceRoot, '.agents-shell', 'audit.jsonl')
  mkdirSync(trustedBin, { recursive: true, mode: 0o700 })
  const landlock = writeLandlockFixture(trustedBin)
  const rg = writeTrustedExecutable(trustedBin, 'rg', `#!${bash}\nexit 1\n`)
  const kubectl = writeTrustedExecutable(
    trustedBin,
    'kubectl',
    `#!${bash}\ncat >/dev/null || true\nprintf 'kubectl-fixture\\n'\n`,
  )
  const applyPatch = writeTrustedExecutable(
    trustedBin,
    'apply_patch',
    `#!${bash}\nexec ${python3} ${applyPatchScript} "$@"\n`,
  )
  const { existingWorkspace } = initializeRepositoryFixture(root, workspaceRoot, seedPath, leaseRoot)
  const trustedPaths = Array.from(
    new Set([
      trustedBin,
      dirname(bash),
      dirname(git),
      ...['cat', 'grep', 'ln', 'mkdir', 'printf', 'rm', 'sh', 'sleep', 'touch'].map((name) =>
        dirname(findTestExecutable(name)),
      ),
    ]),
  ).join(delimiter)
  const uid = process.geteuid?.() ?? 0
  const gid = process.getegid?.() ?? 0
  const config = defaultAgentsShellConfigFromEnv({
    AGENTS_SHELL_RESOURCE: 'https://agents-shell.example.test',
    AGENTS_SHELL_OAUTH_ISSUER: 'https://auth.example.test/realms/master',
    AGENTS_SHELL_WORKSPACE_ROOT: workspaceRoot,
    AGENTS_SHELL_WORKSPACE_SEED_PATH: seedPath,
    AGENTS_SHELL_WORKSPACE_LEASE_ROOT: leaseRoot,
    AGENTS_SHELL_SESSION_RUNTIME_ROOT: join(workspaceRoot, '.agents-shell', 'sessions'),
    AGENTS_SHELL_LEASE_STATE_PATH: join(workspaceRoot, '.agents-shell', 'leases.json'),
    AGENTS_SHELL_AUDIT_LOG_PATH: auditLogPath,
    AGENTS_SHELL_ALLOWED_K8S_NAMESPACES: 'agents',
    AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS: '5',
    AGENTS_SHELL_MAX_TIMEOUT_SECONDS: '30',
    AGENTS_SHELL_LEASE_TTL_SECONDS: String(options.leaseTtlSeconds ?? 300),
    AGENTS_SHELL_SESSION_UID_START: String(uid),
    AGENTS_SHELL_SESSION_UID_END: String(uid),
    AGENTS_SHELL_INSPECTION_UID: String(uid),
    AGENTS_SHELL_INSPECTION_GID: String(gid),
    AGENTS_SHELL_MAX_TOOL_SCHEMA_BYTES: String(options.maxToolSchemaBytes ?? 24_576),
    AGENTS_SHELL_TRUSTED_PATH: trustedPaths,
    AGENTS_SHELL_BASH_EXECUTABLE: bash,
    AGENTS_SHELL_GIT_EXECUTABLE: options.executableOverrides?.git ?? git,
    AGENTS_SHELL_RG_EXECUTABLE: options.executableOverrides?.rg ?? rg,
    AGENTS_SHELL_KUBECTL_EXECUTABLE: options.executableOverrides?.kubectl ?? kubectl,
    AGENTS_SHELL_APPLY_PATCH_EXECUTABLE: options.executableOverrides?.apply_patch ?? applyPatch,
    AGENTS_SHELL_LANDLOCK_EXECUTABLE: landlock,
  })
  return { root, workspaceRoot, seedPath, leaseRoot, existingWorkspace, trustedBin, auditLogPath, config }
}

export const connectFixture = async (
  fixture: AgentsShellFixture,
  options: { auth?: AuthContext; sessionId?: string; acquire?: boolean; runner?: AgentsShellRunner } = {},
) => {
  const auth = options.auth ?? makeAuth()
  const sessionId = options.sessionId ?? crypto.randomUUID()
  const ownsRunner = options.runner == null
  const runner =
    options.runner ?? new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
  const server = createAgentsShellServer(fixture.config, runner, auth, sessionId)
  const client = new Client({ name: 'agents-shell-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  if (options.acquire) {
    const acquired = await client.callTool({
      name: 'workspace_acquire',
      arguments: { task: 'test-task', existingPath: fixture.existingWorkspace },
    })
    if (acquired.isError) throw new Error(`workspace acquisition failed: ${JSON.stringify(acquired.content)}`)
  }
  return { auth, sessionId, runner, ownsRunner, client, server, clientTransport, serverTransport }
}

export const listToolsOnWire = async (fixture: AgentsShellFixture) => {
  const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
  const server = createAgentsShellServer(fixture.config, runner, makeAuth(), crypto.randomUUID())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    return await new Promise<
      Array<{
        name?: string
        description?: string
        inputSchema?: Record<string, unknown>
        securitySchemes?: unknown
        annotations?: Record<string, unknown>
      }>
    >((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for tools/list response')), 1000)
      clientTransport.onmessage = (message) => {
        clearTimeout(timeout)
        const response = message as {
          result?: {
            tools?: Array<{
              name?: string
              description?: string
              inputSchema?: Record<string, unknown>
              securitySchemes?: unknown
              annotations?: Record<string, unknown>
            }>
          }
        }
        resolve(response.result?.tools ?? [])
      }
      void clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
  } finally {
    await clientTransport.close()
    await serverTransport.close()
    await server.close()
    runner.shutdown()
  }
}

export const closeFixtureConnection = async (connection: Awaited<ReturnType<typeof connectFixture>>) => {
  await connection.clientTransport.close()
  await connection.serverTransport.close()
  await connection.client.close()
  await connection.server.close()
  if (connection.ownsRunner) connection.runner.shutdown()
}

export const cleanupFixtures = () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
}

export const fixtureExecutables = { bash, git }
