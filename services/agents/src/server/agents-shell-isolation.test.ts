import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentsShellRunner, createAgentsShellRequestHandler } from './agents-shell-mcp'
import { parseLinuxProcessStatus, processIdsForUid, terminateProcessesForUid } from './agents-shell/process-isolation'
import {
  cleanupFixtures,
  closeFixtureConnection,
  connectFixture,
  findTestExecutable,
  fixtureExecutables,
  makeAuth,
  makeFixture,
  writeTrustedExecutable,
} from './agents-shell-test-helpers'

const maybeExecutable = (name: string) => {
  try {
    return findTestExecutable(name)
  } catch {
    return null
  }
}

const compiler = maybeExecutable('cc') ?? maybeExecutable('gcc') ?? maybeExecutable('clang')
const nativeIdentityAvailable = compiler != null && (process.geteuid?.() ?? -1) === 0

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
    clientInfo: { name: 'agents-shell-isolation-test', version: '0.0.0' },
  },
}

const callBody = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})

const waitForClose = async (job: ReturnType<AgentsShellRunner['requireJob']>) => {
  if (job.finishedAt) return
  await Promise.race([
    new Promise<void>((resolve) => job.process.once('close', () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('job did not close')), 3000)),
  ])
}

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

const waitForFile = async (path: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`file did not appear: ${path}`)
}

afterEach(() => {
  cleanupFixtures()
  vi.restoreAllMocks()
})

describe('agents-shell causal workspace isolation', () => {
  it('reproduces the legacy shared-cwd stash collision and blocks the same second-session action', async () => {
    const legacy = makeFixture()
    writeFileSync(join(legacy.existingWorkspace, 'README.md'), 'first-session-dirty\n')
    writeFileSync(join(legacy.existingWorkspace, 'untracked.txt'), 'first-session-untracked\n')
    expect(
      execFileSync(fixtureExecutables.git, ['-C', legacy.existingWorkspace, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
    ).not.toBe('')
    execFileSync(fixtureExecutables.git, ['-C', legacy.existingWorkspace, 'stash', 'push', '-u', '-m', 'collision'], {
      encoding: 'utf8',
    })
    expect(
      execFileSync(fixtureExecutables.git, ['-C', legacy.existingWorkspace, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
    ).toBe('')
    expect(
      execFileSync(fixtureExecutables.git, ['-C', legacy.existingWorkspace, 'stash', 'list'], { encoding: 'utf8' }),
    ).toContain('collision')

    const fixed = makeFixture()
    const runner = new AgentsShellRunner(fixed.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const first = await connectFixture(fixed, { sessionId: 'session-one', runner, acquire: true })
    const second = await connectFixture(fixed, { sessionId: 'session-two', runner })
    try {
      const dirty = await first.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf first-session-dirty >> README.md && printf untracked > untracked.txt' },
      })
      expect(dirty.isError).not.toBe(true)

      const collision = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'collision', existingPath: fixed.existingWorkspace },
      })
      expect(collision.isError).toBe(true)
      expect(JSON.stringify(collision.content)).toContain('already leased by another session')

      for (const [name, args] of [
        ['shell_run', { command: 'git stash push -u -m collision', cwd: fixed.existingWorkspace }],
        ['git_write', { args: ['stash', 'push', '-u', '-m', 'collision'], cwd: fixed.existingWorkspace }],
      ] as const) {
        const blocked = await second.client.callTool({ name, arguments: args })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('active workspace lease is required')
      }
      expect(readFileSync(join(fixed.existingWorkspace, 'untracked.txt'), 'utf8')).toBe('untracked')
      expect(
        execFileSync(fixtureExecutables.git, ['-C', fixed.existingWorkspace, 'status', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).toContain('untracked.txt')
    } finally {
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      runner.shutdown()
    }
  })

  it('creates one distinct contained workspace per concurrent session from the exact requested commit', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const first = await connectFixture(fixture, { runner, sessionId: 'created-one' })
    const second = await connectFixture(fixture, { runner, sessionId: 'created-two' })
    const expectedCommit = execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    try {
      const firstAcquire = await first.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'created-one', expectedCommit },
      })
      const secondAcquire = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'created-two', expectedCommit },
      })
      expect(firstAcquire.isError).not.toBe(true)
      expect(secondAcquire.isError).not.toBe(true)
      const firstLease = firstAcquire.structuredContent as {
        workspacePath: string
        branch: string
        head: string
      }
      const secondLease = secondAcquire.structuredContent as {
        workspacePath: string
        branch: string
        head: string
      }
      expect(firstLease.workspacePath.startsWith(`${fixture.leaseRoot}/`)).toBe(true)
      expect(secondLease.workspacePath.startsWith(`${fixture.leaseRoot}/`)).toBe(true)
      expect(firstLease.workspacePath).not.toBe(secondLease.workspacePath)
      expect(firstLease.branch).toMatch(/^codex\/created-one-/)
      expect(secondLease.branch).toMatch(/^codex\/created-two-/)
      expect(firstLease.head).toBe(expectedCommit)
      expect(secondLease.head).toBe(expectedCommit)

      for (const [connection, lease] of [
        [first, firstLease],
        [second, secondLease],
      ] as const) {
        const status = await connection.client.callTool({
          name: 'git',
          arguments: { args: ['status', '--short'], cwd: lease.workspacePath },
        })
        expect(status.isError, lease.workspacePath).not.toBe(true)
      }

      await first.client.callTool({ name: 'shell_run', arguments: { command: 'printf one > session.txt' } })
      await second.client.callTool({ name: 'shell_run', arguments: { command: 'printf two > session.txt' } })
      expect(readFileSync(join(firstLease.workspacePath, 'session.txt'), 'utf8')).toBe('one')
      expect(readFileSync(join(secondLease.workspacePath, 'session.txt'), 'utf8')).toBe('two')
    } finally {
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      runner.shutdown()
    }
  })

  it('serializes relative and absolute spellings of the same existing workspace', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const first = await connectFixture(fixture, { runner, sessionId: 'canonical-path-first' })
    const second = await connectFixture(fixture, { runner, sessionId: 'canonical-path-second' })
    try {
      const relativePath = fixture.existingWorkspace.slice(fixture.leaseRoot.length + 1)
      const [absolute, relative] = await Promise.all([
        first.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'canonical-path', existingPath: fixture.existingWorkspace },
        }),
        second.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'canonical-path', existingPath: relativePath },
        }),
      ])
      const results = [absolute, relative]
      expect(results.filter((result) => result.isError === true)).toHaveLength(1)
      expect(results.filter((result) => result.isError !== true)).toHaveLength(1)
      expect(JSON.stringify(results.find((result) => result.isError === true)?.content)).toContain(
        'already leased by another session',
      )
      const persisted = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ status: string; workspacePath: string }>
      }
      expect(
        persisted.leases.filter(
          (lease) => lease.status === 'active' && lease.workspacePath === fixture.existingWorkspace,
        ),
      ).toHaveLength(1)
    } finally {
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      runner.shutdown()
    }
  })

  it('updates origin/main before resolving a newly created lease base', async () => {
    const fixture = makeFixture()
    const publisher = join(fixture.root, 'publisher')
    execFileSync(fixtureExecutables.git, ['clone', '--quiet', join(fixture.root, 'origin.git'), publisher])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'config', 'user.name', 'Agents Shell Publisher'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'config', 'user.email', 'publisher@example.test'])
    writeFileSync(join(publisher, 'advanced.txt'), 'advanced-main\n')
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'add', 'advanced.txt'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'commit', '-m', 'test: advance main'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'push', '--quiet', 'origin', 'HEAD:main'])
    const expectedCommit = execFileSync(fixtureExecutables.git, ['-C', publisher, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const staleSeedRef = execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'rev-parse', 'origin/main'], {
      encoding: 'utf8',
    }).trim()
    expect(staleSeedRef).not.toBe(expectedCommit)

    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'advanced-main-owner' })
    try {
      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'advanced-main', expectedCommit },
      })
      expect(acquired.isError).not.toBe(true)
      expect((acquired.structuredContent as { head?: string }).head).toBe(expectedCommit)
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('fetches the caller-selected origin branch and rejects ambiguous remote refs', async () => {
    const fixture = makeFixture()
    const publisher = join(fixture.root, 'selected-ref-publisher')
    execFileSync(fixtureExecutables.git, ['clone', '--quiet', join(fixture.root, 'origin.git'), publisher])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'config', 'user.name', 'Selected Ref Publisher'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'config', 'user.email', 'selected@example.test'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'checkout', '-q', '-b', 'feature/selected'])
    writeFileSync(join(publisher, 'selected.txt'), 'selected-branch\n')
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'add', 'selected.txt'])
    execFileSync(fixtureExecutables.git, ['-C', publisher, 'commit', '-m', 'test: selected branch'])
    execFileSync(fixtureExecutables.git, [
      '-C',
      publisher,
      'push',
      '--quiet',
      'origin',
      'HEAD:refs/heads/feature/selected',
    ])
    const expectedCommit = execFileSync(fixtureExecutables.git, ['-C', publisher, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    expect(() =>
      execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'rev-parse', 'origin/feature/selected'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).toThrow()

    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'selected-ref-owner' })
    try {
      const ambiguous = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'ambiguous-ref', baseRef: 'upstream/feature/selected' },
      })
      expect(ambiguous.isError).toBe(true)
      expect(JSON.stringify(ambiguous.content)).toContain('origin/<branch>')

      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: {
          task: 'selected-ref',
          baseRef: 'origin/feature/selected',
          expectedCommit,
        },
      })
      expect(acquired.isError).not.toBe(true)
      const lease = acquired.structuredContent as { workspacePath: string; head: string }
      expect(lease.head).toBe(expectedCommit)
      expect(readFileSync(join(lease.workspacePath, 'selected.txt'), 'utf8')).toBe('selected-branch\n')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('uses and removes a scratch index for read-only Git on a server-created clone', async () => {
    const fixture = makeFixture()
    const configMarker = join(fixture.root, 'read-only-git-config-paths')
    const inspectionsRoot = join(dirname(fixture.config.leaseStatePath), 'git-inspections')
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'scratch-config-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
if [[ -n "\${GIT_INDEX_FILE:-}" ]]; then
  case "\${GIT_CONFIG_GLOBAL:-}" in
    ${JSON.stringify(`${inspectionsRoot}/inspection-`)}*/gitconfig) ;;
    *) exit 97 ;;
  esac
  [[ -f "\${GIT_CONFIG_GLOBAL}" ]] || exit 98
  [[ "\${GIT_CONFIG_SYSTEM:-}" == "\${GIT_CONFIG_GLOBAL}" ]] || exit 99
  hooks=''
  previous=''
  for arg in "$@"; do
    if [[ "$previous" == '-c' && "$arg" == core.hooksPath=* ]]; then hooks="\${arg#core.hooksPath=}"; fi
    previous="$arg"
  done
  case "$hooks" in
    ${JSON.stringify(`${inspectionsRoot}/inspection-`)}*/hooks) ;;
    *) exit 100 ;;
  esac
  [[ -d "$hooks" && ! -L "$hooks" ]] || exit 101
  printf '%s|%s|%s\n' "\${GIT_CONFIG_GLOBAL}" "\${GIT_CONFIG_SYSTEM}" "$hooks" >> ${JSON.stringify(configMarker)}
fi
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'created-scratch-index' })
    try {
      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'created-scratch-index' },
      })

      expect(acquired.isError).not.toBe(true)
      const lease = acquired.structuredContent as { workspacePath: string }
      const mutation = await connection.client.callTool({
        name: 'shell_run',
        arguments: {
          command: 'printf changed >> README.md; printf untracked > production-owner.txt',
        },
      })
      expect((mutation.structuredContent as { ok?: boolean }).ok).toBe(true)

      const status = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['status', '--short'], cwd: lease.workspacePath },
      })
      expect((status.structuredContent as { stdout?: string }).stdout).toContain('production-owner.txt')
      const diff = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['diff', '--name-only'], cwd: lease.workspacePath },
      })
      expect((diff.structuredContent as { stdout?: string }).stdout).toContain('README.md')
      expect(readdirSync(join(dirname(fixture.config.leaseStatePath), 'git-inspections'))).toEqual([])
      const scratchConfigs = readFileSync(configMarker, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('|'))
      expect(scratchConfigs).toHaveLength(4)
      expect(scratchConfigs.every((paths) => paths.length === 3 && paths.every((path) => path !== '/dev/null'))).toBe(
        true,
      )
      expect(scratchConfigs.every((paths) => paths.every((path) => !existsSync(path!)))).toBe(true)
      const auditEvents = readFileSync(fixture.auditLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event)
      expect(auditEvents.lastIndexOf('git_index_refresh_finished')).toBeLessThan(
        auditEvents.lastIndexOf('git_finished'),
      )
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('pins read-only subprocess cwd before a validated directory is swapped to a secret symlink', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'pinned-read-cwd' })
    const safeDirectory = join(fixture.existingWorkspace, 'pinned-read-directory')
    const movedDirectory = `${safeDirectory}.validated`
    const secretDirectory = join(fixture.root, 'projected-service-account')
    mkdirSync(safeDirectory)
    mkdirSync(secretDirectory)
    writeFileSync(join(safeDirectory, 'safe.txt'), 'ordinary workspace bytes\n')
    writeFileSync(join(secretDirectory, 'token'), 'projected-secret-token\n')
    const originalConfinementArgs = runner.leases.confinementArgs.bind(runner.leases)
    const swap = vi.spyOn(runner.leases, 'confinementArgs').mockImplementationOnce((...args) => {
      renameSync(safeDirectory, movedDirectory)
      symlinkSync(secretDirectory, safeDirectory)
      return originalConfinementArgs(...args)
    })
    try {
      const result = await connection.client.callTool({
        name: 'search',
        arguments: { query: 'projected-secret-token', path: safeDirectory },
      })
      expect(result.isError).not.toBe(true)
      expect((result.structuredContent as { stdout?: string }).stdout ?? '').not.toContain('projected-secret-token')
      expect(readFileSync(join(movedDirectory, 'safe.txt'), 'utf8')).toBe('ordinary workspace bytes\n')
      expect(swap).toHaveBeenCalledOnce()
    } finally {
      swap.mockRestore()
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects a parent-component symlink swap before the pinned cwd is opened', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'pinned-parent-cwd' })
    const safeParent = join(fixture.existingWorkspace, 'validated-parent')
    const safeDirectory = join(safeParent, 'child')
    const movedParent = `${safeParent}.validated`
    const secretParent = join(fixture.root, 'projected-parent')
    const secretDirectory = join(secretParent, 'child')
    mkdirSync(safeDirectory, { recursive: true })
    mkdirSync(secretDirectory, { recursive: true })
    writeFileSync(join(safeDirectory, 'safe.txt'), 'ordinary workspace bytes\n')
    writeFileSync(join(secretDirectory, 'token'), 'projected-secret-token\n')
    const originalInspectionContext = runner.leases.inspectionContext.bind(runner.leases)
    const swap = vi.spyOn(runner.leases, 'inspectionContext').mockImplementationOnce((...args) => {
      const inspection = originalInspectionContext(...args)
      renameSync(safeParent, movedParent)
      symlinkSync(secretParent, safeParent)
      return inspection
    })
    try {
      const result = await connection.client.callTool({
        name: 'search',
        arguments: { query: 'projected-secret-token', path: safeDirectory },
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).not.toContain('projected-secret-token')
      expect(readFileSync(join(movedParent, 'child', 'safe.txt'), 'utf8')).toBe('ordinary workspace bytes\n')
      expect(swap).toHaveBeenCalledOnce()
    } finally {
      swap.mockRestore()
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects forged persisted lease paths and traversal IDs before privileged recovery', () => {
    const writeForgedState = (fixture: ReturnType<typeof makeFixture>, workspacePath: string, leaseId: string) => {
      const workspaceStat = statSync(workspacePath)
      const head = execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      mkdirSync(dirname(fixture.config.leaseStatePath), { recursive: true })
      writeFileSync(
        fixture.config.leaseStatePath,
        `${JSON.stringify(
          {
            version: 1,
            nextUid: fixture.config.sessionUidStart,
            leases: [
              {
                leaseId,
                sessionHash: 'a'.repeat(24),
                subject: 'user-1',
                workspacePath,
                branch: 'main',
                head,
                device: workspaceStat.dev,
                inode: workspaceStat.ino,
                uid: fixture.config.sessionUidStart,
                gid: fixture.config.sessionUidStart,
                issuedAt: '2026-07-31T00:00:00.000Z',
                renewedAt: '2026-07-31T00:00:00.000Z',
                expiresAt: '2026-08-01T00:00:00.000Z',
                status: 'active',
                bootId: '22222222-2222-4222-8222-222222222222',
                activeJobIds: [],
                reason: null,
                created: false,
              },
            ],
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
    }

    const outsideFixture = makeFixture()
    const protectedOutside = join(outsideFixture.root, 'protected-outside-workspace')
    mkdirSync(protectedOutside, { mode: 0o755 })
    writeFileSync(join(protectedOutside, 'protected.txt'), 'protected\n', { mode: 0o644 })
    const protectedBefore = statSync(protectedOutside)
    writeForgedState(outsideFixture, protectedOutside, '11111111-1111-4111-8111-111111111111')
    let recoveryCalls = 0
    expect(
      () =>
        new AgentsShellRunner(outsideFixture.config, {
          uidAllocator: () => process.geteuid?.() ?? 0,
          terminateProcessesForUid: () => {
            recoveryCalls += 1
            return []
          },
        }),
    ).toThrow('workspacePath')
    expect(recoveryCalls).toBe(0)
    expect(readFileSync(join(protectedOutside, 'protected.txt'), 'utf8')).toBe('protected\n')
    expect(statSync(protectedOutside).mode).toBe(protectedBefore.mode)

    const traversalFixture = makeFixture()
    writeForgedState(traversalFixture, traversalFixture.existingWorkspace, '../../outside-runtime')
    expect(
      () =>
        new AgentsShellRunner(traversalFixture.config, {
          uidAllocator: () => process.geteuid?.() ?? 0,
          terminateProcessesForUid: () => {
            throw new Error('privileged recovery must not run')
          },
        }),
    ).toThrow('leaseId')
  })

  it('quarantines a failed UID sweep with active-job evidence and blocks descriptor-survivor reassignment', async () => {
    const fixture = makeFixture()
    const uid = process.geteuid?.() ?? 0
    fixture.config.sessionUidStart = uid
    fixture.config.sessionUidEnd = uid
    let sweepFails = true
    const runner = new AgentsShellRunner(fixture.config, {
      terminateProcessesForUid: () => {
        if (sweepFails) throw new Error('simulated surviving lease process')
        return []
      },
    })
    const owner = await connectFixture(fixture, { runner, acquire: true, sessionId: 'failed-sweep-owner' })
    const lease = runner.leases.ownedLease(owner.sessionId)!
    const runtime = join(fixture.config.sessionRuntimeRoot, lease.leaseId)
    runner.leases.environment(lease)
    runner.leases.bindJob(lease, 'surviving-job-evidence', owner.auth)
    const descriptor = openSync(join(fixture.existingWorkspace, 'README.md'), 'a')
    try {
      expect(() => runner.leases.expireById(lease.leaseId, owner.auth, 'forced_expiry')).toThrow(
        'simulated surviving lease process',
      )
      writeSync(descriptor, 'surviving-descriptor-write\n')
      const quarantined = runner.leases.findById(lease.leaseId)!
      expect(quarantined).toMatchObject({
        status: 'quarantined',
        reason: 'confinement_failed:forced_expiry',
        activeJobIds: ['surviving-job-evidence'],
      })
      expect(existsSync(runtime)).toBe(true)
      const persisted = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ status: string; reason: string; activeJobIds: string[] }>
      }
      expect(persisted.leases).toContainEqual(
        expect.objectContaining({
          status: 'quarantined',
          reason: 'confinement_failed:forced_expiry',
          activeJobIds: ['surviving-job-evidence'],
        }),
      )

      const blocked = await connectFixture(fixture, { runner, sessionId: 'failed-sweep-blocked' })
      try {
        const result = await blocked.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'failed-sweep-blocked', existingPath: fixture.existingWorkspace },
        })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('simulated surviving lease process')
        expect(runner.leases.findById(lease.leaseId)).toMatchObject({ status: 'quarantined' })
      } finally {
        await closeFixtureConnection(blocked)
      }
    } finally {
      closeSync(descriptor)
    }

    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'checkout', '--', 'README.md'])
    sweepFails = false
    const recovered = await connectFixture(fixture, { runner, sessionId: 'failed-sweep-recovered' })
    try {
      const result = await recovered.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'failed-sweep-recovered', existingPath: fixture.existingWorkspace },
      })
      expect(result.isError).not.toBe(true)
      expect(existsSync(runtime)).toBe(false)
      expect(runner.leases.findById(lease.leaseId)).toMatchObject({
        status: 'released',
        activeJobIds: [],
      })
    } finally {
      await closeFixtureConnection(recovered)
      await closeFixtureConnection(owner)
      runner.shutdown()
    }
  })

  it('retries a transient release confinement failure after restart for the same subject', async () => {
    const fixture = makeFixture()
    const uid = process.geteuid?.() ?? 0
    fixture.config.sessionUidStart = uid
    fixture.config.sessionUidEnd = uid
    let sweepFails = true
    const terminateProcessesForLeaseUid = () => {
      if (sweepFails) throw new Error('simulated transient release confinement failure')
      return []
    }

    let runner = new AgentsShellRunner(fixture.config, {
      terminateProcessesForUid: terminateProcessesForLeaseUid,
    })
    const owner = await connectFixture(fixture, {
      runner,
      acquire: true,
      sessionId: 'release-confinement-owner',
    })
    const lease = runner.leases.ownedLease(owner.sessionId)!
    const runtime = join(fixture.config.sessionRuntimeRoot, lease.leaseId)
    runner.leases.environment(lease)
    try {
      const released = await owner.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).toBe(true)
      expect(JSON.stringify(released.content)).toContain('simulated transient release confinement failure')
      expect(runner.leases.ownedLease(owner.sessionId)).toBeNull()
      expect(runner.leases.findById(lease.leaseId)).toMatchObject({
        status: 'quarantined',
        reason: 'confinement_failed:session_release',
        activeJobIds: [],
      })
      expect(existsSync(runtime)).toBe(true)
      const persisted = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ leaseId: string; status: string; reason: string; activeJobIds: string[] }>
      }
      expect(persisted.leases).toContainEqual(
        expect.objectContaining({
          leaseId: lease.leaseId,
          status: 'quarantined',
          reason: 'confinement_failed:session_release',
          activeJobIds: [],
        }),
      )
    } finally {
      await closeFixtureConnection(owner)
      runner.shutdown()
    }

    sweepFails = false
    runner = new AgentsShellRunner(fixture.config, {
      terminateProcessesForUid: terminateProcessesForLeaseUid,
    })
    const reacquired = await connectFixture(fixture, {
      runner,
      sessionId: 'release-confinement-reacquired',
    })
    try {
      const result = await reacquired.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'release-confinement-reacquired', existingPath: fixture.existingWorkspace },
      })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(existsSync(runtime)).toBe(false)
      expect(runner.leases.findById(lease.leaseId)).toMatchObject({
        status: 'released',
        reason: 'clean_recovery',
        activeJobIds: [],
      })
      expect(runner.leases.ownedLease(reacquired.sessionId)).toMatchObject({
        status: 'active',
        subject: owner.auth.subject,
        workspacePath: fixture.existingWorkspace,
      })
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_lease_confinement_retried')
    } finally {
      await closeFixtureConnection(reacquired)
      runner.shutdown()
    }
  })

  it('removes every prior runtime tree before clean orphan recovery is compacted', async () => {
    const fixture = makeFixture()
    const uid = process.geteuid?.() ?? 0
    let runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const first = await connectFixture(fixture, { runner, sessionId: 'runtime-recovery-first' })
    const firstAcquired = await first.client.callTool({
      name: 'workspace_acquire',
      arguments: { task: 'runtime-recovery-first', existingPath: fixture.existingWorkspace },
    })
    expect(firstAcquired.isError).not.toBe(true)
    const firstLease = runner.leases.ownedLease(first.sessionId)!
    const firstRuntime = join(fixture.config.sessionRuntimeRoot, firstLease.leaseId)
    runner.leases.environment(firstLease)
    writeFileSync(join(firstRuntime, 'home', 'first-secret'), 'first-secret\n')
    runner.shutdown()
    await closeFixtureConnection(first)

    runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const second = await connectFixture(fixture, { runner, sessionId: 'runtime-recovery-second' })
    const secondAcquired = await second.client.callTool({
      name: 'workspace_acquire',
      arguments: { task: 'runtime-recovery-second', existingPath: fixture.existingWorkspace },
    })
    expect(secondAcquired.isError).not.toBe(true)
    expect(existsSync(firstRuntime)).toBe(false)
    const secondLease = runner.leases.ownedLease(second.sessionId)!
    const secondRuntime = join(fixture.config.sessionRuntimeRoot, secondLease.leaseId)
    runner.leases.environment(secondLease)
    writeFileSync(join(secondRuntime, 'cache', 'second-secret'), 'second-secret\n')
    runner.shutdown()
    await closeFixtureConnection(second)

    runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const third = await connectFixture(fixture, { runner, sessionId: 'runtime-recovery-third' })
    try {
      const thirdAcquired = await third.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'runtime-recovery-third', existingPath: fixture.existingWorkspace },
      })
      expect(thirdAcquired.isError).not.toBe(true)
      expect(existsSync(firstRuntime)).toBe(false)
      expect(existsSync(secondRuntime)).toBe(false)
    } finally {
      await closeFixtureConnection(third)
      runner.shutdown()
    }
    expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('"runtimeRemoved":true')
  })

  it('cleans crash-left Git scratch on restart and rejects symlinked server control roots', () => {
    const fixture = makeFixture()
    let runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const uid = process.geteuid?.() ?? 0
    const gid = process.getegid?.() ?? 0
    const scratch = runner.leases.prepareReadOnlyGitIndexScratch(fixture.existingWorkspace, uid, gid)
    writeFileSync(join(scratch.writableRoot, 'crash-left.lock'), 'stale\n')
    expect(readdirSync(dirname(scratch.writableRoot))).toHaveLength(1)
    runner.shutdown()

    runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    expect(readdirSync(join(dirname(fixture.config.leaseStatePath), 'git-inspections'))).toEqual([])
    runner.shutdown()

    const linkedFixture = makeFixture()
    const controlRoot = dirname(linkedFixture.config.leaseStatePath)
    const target = join(linkedFixture.root, 'foreign-control-root')
    mkdirSync(target)
    symlinkSync(target, controlRoot)
    expect(() => new AgentsShellRunner(linkedFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })).toThrow(
      'agents-shell control root path must not contain symlinks',
    )

    const parentLinkedFixture = makeFixture()
    const foreignLeaseParent = join(parentLinkedFixture.root, 'foreign-lease-parent')
    const linkedLeaseParent = join(parentLinkedFixture.workspaceRoot, 'linked-lease-parent')
    mkdirSync(foreignLeaseParent)
    symlinkSync(foreignLeaseParent, linkedLeaseParent)
    parentLinkedFixture.config.workspaceLeaseRoot = join(linkedLeaseParent, 'lab')
    expect(
      () => new AgentsShellRunner(parentLinkedFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 }),
    ).toThrow('workspace lease root path must not contain symlinks')
    expect(existsSync(join(foreignLeaseParent, 'lab'))).toBe(false)
  })

  it('authenticates a private GitHub origin with only a server-owned non-executable header', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'authenticated-fetch')
    const advertisement = join(fixture.root, 'approved-remote-advertisement')
    const publicationMarker = join(fixture.root, 'authenticated-publication-probe')
    const remoteUrl = 'https://github.com/proompteng/lab.git'
    const token = 'server-owned-private-origin-token'
    const expectedHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    execFileSync(fixtureExecutables.git, ['-C', fixture.seedPath, 'remote', 'set-url', 'origin', remoteUrl])
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'authenticated-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
is_fetch=false
is_ls_remote=false
for arg in "$@"; do
  if [[ "$arg" == fetch ]]; then is_fetch=true; fi
  if [[ "$arg" == ls-remote ]]; then is_ls_remote=true; fi
done
if [[ "$is_fetch" == true || "$is_ls_remote" == true ]]; then
  [[ -z "\${GITHUB_TOKEN:-}\${GH_TOKEN:-}" ]] || exit 91
  header=''
  proxy='missing'
  ssl_verify='missing'
  scoped_proxy='missing'
  scoped_ssl_verify='missing'
  count="\${GIT_CONFIG_COUNT:-0}"
  for ((index = 0; index < count; index += 1)); do
    key_name="GIT_CONFIG_KEY_\${index}"
    value_name="GIT_CONFIG_VALUE_\${index}"
    key="\${!key_name:-}"
    value="\${!value_name:-}"
    if [[ "$key" == 'http.https://github.com/.extraHeader' ]]; then header="$value"; fi
    if [[ "$key" == 'http.proxy' ]]; then proxy="$value"; fi
    if [[ "$key" == 'http.sslVerify' ]]; then ssl_verify="$value"; fi
    if [[ "$key" == 'http.https://github.com/.proxy' ]]; then scoped_proxy="$value"; fi
    if [[ "$key" == 'http.https://github.com/.sslVerify' ]]; then scoped_ssl_verify="$value"; fi
  done
  [[ "$header" == ${JSON.stringify(expectedHeader)} ]] || exit 92
  [[ "$proxy" == '' ]] || exit 94
  [[ "$ssl_verify" == 'true' ]] || exit 95
  [[ "$scoped_proxy" == '' ]] || exit 96
  [[ "$scoped_ssl_verify" == 'true' ]] || exit 97
  for arg in "$@"; do
    [[ "$arg" != credential.helper='!'* ]] || exit 93
  done
fi
if [[ "$is_ls_remote" == true ]]; then
  [[ "\${GIT_DIR:-}" == '/dev/null' ]] || exit 98
  [[ "$*" == *${JSON.stringify(remoteUrl)}* ]] || exit 99
  cat ${JSON.stringify(advertisement)}
  printf authenticated > ${JSON.stringify(publicationMarker)}
  exit 0
fi
if [[ "$is_fetch" == true ]]; then
  printf authenticated > ${JSON.stringify(marker)}
  exit 0
fi
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const previousGithubToken = process.env.GITHUB_TOKEN
    const previousGhToken = process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = token
    delete process.env.GH_TOKEN
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'private-origin-owner' })
    try {
      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'private-origin' },
      })
      expect(acquired.isError).not.toBe(true)
      expect(readFileSync(marker, 'utf8')).toBe('authenticated')
      expect(JSON.stringify(acquired)).not.toContain(token)
      expect(readFileSync(fixture.auditLogPath, 'utf8')).not.toContain(token)
      const lease = runner.leases.ownedLease(connection.sessionId)!
      await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf published > published.txt' },
      })
      await connection.client.callTool({ name: 'git_write', arguments: { args: ['add', 'published.txt'] } })
      const committed = await connection.client.callTool({
        name: 'git_write',
        arguments: { args: ['commit', '-m', 'test: private publication probe'] },
      })
      expect(committed.isError).not.toBe(true)
      for (const [key, value] of [
        ['http.proxy', 'http://attacker.invalid:8080'],
        ['http.sslVerify', 'false'],
        ['http.https://github.com/.proxy', 'http://attacker.invalid:8080'],
        ['http.https://github.com/.sslVerify', 'false'],
      ]) {
        execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'config', key, value])
      }
      const localHead = execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      writeFileSync(advertisement, `${localHead}\trefs/heads/${lease.branch}\n`)
      const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('released')
      expect(readFileSync(publicationMarker, 'utf8')).toBe('authenticated')
      expect(existsSync(lease.workspacePath)).toBe(false)
      expect(readFileSync(fixture.auditLogPath, 'utf8')).not.toContain(token)
    } finally {
      if (previousGithubToken == null) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousGithubToken
      if (previousGhToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousGhToken
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('anchors every privileged local-config inspection to the validated repository', () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'explicit-repository-context')
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'repository-context-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
is_local_config=false
for arg in "$@"; do
  if [[ "$arg" == --local ]]; then is_local_config=true; fi
done
if [[ "$is_local_config" == true ]]; then
  repository=''
  previous=''
  for arg in "$@"; do
    if [[ "$previous" == -C ]]; then repository="$arg"; break; fi
    previous="$arg"
  done
  [[ "$repository" == ${JSON.stringify(fixture.existingWorkspace)} ]] || exit 94
  printf anchored >> ${JSON.stringify(marker)}
fi
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    try {
      expect(runner.leases.readOnlyGitConfigOverrides(fixture.existingWorkspace)).toEqual([
        '--git-dir',
        join(fixture.existingWorkspace, '.git'),
        '--work-tree',
        fixture.existingWorkspace,
      ])
      expect(readFileSync(marker, 'utf8')).toBe('anchoredanchoredanchoredanchored')
    } finally {
      runner.shutdown()
    }
  })

  it('binds read-only Git to the canonical lease worktree despite repository-controlled core.worktree', async () => {
    const fixture = makeFixture()
    const externalWorktree = join(fixture.root, 'external-worktree')
    mkdirSync(externalWorktree)
    writeFileSync(join(externalWorktree, 'README.md'), 'outside-secret\n')
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'worktree-root-owner' })
    try {
      const poisoned = await connection.client.callTool({
        name: 'git_write',
        arguments: { args: ['config', 'core.worktree', externalWorktree] },
      })
      expect(poisoned.isError).not.toBe(true)
      const raw = execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'diff'], {
        encoding: 'utf8',
      })
      expect(raw).toContain('outside-secret')

      const inspected = await connection.client.callTool({ name: 'git', arguments: { args: ['diff'] } })
      expect(inspected.isError).not.toBe(true)
      expect((inspected.structuredContent as { stdout?: string }).stdout ?? '').not.toContain('outside-secret')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects read-only Git while a lease process can rewrite config, then sanitizes after quiescence', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'racing-filter-invoked')
    const started = join(fixture.root, 'racing-config-started')
    const helper = writeTrustedExecutable(
      fixture.trustedBin,
      'racing-clean-filter',
      `#!${fixtureExecutables.bash}\nprintf invoked >> ${JSON.stringify(marker)}\ncat\n`,
    )
    writeFileSync(join(fixture.existingWorkspace, '.gitattributes'), 'README.md filter=racing\n')
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'add', '.gitattributes'])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'commit', '-m', 'test: racing filter'])

    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, {
      runner,
      acquire: true,
      sessionId: 'racing-config-owner',
    })
    try {
      const changed = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf changed > README.md' },
      })
      expect((changed.structuredContent as { ok?: boolean }).ok).toBe(true)
      const writer = await connection.client.callTool({
        name: 'shell_start',
        arguments: {
          command: `git config filter.racing.clean ${JSON.stringify(helper)}; printf started > ${JSON.stringify(started)}; while :; do git config filter.racing.clean ${JSON.stringify(helper)}; done`,
          timeoutSeconds: 30,
        },
      })
      const jobId = (writer.structuredContent as { jobId: string }).jobId
      await waitForFile(started)
      const blocked = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['diff', '--', 'README.md'] },
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('quiescent workspace')
      expect(existsSync(marker)).toBe(false)

      const killed = await connection.client.callTool({
        name: 'shell_kill',
        arguments: { jobId, signal: 'SIGKILL' },
      })
      expect(killed.isError).not.toBe(true)
      await waitForClose(runner.requireOwnedJob(jobId, connection.sessionId))
      execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'diff', '--', 'README.md'])
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      const inspected = await connection.client.callTool({
        name: 'git',
        arguments: { args: ['diff', '--', 'README.md'] },
      })
      expect(inspected.isError).not.toBe(true)
      expect((inspected.structuredContent as { stdout?: string }).stdout).toContain('changed')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('blocks new mutation for the entire read-only Git inspection transaction', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, {
      runner,
      acquire: true,
      sessionId: 'git-inspection-barrier',
    })
    try {
      await runner.withReadOnlyGitInspection(connection.sessionId, connection.auth, undefined, async () => {
        const blocked = await connection.client.callTool({
          name: 'shell_start',
          arguments: { command: 'printf escaped > inspection-race.txt' },
        })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('blocked during read-only Git inspection')
      })
      expect(existsSync(join(fixture.existingWorkspace, 'inspection-race.txt'))).toBe(false)
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects symlinked runtime components and Git config without modifying their targets', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'runtime-symlink-owner' })
    const lease = runner.leases.ownedLease(connection.sessionId)!
    const runtime = join(fixture.config.sessionRuntimeRoot, lease.leaseId)
    const targetDirectory = join(fixture.root, 'protected-runtime-directory')
    const targetFile = join(fixture.root, 'protected-runtime-file')
    mkdirSync(targetDirectory, { mode: 0o755 })
    writeFileSync(targetFile, 'protected-bytes\n', { mode: 0o600 })
    const targetBefore = statSync(targetFile)
    try {
      symlinkSync(targetDirectory, join(runtime, 'home'))
      expect(() => runner.leases.environment(lease)).toThrow('lease runtime component home')
      expect(readdirSync(targetDirectory)).toEqual([])
      rmSync(join(runtime, 'home'))

      mkdirSync(join(runtime, 'config'), { mode: 0o700 })
      symlinkSync(targetFile, join(runtime, 'config', 'gitconfig'))
      expect(() => runner.leases.environment(lease)).toThrow('lease Git config must be a non-symlink regular file')
      expect(readFileSync(targetFile, 'utf8')).toBe('protected-bytes\n')
      const targetAfter = statSync(targetFile)
      expect(targetAfter.uid).toBe(targetBefore.uid)
      expect(targetAfter.gid).toBe(targetBefore.gid)
      expect(targetAfter.mode & 0o777).toBe(targetBefore.mode & 0o777)
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('removes a server-created clone when the access token expires during its refresh', async () => {
    const fixture = makeFixture()
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'expiring-fetch-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == fetch ]]; then sleep 2; break; fi
done
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const auth = makeAuth()
    auth.payload.exp = Math.floor(Date.now() / 1000) + 1
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, auth, sessionId: 'expired-during-refresh' })
    try {
      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'expired-during-refresh' },
      })
      expect(acquired.isError).toBe(true)
      expect(JSON.stringify(acquired.content)).toContain('cannot outlive an expired access token')
      expect(readdirSync(fixture.leaseRoot).sort()).toEqual(['existing-workspace'])
      expect(readdirSync(fixture.config.sessionRuntimeRoot)).toEqual([])
      if (existsSync(fixture.config.leaseStatePath)) {
        const state = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as { leases: unknown[] }
        expect(state.leases).toEqual([])
      }
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  }, 10_000)

  it('keeps health and lease expiry responsive during a slow remote fetch and serializes the workspace path', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 1 })
    const fetchStarted = join(fixture.root, 'slow-privileged-fetch-started')
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'slow-privileged-fetch-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == fetch ]]; then
    printf started > ${JSON.stringify(fetchStarted)}
    sleep 3
    break
  fi
done
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const owner = await connectFixture(fixture, { runner, acquire: true, sessionId: 'slow-fetch-expiring-owner' })
    const slow = await connectFixture(fixture, { runner, sessionId: 'slow-fetch-acquirer' })
    const contender = await connectFixture(fixture, { runner, sessionId: 'slow-fetch-contender' })
    try {
      const started = await owner.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 30', timeoutSeconds: 30 },
      })
      expect(started.isError).not.toBe(true)
      const job = runner.requireOwnedJob((started.structuredContent as { jobId: string }).jobId, owner.sessionId)
      const ownerLease = runner.leases.ownedLease(owner.sessionId)!

      let slowSettled = false
      const slowAcquisition = slow.client
        .callTool({
          name: 'workspace_acquire',
          arguments: { task: 'slow-privileged-fetch' },
        })
        .finally(() => {
          slowSettled = true
        })
      await waitForFile(fetchStarted)
      const generatedWorkspace = readdirSync(fixture.leaseRoot)
        .filter((entry) => entry !== 'existing-workspace')
        .map((entry) => join(fixture.leaseRoot, entry))
      expect(generatedWorkspace).toHaveLength(1)

      const contenderAcquisition = contender.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'slow-fetch-contender', existingPath: generatedWorkspace[0] },
      })
      const handler = createAgentsShellRequestHandler(fixture.config, runner)
      const health = await Promise.race([
        handler(new Request('https://agents-shell.example.test/healthz')),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('health request stalled behind privileged Git')), 500),
        ),
      ])
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })

      await waitFor(
        () => runner.leases.findById(ownerLease.leaseId)?.status === 'expired',
        'lease expiry stalled behind privileged Git',
      )
      expect(slowSettled).toBe(false)
      await waitForClose(job)
      expect(job.status).toBe('killed')
      expect(job.signal).toBe('SIGKILL')

      const acquired = await slowAcquisition
      expect(acquired.isError).not.toBe(true)
      const blocked = await contenderAcquisition
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('already leased by another session')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_lease_expired')
    } finally {
      await closeFixtureConnection(contender)
      await closeFixtureConnection(slow)
      await closeFixtureConnection(owner)
      runner.shutdown()
    }
  }, 10_000)

  it('rolls back an adopted workspace when lease persistence fails before commit', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const failed = await connectFixture(fixture, { runner, sessionId: 'adopted-persist-failure' })
    try {
      rmSync(fixture.config.leaseStatePath, { force: true })
      mkdirSync(fixture.config.leaseStatePath)
      const acquired = await failed.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'adopted-persist-failure', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).toBe(true)
      expect(runner.leases.ownedLease(failed.sessionId)).toBeNull()
      expect(existsSync(fixture.existingWorkspace)).toBe(true)
      expect(statSync(fixture.existingWorkspace).mode & 0o022).toBe(0)
      expect(readdirSync(fixture.config.sessionRuntimeRoot)).toEqual([])

      rmSync(fixture.config.leaseStatePath, { recursive: true, force: true })
      const retried = await connectFixture(fixture, { runner, sessionId: 'adopted-persist-retry' })
      try {
        const retry = await retried.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'adopted-persist-retry', existingPath: fixture.existingWorkspace },
        })
        expect(retry.isError).not.toBe(true)
      } finally {
        await closeFixtureConnection(retried)
      }
    } finally {
      await closeFixtureConnection(failed)
      runner.shutdown()
    }
  })

  it('garbage-collects clean server-created clones and terminal lease records on release', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    try {
      for (let index = 0; index < 3; index += 1) {
        const connection = await connectFixture(fixture, { runner, sessionId: `gc-owner-${index}` })
        try {
          const acquired = await connection.client.callTool({
            name: 'workspace_acquire',
            arguments: { task: `gc-task-${index}` },
          })

          expect(acquired.isError).not.toBe(true)
          const workspacePath = (acquired.structuredContent as { workspacePath: string }).workspacePath
          expect(existsSync(workspacePath)).toBe(true)

          const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
          expect(released.isError).not.toBe(true)
          expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('released')
          expect(existsSync(workspacePath)).toBe(false)
          const state = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as { leases: unknown[] }
          expect(state.leases).toHaveLength(0)
          expect(readdirSync(fixture.leaseRoot).sort()).toEqual(['existing-workspace'])
        } finally {
          await closeFixtureConnection(connection)
        }
      }
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('"workspaceRemoved":true')

      for (let index = 0; index < 3; index += 1) {
        const adopted = await connectFixture(fixture, { runner, sessionId: `gc-adopted-owner-${index}` })
        try {
          const acquired = await adopted.client.callTool({
            name: 'workspace_acquire',
            arguments: { task: `gc-adopted-${index}`, existingPath: fixture.existingWorkspace },
          })
          expect(acquired.isError).not.toBe(true)
          const leaseId = (acquired.structuredContent as { leaseId: string }).leaseId
          const runtime = join(fixture.config.sessionRuntimeRoot, leaseId)
          expect(existsSync(runtime)).toBe(true)
          const released = await adopted.client.callTool({ name: 'workspace_release', arguments: {} })
          expect(released.isError).not.toBe(true)
          expect(existsSync(fixture.existingWorkspace)).toBe(true)
          expect(existsSync(runtime)).toBe(false)
        } finally {
          await closeFixtureConnection(adopted)
        }
      }
      const adoptedState = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ created: boolean; status: string; subject: string }>
      }
      expect(adoptedState.leases).toEqual([
        expect.objectContaining({ created: false, status: 'released', subject: 'user-1' }),
      ])
      expect(readdirSync(fixture.config.sessionRuntimeRoot)).toEqual([])
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('"runtimeRemoved":true')

      const dirty = await connectFixture(fixture, { runner, sessionId: 'gc-dirty-owner' })
      try {
        const acquired = await dirty.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'gc-dirty' },
        })
        expect(acquired.isError).not.toBe(true)
        const workspacePath = (acquired.structuredContent as { workspacePath: string }).workspacePath
        const mutation = await dirty.client.callTool({
          name: 'shell_run',
          arguments: { command: 'printf dirty >> README.md' },
        })
        expect(mutation.isError).not.toBe(true)
        const released = await dirty.client.callTool({ name: 'workspace_release', arguments: {} })
        expect(released.isError).not.toBe(true)
        expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')
        expect(existsSync(workspacePath)).toBe(true)
        const state = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
          leases: Array<{ created: boolean; status: string; workspacePath: string }>
        }
        expect(state.leases).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ created: false, status: 'released' }),
            expect.objectContaining({ created: true, status: 'quarantined', workspacePath }),
          ]),
        )
      } finally {
        await closeFixtureConnection(dirty)
      }
    } finally {
      runner.shutdown()
    }
  })

  it('wraps released session UIDs while retaining unsafe UID ownership', async () => {
    const fixture = makeFixture()
    const uid = process.geteuid?.() ?? 0
    fixture.config.sessionUidStart = uid
    fixture.config.sessionUidEnd = uid

    let runner = new AgentsShellRunner(fixture.config)
    const first = await connectFixture(fixture, { runner, sessionId: 'uid-wrap-first' })
    try {
      const acquired = await first.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'uid-wrap-first', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      expect(runner.leases.ownedLease(first.sessionId)?.uid).toBe(uid)
      const released = await first.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      const state = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        nextUid: number
        leases: Array<{ status: string; uid: number }>
      }
      expect(state.nextUid).toBe(uid)
      expect(state.leases).toEqual([expect.objectContaining({ status: 'released', uid })])
    } finally {
      await closeFixtureConnection(first)
      runner.shutdown()
    }

    runner = new AgentsShellRunner(fixture.config)
    const second = await connectFixture(fixture, { runner, sessionId: 'uid-wrap-second' })
    try {
      const acquired = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'uid-wrap-second', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      expect(runner.leases.ownedLease(second.sessionId)?.uid).toBe(uid)
      const dirtied = await second.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf retained > retained.txt' },
      })
      expect(dirtied.isError).not.toBe(true)
      const released = await second.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')

      const third = await connectFixture(fixture, { runner, sessionId: 'uid-wrap-third' })
      try {
        const blocked = await third.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'uid-wrap-third' },
        })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('session UID range exhausted')
      } finally {
        await closeFixtureConnection(third)
      }
    } finally {
      await closeFixtureConnection(second)
      runner.shutdown()
    }
  })

  it('retains clean unpushed commits and removes an advanced clone only after approved-remote publication', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    try {
      const unpublished = await connectFixture(fixture, { runner, sessionId: 'unpublished-owner' })
      try {
        const acquired = await unpublished.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'unpublished-commit' },
        })
        expect(acquired.isError).not.toBe(true)
        const lease = acquired.structuredContent as { leaseId: string; workspacePath: string; head: string }
        await unpublished.client.callTool({
          name: 'shell_run',
          arguments: { command: 'printf unpublished > unpublished.txt' },
        })
        await unpublished.client.callTool({ name: 'git_write', arguments: { args: ['add', 'unpublished.txt'] } })
        const committed = await unpublished.client.callTool({
          name: 'git_write',
          arguments: { args: ['commit', '-m', 'test: retain unpublished commit'] },
        })
        expect(committed.isError).not.toBe(true)
        const localHead = execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim()
        expect(localHead).not.toBe(lease.head)
        expect(
          execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'status', '--porcelain'], {
            encoding: 'utf8',
          }),
        ).toBe('')

        const released = await unpublished.client.callTool({ name: 'workspace_release', arguments: {} })
        expect(released.isError).not.toBe(true)
        expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')
        expect(existsSync(lease.workspacePath)).toBe(true)
        expect(
          execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
        ).toBe(localHead)
        expect(runner.leases.findById(lease.leaseId)).toMatchObject({
          status: 'quarantined',
          reason: 'unpublished_commits',
        })
      } finally {
        await closeFixtureConnection(unpublished)
      }

      const published = await connectFixture(fixture, { runner, sessionId: 'published-owner' })
      try {
        const acquired = await published.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: 'published-commit' },
        })
        expect(acquired.isError).not.toBe(true)
        const lease = acquired.structuredContent as {
          leaseId: string
          workspacePath: string
          branch: string
        }
        await published.client.callTool({
          name: 'shell_run',
          arguments: { command: 'printf published > published.txt' },
        })
        await published.client.callTool({ name: 'git_write', arguments: { args: ['add', 'published.txt'] } })
        const committed = await published.client.callTool({
          name: 'git_write',
          arguments: { args: ['commit', '-m', 'test: publish retained commit'] },
        })
        expect(committed.isError).not.toBe(true)
        execFileSync(fixtureExecutables.git, [
          '-C',
          lease.workspacePath,
          'push',
          'origin',
          `HEAD:refs/heads/${lease.branch}`,
        ])

        const released = await published.client.callTool({ name: 'workspace_release', arguments: {} })
        expect(released.isError).not.toBe(true)
        expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('released')
        expect(existsSync(lease.workspacePath)).toBe(false)
        expect(runner.leases.findById(lease.leaseId)).toBeNull()
      } finally {
        await closeFixtureConnection(published)
      }

      const audit = readFileSync(fixture.auditLogPath, 'utf8')
      expect(audit).toContain('"reason":"unpublished_commits"')
      expect(audit).toContain('"headAdvanced":true')
      expect(audit).toContain('"publicationProven":true')
      expect(audit).toContain('"publicationProven":false')
    } finally {
      runner.shutdown()
    }
  })

  it('retries a transient publication check after restart and preserves the server-created lifecycle', async () => {
    const fixture = makeFixture()
    const failedOnce = join(fixture.root, 'publication-check-failed-once')
    fixture.config.trustedExecutables.executables.git = writeTrustedExecutable(
      fixture.trustedBin,
      'transient-publication-git',
      `#!${fixtureExecutables.bash}
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == 'ls-remote' && ! -e ${JSON.stringify(failedOnce)} ]]; then
    printf failed > ${JSON.stringify(failedOnce)}
    printf 'transient publication outage\n' >&2
    exit 75
  fi
done
exec ${JSON.stringify(fixtureExecutables.git)} "$@"
`,
    )
    const uid = process.geteuid?.() ?? 0
    let runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const first = await connectFixture(fixture, { runner, sessionId: 'publication-retry-first' })
    let workspacePath = ''
    let oldRuntime = ''
    try {
      const acquired = await first.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'publication-retry' },
      })
      expect(acquired.isError).not.toBe(true)
      const lease = acquired.structuredContent as { leaseId: string; workspacePath: string; branch: string }
      workspacePath = lease.workspacePath
      oldRuntime = join(fixture.config.sessionRuntimeRoot, lease.leaseId)
      await first.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf published > publication-retry.txt' },
      })
      await first.client.callTool({ name: 'git_write', arguments: { args: ['add', 'publication-retry.txt'] } })
      const committed = await first.client.callTool({
        name: 'git_write',
        arguments: { args: ['commit', '-m', 'test: publication retry'] },
      })
      expect(committed.isError).not.toBe(true)
      execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'push', 'origin', `HEAD:refs/heads/${lease.branch}`])

      const released = await first.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')
      expect(runner.leases.findById(lease.leaseId)).toMatchObject({
        status: 'quarantined',
        reason: 'release_publication_check_failed',
        created: true,
      })
      expect(existsSync(workspacePath)).toBe(true)
      expect(existsSync(oldRuntime)).toBe(true)
    } finally {
      await closeFixtureConnection(first)
      runner.shutdown()
    }

    runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const retried = await connectFixture(fixture, { runner, sessionId: 'publication-retry-second' })
    try {
      const acquired = await retried.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'publication-retry', existingPath: workspacePath },
      })
      expect(acquired.isError, JSON.stringify(acquired)).not.toBe(true)
      expect(runner.leases.ownedLease(retried.sessionId)).toMatchObject({ status: 'active', created: true })
      expect(existsSync(oldRuntime)).toBe(false)

      const released = await retried.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError, JSON.stringify(released)).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('released')
      expect(existsSync(workspacePath)).toBe(false)
      const audit = readFileSync(fixture.auditLogPath, 'utf8')
      expect(audit).toContain('workspace_lease_publication_retried')
      expect(audit).toContain('"publicationCheckCompleted":true')
      expect(audit).toContain('"publicationProven":true')
    } finally {
      await closeFixtureConnection(retried)
      runner.shutdown()
    }
  })

  it('preserves the original publication baseline across revoked-lease recovery', async () => {
    const fixture = makeFixture()
    const uid = process.geteuid?.() ?? 0
    let runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const first = await connectFixture(fixture, { runner, sessionId: 'publication-baseline-first' })
    let workspacePath = ''
    let unpublishedHead = ''
    try {
      const acquired = await first.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'publication-baseline' },
      })
      expect(acquired.isError).not.toBe(true)
      const lease = acquired.structuredContent as { leaseId: string; workspacePath: string; head: string }
      workspacePath = lease.workspacePath
      await first.client.callTool({
        name: 'shell_run',
        arguments: { command: 'printf unpublished > inherited-unpublished.txt' },
      })
      await first.client.callTool({ name: 'git_write', arguments: { args: ['add', 'inherited-unpublished.txt'] } })
      const committed = await first.client.callTool({
        name: 'git_write',
        arguments: { args: ['commit', '-m', 'test: inherited unpublished commit'] },
      })
      expect(committed.isError).not.toBe(true)
      unpublishedHead = execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      expect(unpublishedHead).not.toBe(lease.head)
      runner.revokeSession(first.sessionId, first.auth, 'publication_baseline_recovery')
      expect(runner.leases.findById(lease.leaseId)?.status).toBe('revoked')
    } finally {
      await closeFixtureConnection(first)
      runner.shutdown()
    }

    runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => uid })
    const second = await connectFixture(fixture, { runner, sessionId: 'publication-baseline-second' })
    try {
      const acquired = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'publication-baseline', existingPath: workspacePath },
      })
      expect(acquired.isError, JSON.stringify(acquired)).not.toBe(true)
      expect((acquired.structuredContent as { head: string }).head).toBe(unpublishedHead)

      const released = await second.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError, JSON.stringify(released)).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')
      expect(existsSync(workspacePath)).toBe(true)
      expect(runner.leases.ownedLease(second.sessionId)).toBeNull()
      expect(runner.leases.findById((acquired.structuredContent as { leaseId: string }).leaseId)).toMatchObject({
        status: 'quarantined',
        reason: 'unpublished_commits',
      })
      expect(
        execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ).toBe(unpublishedHead)
    } finally {
      await closeFixtureConnection(second)
      runner.shutdown()
    }
  })

  it('retains clean clones with unpushed side branches, tags, or stashes', async () => {
    const scenarios: Array<{
      name: string
      mutate: (workspacePath: string, branch: string) => void
    }> = [
      {
        name: 'side-branch',
        mutate: (workspacePath, branch) => {
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'checkout', '-q', '-b', 'local-side-branch'])
          writeFileSync(join(workspacePath, 'side-branch.txt'), 'local side branch\n')
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'add', 'side-branch.txt'])
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'commit', '-q', '-m', 'test: local side branch'])
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'checkout', '-q', branch])
        },
      },
      {
        name: 'tag',
        mutate: (workspacePath) => {
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'tag', 'local-only-tag'])
        },
      },
      {
        name: 'stash',
        mutate: (workspacePath) => {
          writeFileSync(join(workspacePath, 'stashed.txt'), 'local stash\n')
          execFileSync(fixtureExecutables.git, ['-C', workspacePath, 'stash', 'push', '-q', '-u', '-m', 'local stash'])
        },
      },
    ]

    for (const scenario of scenarios) {
      const fixture = makeFixture()
      const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
      const connection = await connectFixture(fixture, {
        runner,
        sessionId: `local-ref-${scenario.name}`,
      })
      try {
        const acquired = await connection.client.callTool({
          name: 'workspace_acquire',
          arguments: { task: `local-ref-${scenario.name}` },
        })
        expect(acquired.isError, scenario.name).not.toBe(true)
        const lease = acquired.structuredContent as { leaseId: string; workspacePath: string; branch: string }
        scenario.mutate(lease.workspacePath, lease.branch)
        expect(
          execFileSync(fixtureExecutables.git, ['-C', lease.workspacePath, 'status', '--porcelain=v1'], {
            encoding: 'utf8',
          }),
          scenario.name,
        ).toBe('')

        const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
        expect(released.isError, `${scenario.name}: ${JSON.stringify(released)}`).not.toBe(true)
        expect((released.structuredContent as { lease?: { status?: string } }).lease?.status, scenario.name).toBe(
          'quarantined',
        )
        expect(runner.leases.findById(lease.leaseId), scenario.name).toMatchObject({
          status: 'quarantined',
          reason: 'unpublished_commits',
        })
        expect(existsSync(lease.workspacePath), scenario.name).toBe(true)
      } finally {
        await closeFixtureConnection(connection)
        runner.shutdown()
      }
    }
  })

  it('quarantines dirty lease loss and deterministically recovers only a clean orphan after restart', async () => {
    const dirtyFixture = makeFixture()
    const dirtyRunner = new AgentsShellRunner(dirtyFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const dirtySession = await connectFixture(dirtyFixture, { runner: dirtyRunner, acquire: true })
    await dirtySession.client.callTool({
      name: 'shell_run',
      arguments: { command: 'printf dirty >> README.md' },
    })
    dirtyRunner.shutdown()
    await closeFixtureConnection(dirtySession)

    const dirtyRestart = new AgentsShellRunner(dirtyFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const replacement = await connectFixture(dirtyFixture, { runner: dirtyRestart, sessionId: 'replacement' })
    try {
      const acquired = await replacement.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'replacement', existingPath: dirtyFixture.existingWorkspace },
      })
      expect(acquired.isError).toBe(true)
      expect(JSON.stringify(acquired.content)).toContain('dirty after lease loss and is quarantined')
      expect(readFileSync(dirtyFixture.auditLogPath, 'utf8')).toContain('workspace_lease_quarantined')
    } finally {
      await closeFixtureConnection(replacement)
      dirtyRestart.shutdown()
    }

    const cleanFixture = makeFixture()
    const cleanRunner = new AgentsShellRunner(cleanFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const cleanSession = await connectFixture(cleanFixture, { runner: cleanRunner, acquire: true })
    cleanRunner.shutdown()
    await closeFixtureConnection(cleanSession)

    const cleanRestart = new AgentsShellRunner(cleanFixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const resumed = await connectFixture(cleanFixture, { runner: cleanRestart, sessionId: 'resumed' })
    try {
      const acquired = await resumed.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'resumed', existingPath: cleanFixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      expect(readFileSync(cleanFixture.auditLogPath, 'utf8')).toContain('workspace_lease_recovered')
    } finally {
      await closeFixtureConnection(resumed)
      cleanRestart.shutdown()
    }
  })

  it('never transfers a recovered workspace across authenticated subjects', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const owner = await connectFixture(fixture, {
      runner,
      auth: makeAuth(undefined, 'owner-subject'),
      acquire: true,
      sessionId: 'owner-session',
    })
    const foreign = await connectFixture(fixture, {
      runner,
      auth: makeAuth(undefined, 'foreign-subject'),
      sessionId: 'foreign-session',
    })
    try {
      const released = await owner.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      const takeover = await foreign.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'foreign-takeover', existingPath: fixture.existingWorkspace },
      })
      expect(takeover.isError).toBe(true)
      expect(JSON.stringify(takeover.content)).toContain('another authenticated subject')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_lease_subject_rejected')
    } finally {
      await closeFixtureConnection(foreign)
      await closeFixtureConnection(owner)
      runner.shutdown()
    }
  })

  it('rejects cross-subject takeover after revocation', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const owner = await connectFixture(fixture, {
      runner,
      auth: makeAuth(undefined, 'revoked-owner'),
      acquire: true,
      sessionId: 'revoked-owner-session',
    })
    const foreign = await connectFixture(fixture, {
      runner,
      auth: makeAuth(undefined, 'revoked-foreign'),
      sessionId: 'revoked-foreign-session',
    })
    try {
      runner.revokeSession(owner.sessionId, owner.auth, 'test_revocation')
      const takeover = await foreign.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'revoked-foreign-takeover', existingPath: fixture.existingWorkspace },
      })
      expect(takeover.isError).toBe(true)
      expect(JSON.stringify(takeover.content)).toContain('another authenticated subject')
    } finally {
      await closeFixtureConnection(foreign)
      await closeFixtureConnection(owner)
      runner.shutdown()
    }
  })

  it('rejects cross-subject takeover after restart orphaning', async () => {
    const fixture = makeFixture()
    const ownerRunner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const owner = await connectFixture(fixture, {
      runner: ownerRunner,
      auth: makeAuth(undefined, 'orphan-owner'),
      acquire: true,
      sessionId: 'orphan-owner-session',
    })
    ownerRunner.shutdown()
    await closeFixtureConnection(owner)

    const restartedRunner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const foreign = await connectFixture(fixture, {
      runner: restartedRunner,
      auth: makeAuth(undefined, 'orphan-foreign'),
      sessionId: 'orphan-foreign-session',
    })
    try {
      const takeover = await foreign.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'orphan-foreign-takeover', existingPath: fixture.existingWorkspace },
      })
      expect(takeover.isError).toBe(true)
      expect(JSON.stringify(takeover.content)).toContain('another authenticated subject')
    } finally {
      await closeFixtureConnection(foreign)
      restartedRunner.shutdown()
    }
  })

  it('expires leases at the server deadline and persists the expiry audit before rejecting mutation', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 1 })
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'expiring-session' })
    try {
      const lease = runner.leases.ownedLease(connection.sessionId)!
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lease.expiresAt) + 1)
      const blocked = await connection.client.callTool({ name: 'shell_run', arguments: { command: 'touch late' } })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('workspace lease has expired')
      expect(runner.leases.findById(lease.leaseId)?.status).toBe('expired')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_lease_expired')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('caps lease expiry at the authenticated token expiry', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 300 })
    const tokenExpirySeconds = Math.floor(Date.now() / 1000) + 30
    const auth = makeAuth()
    auth.payload.exp = tokenExpirySeconds
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, {
      runner,
      auth,
      acquire: true,
      sessionId: 'token-expiry',
    })
    try {
      const lease = runner.leases.ownedLease(connection.sessionId)!
      expect(Date.parse(lease.expiresAt)).toBe(tokenExpirySeconds * 1000)
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('renews an active lease from a refreshed token and reschedules the original expiry timer', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 10 })
    const initialAuth = makeAuth()
    initialAuth.payload.exp = Math.floor(Date.now() / 1000) + 2
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, {
      runner,
      auth: initialAuth,
      acquire: true,
      sessionId: 'refreshed-token-renewal',
    })
    try {
      const original = runner.leases.ownedLease(connection.sessionId)!
      const originalExpiresAt = original.expiresAt
      const started = await connection.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 3; printf renewed > renewal-survived.txt', timeoutSeconds: 6 },
      })
      expect(started.isError).not.toBe(true)

      const refreshedAuth = makeAuth(undefined, initialAuth.subject)
      refreshedAuth.payload.exp = Math.floor(Date.now() / 1000) + 20
      const renewed = await runner.leases.acquire(connection.sessionId, refreshedAuth, { task: 'test-task' })
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(originalExpiresAt))
      expect(Date.parse(renewed.renewedAt)).toBeGreaterThanOrEqual(Date.parse(original.issuedAt))

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_500))
      expect(readFileSync(join(fixture.existingWorkspace, 'renewal-survived.txt'), 'utf8')).toBe('renewed')
      expect(runner.leases.ownedLease(connection.sessionId)).toMatchObject({
        status: 'active',
        expiresAt: renewed.expiresAt,
        renewedAt: renewed.renewedAt,
      })
      const persisted = JSON.parse(readFileSync(fixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ leaseId: string; renewedAt: string; expiresAt: string }>
      }
      expect(persisted.leases).toContainEqual(
        expect.objectContaining({
          leaseId: renewed.leaseId,
          renewedAt: renewed.renewedAt,
          expiresAt: renewed.expiresAt,
        }),
      )
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('"event":"workspace_lease_renewed"')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  }, 8_000)

  it('makes idle expiry authoritative in status and allows only clean reacquisition', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 1 })
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const first = await connectFixture(fixture, { runner, acquire: true, sessionId: 'idle-owner' })
    const second = await connectFixture(fixture, { runner, sessionId: 'idle-replacement' })
    try {
      const prior = runner.leases.ownedLease(first.sessionId)!
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(prior.expiresAt) + 1)
      const status = await first.client.callTool({ name: 'workspace_status', arguments: {} })
      expect(status.isError).not.toBe(true)
      expect((status.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('expired')

      const reacquired = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'idle-replacement', existingPath: fixture.existingWorkspace },
      })
      expect(reacquired.isError).not.toBe(true)
      expect((reacquired.structuredContent as { status?: string }).status).toBe('active')
      const audit = readFileSync(fixture.auditLogPath, 'utf8')
      expect(audit).toContain('lease_expired')
      expect(audit).toContain('workspace_lease_recovered')
    } finally {
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      runner.shutdown()
    }
  })

  it('expires an active long-running job and kills its detached process group', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 1 })
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'job-expiry' })
    try {
      const started = await connection.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 30 & wait', timeoutSeconds: 30 },
      })
      const job = runner.requireOwnedJob((started.structuredContent as { jobId: string }).jobId, connection.sessionId)
      const leaseId = job.leaseId
      await waitForClose(job)
      expect(job.status).toBe('killed')
      expect(job.signal).toBe('SIGKILL')
      expect(runner.leases.findById(leaseId)?.status).toBe('expired')
      const audit = readFileSync(fixture.auditLogPath, 'utf8')
      expect(audit).toContain('"reason":"lease_expired"')
      expect(audit).toContain('workspace_lease_expired')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('keeps lease expiry authoritative after a shell parent exits with a detached descendant', async () => {
    const fixture = makeFixture({ leaseTtlSeconds: 1 })
    let detachedPid: number | null = null
    const sweptUids: number[] = []
    const runner = new AgentsShellRunner(fixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
      terminateProcessesForUid: (uid) => {
        sweptUids.push(uid)
        if (detachedPid != null) {
          try {
            process.kill(detachedPid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        return detachedPid == null ? [] : [detachedPid]
      },
    })
    const first = await connectFixture(fixture, { runner, acquire: true, sessionId: 'detached-owner' })
    const second = await connectFixture(fixture, { runner, sessionId: 'detached-successor' })
    try {
      const started = await first.client.callTool({
        name: 'shell_start',
        arguments: {
          command: 'setsid sleep 30 </dev/null >/dev/null 2>&1 & printf "%s" "$!" > detached.pid',
          timeoutSeconds: 5,
        },
      })
      const job = runner.requireOwnedJob((started.structuredContent as { jobId: string }).jobId, first.sessionId)
      await waitForClose(job)
      expect(job.status).toBe('exited')
      const detachedPidPath = join(fixture.existingWorkspace, 'detached.pid')
      detachedPid = Number(readFileSync(detachedPidPath, 'utf8'))
      rmSync(detachedPidPath)
      process.kill(detachedPid, 0)

      const premature = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'premature-successor', existingPath: fixture.existingWorkspace },
      })
      expect(premature.isError).toBe(true)
      expect(JSON.stringify(premature.content)).toContain('already leased by another session')

      const lease = runner.leases.ownedLease(first.sessionId)!
      await waitFor(() => runner.leases.findById(lease.leaseId)?.status === 'expired', 'lease timer did not expire')
      expect(sweptUids).toEqual([process.geteuid?.() ?? 0])

      const acquired = await second.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'detached-successor', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_lease_expired')
    } finally {
      if (detachedPid != null) {
        try {
          process.kill(detachedPid, 'SIGKILL')
        } catch {
          // Already terminated by scheduled lease expiry.
        }
      }
      await closeFixtureConnection(second)
      await closeFixtureConnection(first)
      runner.shutdown()
    }
  })

  it('kills the complete detached process group when a lease is revoked', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'job-owner' })
    try {
      const started = await connection.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 30 & wait', timeoutSeconds: 30 },
      })
      const jobId = (started.structuredContent as { jobId: string }).jobId
      const job = runner.requireOwnedJob(jobId, connection.sessionId)
      const leaseId = job.leaseId
      const closed = waitForClose(job)
      runner.revokeSession(connection.sessionId, connection.auth, 'token_revoked')
      await closed
      expect(job.status).toBe('killed')
      expect(job.signal).toBe('SIGKILL')
      expect(runner.leases.findById(leaseId)?.status).toBe('revoked')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('token_revoked')
      expect(
        (
          await runner.acquireWorkspace('replacement-after-close', connection.auth, {
            task: 'replacement-after-close',
            existingPath: fixture.existingWorkspace,
          })
        ).status,
      ).toBe('active')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('kills an exited shell job descendant that escaped into a new session', async () => {
    const fixture = makeFixture()
    const escapedPidPath = join(fixture.existingWorkspace, 'escaped.pid')
    let escapedPid: number | null = null
    const sweptUids: number[] = []
    const runner = new AgentsShellRunner(fixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
      terminateProcessesForUid: (uid) => {
        sweptUids.push(uid)
        if (escapedPid != null) {
          try {
            process.kill(escapedPid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        return escapedPid == null ? [] : [escapedPid]
      },
    })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'escaped-child' })
    try {
      const result = await connection.client.callTool({
        name: 'shell_run',
        arguments: {
          command: 'setsid sleep 30 </dev/null >/dev/null 2>&1 & printf "%s" "$!" > escaped.pid',
          timeoutSeconds: 5,
        },
      })
      expect(result.isError).not.toBe(true)
      escapedPid = Number(readFileSync(escapedPidPath, 'utf8'))
      expect(Number.isSafeInteger(escapedPid)).toBe(true)
      process.kill(escapedPid, 0)
      expect(runner.runningJobs(connection.sessionId)).toHaveLength(0)

      runner.revokeSession(connection.sessionId, connection.auth, 'escaped_child_revoked')
      await waitFor(() => {
        try {
          const status = parseLinuxProcessStatus(readFileSync(`/proc/${escapedPid}/status`, 'utf8'))
          return status.state === 'Z'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
        }
      }, 'escaped child survived lease revocation')
      expect(sweptUids).toEqual([process.geteuid?.() ?? 0])
    } finally {
      if (escapedPid != null) {
        try {
          process.kill(escapedPid, 'SIGKILL')
        } catch {
          // Already terminated by the lease UID sweep.
        }
      }
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('revokes the session and active job after a previously valid bearer token is rejected', async () => {
    const fixture = makeFixture()
    const auth = makeAuth()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const verifier = {
      verify: vi
        .fn()
        .mockResolvedValueOnce(auth)
        .mockResolvedValueOnce(auth)
        .mockResolvedValueOnce(auth)
        .mockRejectedValueOnce(new Error('revoked token')),
    }
    const handler = createAgentsShellRequestHandler(fixture.config, runner, verifier)
    const initialized = await handler(mcpRequest(initializeBody, { authorization: 'Bearer valid' }))
    const sessionId = initialized.headers.get('mcp-session-id')!
    const acquire = await handler(
      mcpRequest(
        callBody(2, 'workspace_acquire', {
          task: 'token-revocation',
          existingPath: fixture.existingWorkspace,
        }),
        { authorization: 'Bearer valid', 'mcp-session-id': sessionId },
      ),
    )
    const acquireBody = (await acquire.json()) as { result?: { structuredContent?: { leaseId?: string } } }
    const leaseId = acquireBody.result?.structuredContent?.leaseId
    if (!leaseId) throw new Error('workspace acquisition did not return a lease id')
    const started = await handler(
      mcpRequest(callBody(3, 'shell_start', { command: 'sleep 30 & wait', timeoutSeconds: 30 }), {
        authorization: 'Bearer valid',
        'mcp-session-id': sessionId,
      }),
    )
    const startedBody = (await started.json()) as { result?: { structuredContent?: { jobId?: string } } }
    const jobId = startedBody.result?.structuredContent?.jobId
    if (!jobId) throw new Error('shell_start did not return a job id')
    const job = runner.requireOwnedJob(jobId, sessionId)
    const closed = waitForClose(job)

    const revoked = await handler(
      mcpRequest(callBody(4, 'workspace_status', {}), {
        authorization: 'Bearer revoked',
        'mcp-session-id': sessionId,
      }),
    )
    const revokedBody = (await revoked.json()) as { result?: { isError?: boolean } }
    expect(revokedBody.result?.isError).toBe(true)
    await closed
    expect(job.status).toBe('killed')
    expect(runner.leases.findById(leaseId!)?.status).toBe('revoked')
    expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('token_revoked_or_missing')
    runner.shutdown()
  })

  it('kills an in-flight mutating process group when its lease is revoked', async () => {
    const fixture = makeFixture()
    const startedPath = join(fixture.root, 'mutation-started')
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'blocking-kubectl',
      `#!${fixtureExecutables.bash}\nprintf started > ${JSON.stringify(startedPath)}\nsleep 30\n`,
    )
    fixture.config.trustedExecutables.executables.kubectl = fakeKubectl
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'mutation-owner' })
    try {
      const leaseId = runner.leases.ownedLease(connection.sessionId)!.leaseId
      const mutation = connection.client.callTool({
        name: 'kubectl_admin',
        arguments: { args: ['apply', '-f', '-'], timeoutSeconds: 30 },
      })
      await waitFor(() => existsSync(startedPath), 'mutating process did not start')
      runner.revokeSession(connection.sessionId, connection.auth, 'manual_revocation')
      const result = await Promise.race([
        mutation,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('mutation did not terminate')), 3000)),
      ])
      expect(result.isError).not.toBe(true)
      expect((result.structuredContent as { signal?: string }).signal).toBe('SIGKILL')
      expect(runner.leases.findById(leaseId)?.status).toBe('revoked')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('manual_revocation')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects symlink acquisition, symlink patch targets, and replaced workspace inodes', async () => {
    const fixture = makeFixture()
    const symlinkPath = join(fixture.leaseRoot, 'symlink-workspace')
    symlinkSync(fixture.existingWorkspace, symlinkPath)
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'canonical-session' })
    try {
      const symlinkAcquire = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'symlink', existingPath: symlinkPath },
      })
      expect(symlinkAcquire.isError).toBe(true)
      expect(JSON.stringify(symlinkAcquire.content)).toContain('must not contain symlinks')

      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'canonical', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      symlinkSync(fixture.seedPath, join(fixture.existingWorkspace, 'foreign'))
      const patch = await connection.client.callTool({
        name: 'apply_patch',
        arguments: {
          patch: '*** Begin Patch\n*** Add File: foreign/escape.txt\n+escape\n*** End Patch\n',
        },
      })
      expect(patch.isError).toBe(true)
      expect(JSON.stringify(patch.content)).toContain('resolves outside leased workspace')

      const moved = `${fixture.existingWorkspace}.moved`
      renameSync(fixture.existingWorkspace, moved)
      mkdirSync(fixture.existingWorkspace)
      const replaced = await connection.client.callTool({ name: 'shell_run', arguments: { command: 'touch replaced' } })
      expect(replaced.isError).toBe(true)
      expect(JSON.stringify(replaced.content)).toContain('workspace path or inode changed')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('workspace_identity_changed')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('runs every privileged Git management command with repository executables disabled and secrets absent', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'privileged-git-secret')
    const helper = join(fixture.existingWorkspace, '.git', 'hostile-helper')
    writeFileSync(
      helper,
      `#!${fixtureExecutables.bash}\nprintf '%s' "\${GH_TOKEN:-missing}" >> ${JSON.stringify(marker)}\ncat\n`,
      { mode: 0o755 },
    )
    chmodSync(helper, 0o755)
    writeFileSync(join(fixture.existingWorkspace, '.gitattributes'), 'README.md filter=hostile\n')
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'add', '.gitattributes'])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'commit', '-m', 'test: hostile config'])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', 'core.fsmonitor', helper])
    for (const key of ['clean', 'smudge']) {
      execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', `filter.hostile.${key}`, helper])
    }
    execFileSync(fixtureExecutables.git, [
      '-C',
      fixture.existingWorkspace,
      'config',
      'filter.hostile.process',
      `${helper} process`,
    ])
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', 'filter.hostile.required', 'true'])

    const previousToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'root-secret-must-not-leak'
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'privileged-git-owner' })
    try {
      const touched = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: 'touch README.md' },
      })
      expect(touched.isError).not.toBe(true)
      const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('released')
      expect(existsSync(marker)).toBe(false)
    } finally {
      if (previousToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects repository config include indirection before privileged Git inspection', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'included-git-secret')
    const helper = join(fixture.root, 'included-helper')
    const includedConfig = join(fixture.root, 'included.gitconfig')
    writeFileSync(
      helper,
      `#!${fixtureExecutables.bash}\nprintf '%s' "\${GH_TOKEN:-missing}" > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    )
    writeFileSync(includedConfig, `[core]\n\tfsmonitor = ${helper}\n`)
    execFileSync(fixtureExecutables.git, ['-C', fixture.existingWorkspace, 'config', 'include.path', includedConfig])
    const previousToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'included-root-secret'
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'included-config-owner' })
    try {
      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'included-config', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).toBe(true)
      expect(JSON.stringify(acquired.content)).toContain('rejects repository config includes')
      expect(existsSync(marker)).toBe(false)
    } finally {
      if (previousToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('quarantines a released lease when repository config include validation fails', async () => {
    const fixture = makeFixture()
    const marker = join(fixture.root, 'release-included-git-secret')
    const helper = join(fixture.root, 'release-included-helper')
    const includedConfig = join(fixture.root, 'release-included.gitconfig')
    writeFileSync(
      helper,
      `#!${fixtureExecutables.bash}\nprintf '%s' "\${GH_TOKEN:-missing}" > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    )
    writeFileSync(includedConfig, `[core]\n\tfsmonitor = ${helper}\n`)
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'release-include-owner' })
    const leaseId = runner.leases.ownedLease(connection.sessionId)!.leaseId
    const previousToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'release-included-root-secret'
    try {
      const configured = await connection.client.callTool({
        name: 'shell_run',
        arguments: { command: `git config include.path ${JSON.stringify(includedConfig)}` },
      })
      expect(configured.isError).not.toBe(true)
      const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).toBe(true)
      expect(JSON.stringify(released.content)).toContain('rejects repository config includes')
      expect(runner.leases.findById(leaseId)?.status).toBe('quarantined')
      expect(runner.leases.findById(leaseId)?.reason).toBe('release_git_inspection_failed')
      expect(runner.leases.ownedLease(connection.sessionId)).toBeNull()
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('"gitInspectionCompleted":false')
    } finally {
      if (previousToken == null) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it.runIf(nativeIdentityAvailable)(
    'uses production lease UIDs for read-only search and Git while rejecting cross-subject traversal',
    async () => {
      const helperRoot = mkdtempSync(join(tmpdir(), 'agents-shell-native-'))
      chmodSync(helperRoot, 0o755)
      const nativeHelper = join(helperRoot, 'agents-shell-landlock')
      execFileSync(compiler!, [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        nativeHelper,
        join(process.cwd(), 'src', 'server', 'agents-shell', 'native', 'landlock-exec.c'),
      ])
      chmodSync(nativeHelper, 0o755)

      const fixture = makeFixture()
      chmodSync(fixture.root, 0o755)
      chmodSync(fixture.trustedBin, 0o755)
      fixture.config.sessionUidStart = 200_000
      fixture.config.sessionUidEnd = 200_001
      fixture.config.inspectionUid = 65_534
      fixture.config.inspectionGid = 65_534
      fixture.config.trustedExecutables.executables.landlock = nativeHelper
      fixture.config.trustedExecutables.executables.rg = findTestExecutable('rg')
      const allocated = [200_000, 200_001]
      const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => allocated.shift()! })
      const first = await connectFixture(fixture, { runner, acquire: true, sessionId: 'production-owner' })
      const second = await connectFixture(fixture, {
        runner,
        auth: makeAuth(undefined, 'different-subject'),
        sessionId: 'production-foreign',
      })
      try {
        const identity = await first.client.callTool({
          name: 'shell_run',
          arguments: { command: `${findTestExecutable('id')} -u` },
        })
        expect((identity.structuredContent as { stdout?: string }).stdout).toBe('200000')
        const mutation = await first.client.callTool({
          name: 'shell_run',
          arguments: { command: 'printf production-owner >> README.md' },
        })
        expect(mutation.isError).not.toBe(true)
        const search = await first.client.callTool({
          name: 'search',
          arguments: { query: 'production-owner' },
        })
        expect(search.isError).not.toBe(true)
        expect((search.structuredContent as { stdout?: string }).stdout).toContain('README.md')
        const status = await first.client.callTool({ name: 'git', arguments: { args: ['status', '--short'] } })
        expect(status.isError).not.toBe(true)
        expect((status.structuredContent as { stdout?: string }).stdout).toContain('README.md')

        const firstLease = runner.leases.ownedLease(first.sessionId)!
        expect(firstLease.uid).toBe(200_000)
        const foreignSearch = await second.client.callTool({
          name: 'search',
          arguments: { query: 'production-owner', path: firstLease.workspacePath },
        })
        expect(foreignSearch.isError).toBe(true)
        expect(JSON.stringify(foreignSearch.content)).toContain('current session workspace')
        const foreignGit = await second.client.callTool({
          name: 'git',
          arguments: { args: ['status', '--short'], cwd: firstLease.workspacePath },
        })
        expect(foreignGit.isError).toBe(true)
        expect(JSON.stringify(foreignGit.content)).toContain('current session workspace')
      } finally {
        await closeFixtureConnection(second)
        await closeFixtureConnection(first)
        runner.shutdown()
        rmSync(helperRoot, { recursive: true, force: true })
      }
    },
  )

  it('reads only from a no-follow descriptor whose opened target matches the validated path', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'read-race-owner' })
    const originalResolve = runner.leases.resolveReadablePath.bind(runner.leases)
    try {
      const finalPath = join(fixture.existingWorkspace, 'final-swap.txt')
      writeFileSync(finalPath, 'safe-final\n')
      const finalSwap = vi.spyOn(runner.leases, 'resolveReadablePath').mockImplementationOnce((...args) => {
        const resolved = originalResolve(...args)
        renameSync(resolved, `${resolved}.validated`)
        symlinkSync(fixture.config.leaseStatePath, resolved)
        return resolved
      })
      const finalResult = await connection.client.callTool({
        name: 'read_file',
        arguments: { path: 'final-swap.txt' },
      })
      expect(finalResult.isError).toBe(true)
      expect(JSON.stringify(finalResult.content)).not.toContain('sessionHash')
      finalSwap.mockRestore()

      const safeDirectory = join(fixture.existingWorkspace, 'parent-swap')
      const safePath = join(safeDirectory, 'leases.json')
      mkdirSync(safeDirectory)
      writeFileSync(safePath, 'safe-parent\n')
      const parentSwap = vi.spyOn(runner.leases, 'resolveReadablePath').mockImplementationOnce((...args) => {
        const resolved = originalResolve(...args)
        renameSync(safeDirectory, `${safeDirectory}.validated`)
        symlinkSync(dirname(fixture.config.leaseStatePath), safeDirectory)
        return resolved
      })
      const parentResult = await connection.client.callTool({
        name: 'read_file',
        arguments: { path: 'parent-swap/leases.json' },
      })
      expect(parentResult.isError).toBe(true)
      expect(JSON.stringify(parentResult.content)).toContain('path changed after validation')
      expect(JSON.stringify(parentResult.content)).not.toContain('sessionHash')
      parentSwap.mockRestore()
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('rejects linked Git metadata and hard-linked files before assigning a lease UID', async () => {
    const linkedFixture = makeFixture()
    const linkedPath = join(linkedFixture.leaseRoot, 'linked-worktree')
    execFileSync(fixtureExecutables.git, ['-C', linkedFixture.seedPath, 'worktree', 'add', '--detach', linkedPath])
    const linkedRunner = new AgentsShellRunner(linkedFixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
    })
    const linkedSession = await connectFixture(linkedFixture, { runner: linkedRunner, sessionId: 'linked-git' })
    try {
      const acquired = await linkedSession.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'linked-git', existingPath: linkedPath },
      })
      expect(acquired.isError).toBe(true)
      expect(JSON.stringify(acquired.content)).toContain('Git metadata must stay inside')
    } finally {
      await closeFixtureConnection(linkedSession)
      linkedRunner.shutdown()
    }

    const hardlinkFixture = makeFixture()
    linkSync(
      join(hardlinkFixture.seedPath, 'README.md'),
      join(hardlinkFixture.existingWorkspace, 'foreign-hardlink.txt'),
    )
    const hardlinkRunner = new AgentsShellRunner(hardlinkFixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
    })
    const hardlinkSession = await connectFixture(hardlinkFixture, {
      runner: hardlinkRunner,
      sessionId: 'hardlink',
    })
    try {
      const acquired = await hardlinkSession.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'hardlink', existingPath: hardlinkFixture.existingWorkspace },
      })
      expect(acquired.isError).toBe(true)
      expect(JSON.stringify(acquired.content)).toContain('hard-linked file')
    } finally {
      await closeFixtureConnection(hardlinkSession)
      hardlinkRunner.shutdown()
    }
  })

  it('rejects mutating Git repository selectors and config injection before execution', async () => {
    const fixture = makeFixture()
    const connection = await connectFixture(fixture, { acquire: true, sessionId: 'git-selector-owner' })
    try {
      for (const args of [
        ['-C', fixture.seedPath, 'status'],
        ['--git-dir', join(fixture.seedPath, '.git'), 'status'],
        ['--work-tree', fixture.seedPath, 'status'],
        ['-c', 'core.hooksPath=/tmp/hooks', 'status'],
      ]) {
        const blocked = await connection.client.callTool({ name: 'git_write', arguments: { args } })
        expect(blocked.isError, args.join(' ')).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('rejects repository selectors and config injection')
      }
    } finally {
      await closeFixtureConnection(connection)
    }
  })

  it('rejects kubectl file-backed output templates before they can read credentials', async () => {
    const fixture = makeFixture()
    const credential = join(fixture.root, 'projected-token')
    const marker = join(fixture.root, 'kubectl-output-marker')
    writeFileSync(credential, 'credential-must-not-render\n', { mode: 0o644 })
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'file-output-kubectl',
      `#!${fixtureExecutables.bash}
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    custom-columns-file=*|go-template-file=*|jsonpath-file=*) cat "\${arg#*=}" > ${JSON.stringify(marker)}; exit 0 ;;
    -ocustom-columns-file=*|-ogo-template-file=*|-ojsonpath-file=*) cat "\${arg#*=}" > ${JSON.stringify(marker)}; exit 0 ;;
  esac
done
exit 0
`,
    )
    fixture.config.trustedExecutables.executables.kubectl = fakeKubectl
    execFileSync(fakeKubectl, ['get', 'pods', '-o', `go-template-file=${credential}`])
    expect(readFileSync(marker, 'utf8')).toBe('credential-must-not-render\n')
    rmSync(marker)

    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'kubectl-file-output-owner' })
    try {
      for (const args of [
        ['get', 'pods', '-o', `go-template-file=${credential}`],
        ['get', 'pods', '--output', `jsonpath-file=${credential}`],
        ['get', 'pods', `--output=custom-columns-file=${credential}`],
        ['get', 'pods', `-o=go-template-file=${credential}`],
        ['get', 'pods', `-ojsonpath-file=${credential}`],
      ]) {
        const blocked = await connection.client.callTool({ name: 'kubectl', arguments: { args } })
        expect(blocked.isError, args.join(' ')).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('rejects file-backed output templates')
        expect(existsSync(marker), args.join(' ')).toBe(false)
      }
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('binds synchronous mutating subprocesses so release blocks and revocation kills them', async () => {
    const fixture = makeFixture()
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'slow-kubectl',
      `#!${fixtureExecutables.bash}\nset -euo pipefail\nprintf started > mutation-started\nsleep 30\nprintf completed > mutation-completed\n`,
    )
    fixture.config.trustedExecutables.executables.kubectl = fakeKubectl
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'sync-mutation' })
    try {
      const mutation = connection.client.callTool({
        name: 'kubectl_admin',
        arguments: { args: ['apply', '-f', '-'], timeoutSeconds: 30 },
      })
      await waitForFile(join(fixture.existingWorkspace, 'mutation-started'))
      const release = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(release.isError).toBe(true)
      expect(JSON.stringify(release.content)).toContain('active jobs')
      const lease = runner.leases.ownedLease(connection.sessionId)!
      runner.revokeSession(connection.sessionId, connection.auth, 'synchronous_mutation_revoked')
      const result = await mutation
      expect((result.structuredContent as { signal?: string | null }).signal).toBe('SIGKILL')
      expect(existsSync(join(fixture.existingWorkspace, 'mutation-completed'))).toBe(false)
      expect(runner.leases.findById(lease.leaseId)?.status).toBe('revoked')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('sweeps escaped UID descendants and closes inherited pipes when a mutating tool times out', async () => {
    const fixture = makeFixture()
    const escapedPidPath = join(fixture.existingWorkspace, 'timeout-escaped.pid')
    let escapedPid: number | null = null
    const sweptUids: number[] = []
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'timeout-escaped-kubectl',
      `#!${fixtureExecutables.bash}
set -euo pipefail
setsid ${fixtureExecutables.bash} -c 'printf "%s" "$$" > timeout-escaped.pid; sleep 30' &
exit 0
`,
    )
    fixture.config.trustedExecutables.executables.kubectl = fakeKubectl
    const uid = process.geteuid?.() ?? 0
    const runner = new AgentsShellRunner(fixture.config, {
      uidAllocator: () => uid,
      terminateProcessesForUid: (sweptUid) => {
        sweptUids.push(sweptUid)
        if (escapedPid != null) {
          try {
            process.kill(escapedPid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        return escapedPid == null ? [] : [escapedPid]
      },
    })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'timeout-escaped-owner' })
    try {
      const startedAt = Date.now()
      const mutation = connection.client.callTool({
        name: 'kubectl_admin',
        arguments: { args: ['apply', '-f', '-'], timeoutSeconds: 1 },
      })
      await waitForFile(escapedPidPath)
      escapedPid = Number(readFileSync(escapedPidPath, 'utf8'))
      expect(Number.isSafeInteger(escapedPid)).toBe(true)
      process.kill(escapedPid, 0)

      const result = await mutation
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect((result.structuredContent as { timedOut?: boolean }).timedOut).toBe(true)
      expect(sweptUids).toEqual([uid])
      expect(runner.leases.ownedLease(connection.sessionId)?.activeJobIds).toEqual([])
      await waitFor(() => {
        try {
          const status = parseLinuxProcessStatus(readFileSync(`/proc/${escapedPid}/status`, 'utf8'))
          return status.state === 'Z'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
        }
      }, 'escaped timeout child survived the lease UID sweep')
    } finally {
      if (escapedPid != null) {
        try {
          process.kill(escapedPid, 'SIGKILL')
        } catch {
          // Already terminated by the timeout UID sweep.
        }
      }
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  }, 10_000)

  it('sweeps the lease UID on normal release even after tracked jobs have exited', async () => {
    const fixture = makeFixture()
    const sweptUids: number[] = []
    const runner = new AgentsShellRunner(fixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
      terminateProcessesForUid: (uid) => {
        sweptUids.push(uid)
        return []
      },
    })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'release-sweep' })
    try {
      const ran = await connection.client.callTool({ name: 'shell_run', arguments: { command: 'true' } })
      expect(ran.isError).not.toBe(true)
      const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect(sweptUids).toEqual([process.geteuid?.() ?? 0])
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('checks cleanliness only after escaped lease processes are terminated', async () => {
    const fixture = makeFixture()
    const runner = new AgentsShellRunner(fixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
      terminateProcessesForUid: () => {
        writeFileSync(join(fixture.existingWorkspace, 'escaped-final-write.txt'), 'dirty\n')
        return []
      },
    })
    const connection = await connectFixture(fixture, { runner, acquire: true, sessionId: 'release-race' })
    try {
      const released = await connection.client.callTool({ name: 'workspace_release', arguments: {} })
      expect(released.isError).not.toBe(true)
      expect((released.structuredContent as { lease?: { status?: string } }).lease?.status).toBe('quarantined')
      expect(readFileSync(fixture.auditLogPath, 'utf8')).toContain('dirty_on_release')
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('requires the lease boundary at every mutating tool entrypoint and permits them for one owned task', async () => {
    const fixture = makeFixture()
    const fakeKubectl = writeTrustedExecutable(
      fixture.trustedBin,
      'fake-kubectl',
      `#!${fixtureExecutables.bash}\ncat >/dev/null || true\nprintf 'kubectl-ok\\n'\n`,
    )
    fixture.config.trustedExecutables.executables.kubectl = fakeKubectl
    const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })
    const connection = await connectFixture(fixture, { runner, sessionId: 'mutation-entrypoints' })
    const mutationCalls = [
      ['shell_run', { command: 'true' }],
      ['shell_start', { command: 'true' }],
      ['git_write', { args: ['config', 'test.boundary', 'true'] }],
      ['apply_patch', { patch: '*** Begin Patch\n*** Add File: entrypoint.txt\n+ok\n*** End Patch\n' }],
      ['kubectl_admin', { args: ['apply', '-f', '-'] }],
      ['agent_start', { task: 'entrypoint test', headBranch: 'codex/entrypoint-test' }],
      ['agent_cancel', { agentRunName: 'entrypoint-test' }],
    ] as const
    try {
      for (const [name, args] of mutationCalls) {
        const blocked = await connection.client.callTool({ name, arguments: args })
        expect(blocked.isError, name).toBe(true)
        expect(JSON.stringify(blocked.content), name).toContain('active workspace lease is required')
      }

      const acquired = await connection.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'entrypoints', existingPath: fixture.existingWorkspace },
      })
      expect(acquired.isError).not.toBe(true)
      for (const [name, args] of mutationCalls) {
        const allowed = await connection.client.callTool({ name, arguments: args })
        expect(allowed.isError, name).not.toBe(true)
      }
      expect(readFileSync(join(fixture.existingWorkspace, 'entrypoint.txt'), 'utf8')).toBe('ok\n')
      const audit = readFileSync(fixture.auditLogPath, 'utf8')
      for (const event of ['git_write', 'apply_patch', 'kubectl_admin', 'agent_start', 'agent_cancel']) {
        expect(audit).toContain(`"event":"${event}"`)
        expect(audit).toContain(`"event":"${event}_finished"`)
      }
    } finally {
      await closeFixtureConnection(connection)
      runner.shutdown()
    }
  })

  it('revokes acquisition and job binding when a required audit record cannot persist', async () => {
    const acquireFixture = makeFixture()
    const acquireRunner = new AgentsShellRunner(acquireFixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
    })
    const acquireSession = await connectFixture(acquireFixture, {
      runner: acquireRunner,
      sessionId: 'audit-acquire',
    })
    try {
      rmSync(acquireFixture.auditLogPath, { force: true })
      mkdirSync(acquireFixture.auditLogPath)
      const acquired = await acquireSession.client.callTool({
        name: 'workspace_acquire',
        arguments: { task: 'audit-acquire', existingPath: acquireFixture.existingWorkspace },
      })
      expect(acquired.isError).toBe(true)
      expect(acquireRunner.leases.ownedLease(acquireSession.sessionId)).toBeNull()
      const persisted = JSON.parse(readFileSync(acquireFixture.config.leaseStatePath, 'utf8')) as {
        leases: Array<{ status: string; reason: string | null }>
      }
      expect(persisted.leases.at(-1)).toMatchObject({
        status: 'revoked',
        reason: 'audit_persistence_failed',
      })
    } finally {
      await closeFixtureConnection(acquireSession)
      acquireRunner.shutdown()
    }

    const jobFixture = makeFixture()
    const jobRunner = new AgentsShellRunner(jobFixture.config, {
      uidAllocator: () => process.geteuid?.() ?? 0,
    })
    const jobSession = await connectFixture(jobFixture, {
      runner: jobRunner,
      acquire: true,
      sessionId: 'audit-job',
    })
    try {
      const leaseId = jobRunner.leases.ownedLease(jobSession.sessionId)!.leaseId
      rmSync(jobFixture.auditLogPath, { force: true })
      mkdirSync(jobFixture.auditLogPath)
      const started = await jobSession.client.callTool({
        name: 'shell_start',
        arguments: { command: 'sleep 30', timeoutSeconds: 30 },
      })
      expect(started.isError).toBe(true)
      expect(jobRunner.runningJobs()).toHaveLength(0)
      expect(jobRunner.leases.findById(leaseId)).toMatchObject({
        status: 'revoked',
        reason: 'audit_persistence_failed',
      })
    } finally {
      await closeFixtureConnection(jobSession)
      jobRunner.shutdown()
    }
  })
})

describe('agents-shell native and packaging confinement', () => {
  it('terminates every non-zombie process with the lease UID regardless of process group', () => {
    const fixture = makeFixture()
    const procRoot = join(fixture.root, 'proc')
    const writeStatus = (pid: number, uid: number, state = 'S') => {
      const path = join(procRoot, String(pid))
      mkdirSync(path, { recursive: true })
      writeFileSync(
        join(path, 'status'),
        `Name:\ttest\nState:\t${state} (state)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
      )
    }
    writeStatus(101, 200001)
    writeStatus(202, 200001)
    writeStatus(303, 200002)
    writeStatus(404, 200001, 'Z')
    expect(processIdsForUid(200001, { procRoot })).toEqual([101, 202])

    const killed: number[] = []
    expect(
      terminateProcessesForUid(200001, {
        procRoot,
        settleMs: 0,
        kill: (pid) => {
          killed.push(pid)
          rmSync(join(procRoot, String(pid)), { recursive: true, force: true })
        },
      }),
    ).toEqual([101, 202])
    expect(killed).toEqual([101, 202])
    expect(processIdsForUid(200002, { procRoot })).toEqual([303])
  })

  it('fails closed at startup when the durable audit sink is unavailable', () => {
    const fixture = makeFixture()
    mkdirSync(fixture.auditLogPath, { recursive: true })
    expect(() => new AgentsShellRunner(fixture.config, { uidAllocator: () => process.geteuid?.() ?? 0 })).toThrow()
  })

  it.skipIf(!compiler)('uses real Landlock to deny absolute, traversal, symlink, and subprocess writes', () => {
    const fixture = makeFixture()
    const helper = join(fixture.root, 'agents-shell-landlock')
    const source = join(process.cwd(), 'src', 'server', 'agents-shell', 'native', 'landlock-exec.c')
    execFileSync(compiler!, ['-O2', '-Wall', '-Wextra', '-Werror', '-o', helper, source])
    expect(execFileSync(helper, ['--check'], { encoding: 'utf8' })).toMatch(/^landlock-abi=\d+\n$/)

    const runPinnedHelper = (cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      const cwdFd = openSync(cwd, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      try {
        return spawnSync(
          helper,
          [
            '--uid',
            String(process.geteuid?.() ?? 0),
            '--gid',
            String(process.getegid?.() ?? 0),
            '--parent-pid',
            String(process.pid),
            '--cwd-fd',
            '3',
            ...args,
          ],
          {
            encoding: 'utf8',
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe', cwdFd],
          },
        )
      } finally {
        closeSync(cwdFd)
      }
    }

    const allowed = join(fixture.root, 'allowed')
    const denied = join(fixture.root, 'denied')
    mkdirSync(join(allowed, 'sub'), { recursive: true })
    mkdirSync(denied, { recursive: true })
    const script = `
set -euo pipefail
printf allowed > "$ALLOWED/ok"
if printf denied > "$DENIED/absolute"; then exit 10; fi
cd "$ALLOWED/sub"
if printf denied > ../../denied/traversal; then exit 11; fi
ln -s "$DENIED" "$ALLOWED/link"
if printf denied > "$ALLOWED/link/symlink"; then exit 12; fi
if sh -c 'printf denied > "$DENIED/subprocess"'; then exit 13; fi
`
    const writable = runPinnedHelper(
      allowed,
      [
        '--write-root',
        allowed,
        '--write-file',
        '/dev/null',
        '--',
        fixtureExecutables.bash,
        '--noprofile',
        '--norc',
        '-c',
        script,
      ],
      { env: { ...process.env, ALLOWED: allowed, DENIED: denied } },
    )
    expect(writable.status, writable.stderr).toBe(0)
    expect(readFileSync(join(allowed, 'ok'), 'utf8')).toBe('allowed')
    for (const name of ['absolute', 'traversal', 'symlink', 'subprocess']) {
      expect(existsSync(join(denied, name)), name).toBe(false)
    }

    const readOnly = runPinnedHelper(fixture.seedPath, [
      '--read-only',
      '--',
      fixtureExecutables.bash,
      '--noprofile',
      '--norc',
      '-c',
      `printf denied > ${JSON.stringify(join(fixture.seedPath, 'mutated'))}`,
    ])
    expect(readOnly.status).not.toBe(0)
    expect(existsSync(join(fixture.seedPath, 'mutated'))).toBe(false)

    const scratch = join(fixture.root, 'inspection-scratch')
    mkdirSync(scratch)
    const scratchOnly = runPinnedHelper(fixture.seedPath, [
      '--write-root',
      scratch,
      '--read-only',
      '--',
      fixtureExecutables.bash,
      '--noprofile',
      '--norc',
      '-c',
      `printf scratch > ${JSON.stringify(join(scratch, 'index.lock'))}; if printf denied > ${JSON.stringify(
        join(fixture.seedPath, 'scratch-escape'),
      )}; then exit 14; fi`,
    ])
    expect(scratchOnly.status, scratchOnly.stderr).toBe(0)
    expect(readFileSync(join(scratch, 'index.lock'), 'utf8')).toBe('scratch')
    expect(existsSync(join(fixture.seedPath, 'scratch-escape'))).toBe(false)

    const pinnedDirectory = join(fixture.root, 'pinned-cwd')
    const movedDirectory = `${pinnedDirectory}.moved`
    const secretDirectory = join(fixture.root, 'secret-cwd')
    mkdirSync(pinnedDirectory)
    mkdirSync(secretDirectory)
    writeFileSync(join(pinnedDirectory, 'value.txt'), 'pinned-safe-value\n')
    writeFileSync(join(secretDirectory, 'value.txt'), 'projected-secret-value\n')
    const cwdFd = openSync(pinnedDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    renameSync(pinnedDirectory, movedDirectory)
    symlinkSync(secretDirectory, pinnedDirectory)
    try {
      const pinned = spawnSync(
        helper,
        [
          '--uid',
          String(process.geteuid?.() ?? 0),
          '--gid',
          String(process.getegid?.() ?? 0),
          '--parent-pid',
          String(process.pid),
          '--cwd-fd',
          '3',
          '--read-only',
          '--',
          fixtureExecutables.bash,
          '--noprofile',
          '--norc',
          '-c',
          'cat ./value.txt',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', cwdFd] },
      )
      expect(pinned.status, pinned.stderr).toBe(0)
      expect(pinned.stdout).toBe('pinned-safe-value\n')
      expect(pinned.stdout).not.toContain('projected-secret-value')
    } finally {
      closeSync(cwdFd)
    }
  })

  it('packages the native helper with only required identity and process-control capabilities', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8')
    const nixImage = readFileSync(join(process.cwd(), '..', '..', 'nix', 'images', 'agents.nix'), 'utf8')
    const chartValues = readFileSync(join(process.cwd(), '..', '..', 'charts', 'agents', 'values.yaml'), 'utf8')
    const deployService = readFileSync(
      join(process.cwd(), '..', '..', 'packages', 'scripts', 'src', 'agents', 'deploy-service.ts'),
      'utf8',
    )
    const deployment = readFileSync(
      join(process.cwd(), '..', '..', 'charts', 'agents', 'templates', 'agents-shell-deployment.yaml'),
      'utf8',
    )
    const nativeHelper = readFileSync(
      join(process.cwd(), 'src', 'server', 'agents-shell', 'native', 'landlock-exec.c'),
      'utf8',
    )
    const productionValues = readFileSync(
      join(process.cwd(), '..', '..', 'argocd', 'applications', 'agents', 'values.yaml'),
      'utf8',
    )
    expect(dockerfile).toContain('native/landlock-exec.c')
    expect(dockerfile).toContain('agents-shell-landlock --check')
    expect(dockerfile).toContain('AS patched-git-build')
    expect(dockerfile.match(/FROM controller AS agents-shell/g)).toHaveLength(1)
    expect(dockerfile).toContain('GIT_SHA256=233d7143a2d58e60755eee9b76f559ec73ea2b3c297f5b503162ace95966b4e3')
    expect(dockerfile).toContain('fcntl(fd, F_GETFD)')
    expect(dockerfile).toContain('COPY --from=patched-git-build')
    expect(dockerfile).toContain('test "$(command -v git)" = /usr/local/bin/git')
    expect(nixImage).toContain('pname = "agents-shell-landlock"')
    expect(nixImage).toContain('native/landlock-exec.c')
    expect(nixImage).toContain('$out/usr/local/bin/agents-shell-landlock')
    expect(nixImage).toContain('agentsShellLandlock')
    expect(nativeHelper).toContain('fchdir(cwd_fd)')
    expect(nativeHelper).toContain('--cwd-fd')
    expect(chartValues).toContain('AGENTS_SHELL_MAX_TOOL_SCHEMA_BYTES')
    expect(chartValues).toContain('runAsNonRoot: true')
    expect(chartValues).toContain('runAsUser: 1000')
    expect(chartValues).not.toContain('runAsUser: 0')
    for (const capability of ['CHOWN', 'DAC_OVERRIDE', 'KILL', 'SETGID', 'SETUID']) {
      expect(chartValues).not.toContain(`- ${capability}`)
      expect(deployService).toContain(`'${capability}'`)
    }
    expect(deployService).toContain('agentsShellLeaseIsolation: true')
    expect(chartValues).not.toContain('- FOWNER')
    expect(deployment).toContain('readOnly: true')
    expect(deployment).toContain('subPath: {{ $workspaceSeedSubPath | quote }}')
    expect(deployment).toContain('and $workspaceBootstrap.enabled $workspaceSeedReadOnly')
    const serverContainer = deployment.indexOf('        - name: agents-shell')
    const readOnlySeedMount = deployment.indexOf('              readOnly: true')
    expect(serverContainer).toBeGreaterThan(0)
    expect(readOnlySeedMount).toBeGreaterThan(serverContainer)
    expect(chartValues).toContain('seedReadOnly: false')
    expect(productionValues).toContain('seedReadOnly: false')
  })
})
