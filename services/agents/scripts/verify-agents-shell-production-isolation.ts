import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AgentsShellRunner } from '../src/server/agents-shell-mcp'
import {
  cleanupFixtures,
  closeFixtureConnection,
  connectFixture,
  findTestExecutable,
  makeAuth,
  makeFixture,
} from '../src/server/agents-shell-test-helpers'

type ToolCallResult = {
  isError?: boolean
  content?: unknown
  structuredContent?: unknown
}

const toolCallResult = (result: unknown): ToolCallResult => result as ToolCallResult

const requireToolSuccess = (result: unknown, label: string) => {
  const parsed = toolCallResult(result)
  assert.notEqual(parsed.isError, true, `${label} failed: ${JSON.stringify(parsed.content)}`)
  return parsed
}

const assertLeaseRuntimeMetadata = (runtimeRoot: string, uid: number, gid: number) => {
  for (const [relativePath, mode] of [
    ['home', 0o700],
    ['tmp', 0o700],
    ['cache', 0o700],
    ['config', 0o700],
    ['config/gitconfig', 0o600],
  ] as const) {
    const stat = statSync(join(runtimeRoot, relativePath))
    assert.equal(stat.uid, uid, `${relativePath} UID`)
    assert.equal(stat.gid, gid, `${relativePath} GID`)
    assert.equal(stat.mode & 0o777, mode, `${relativePath} mode`)
  }
}

const extractChartBootstrapScript = () => {
  const template = readFileSync('/app/charts/agents/templates/agents-shell-deployment.yaml', 'utf8')
  const marker = '          args:\n            - |\n'
  const start = template.indexOf(marker)
  assert.notEqual(start, -1, 'chart bootstrap script marker')
  const bodyStart = start + marker.length
  const end = template.indexOf('\n          volumeMounts:', bodyStart)
  assert.notEqual(end, -1, 'chart bootstrap script end')
  const lines = template.slice(bodyStart, end).split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length ?? 0))
  return lines.map((line) => line.slice(Math.min(indent, line.length))).join('\n')
}

const chownTree = (root: string, uid: number, gid: number) => {
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      lchownSync(path, uid, gid)
      return
    }
    chownSync(path, uid, gid)
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
}

const verifyLegacyBootstrapUpgrade = (fixture: ReturnType<typeof makeFixture>) => {
  const find = findTestExecutable('find')
  const runFind = (args: string[]) =>
    execFileSync(find, basename(find) === 'busybox' ? ['find', ...args] : args, { encoding: 'utf8' })
  const git = findTestExecutable('git')
  const checkout = join(fixture.workspaceRoot, 'legacy-bootstrap-checkout')
  const marker = join(fixture.root, 'legacy-fsmonitor-secret')
  const helper = join(fixture.root, 'legacy-fsmonitor.sh')
  const origin = execFileSync(git, ['-C', fixture.seedPath, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim()
  const controlRoot = '/workspace/.agents-shell'
  const controlMarker = join(controlRoot, 'legacy-control')
  const legacyLeaseState = join(controlRoot, 'leases.json')
  rmSync(controlRoot, { recursive: true, force: true })
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 })
  writeFileSync(controlMarker, 'legacy-control\n', { mode: 0o600 })
  writeFileSync(
    legacyLeaseState,
    `${JSON.stringify({ version: 1, nextUid: 200_000, leases: [{ workspacePath: '/etc' }] })}\n`,
    { mode: 0o600 },
  )
  chownTree(controlRoot, 1000, 1000)
  execFileSync(git, ['clone', '--quiet', '--no-hardlinks', '--branch', 'main', origin, checkout])
  writeFileSync(
    helper,
    `#!/bin/bash\nprintf '%s' "\${GIT_TOKEN:-missing}" > ${JSON.stringify(marker)}\nprintf '{}\\n'\n`,
    { mode: 0o755 },
  )
  execFileSync(git, ['-C', checkout, 'config', 'core.fsmonitor', helper])
  execFileSync(git, ['-C', checkout, 'diff', '--quiet'], {
    env: { ...process.env, GIT_TOKEN: 'legacy-bootstrap-secret' },
  })
  assert.equal(readFileSync(marker, 'utf8'), 'legacy-bootstrap-secret')
  rmSync(marker)
  chownTree(checkout, 1000, 1000)

  const bootstrap = (targetPath = checkout) =>
    spawnSync('/bin/bash', ['-ec', extractChartBootstrapScript()], {
      env: {
        ...process.env,
        GIT_REPOSITORY: origin,
        GIT_BRANCH: 'main',
        GIT_TARGET_PATH: targetPath,
        GIT_DEPTH: '0',
        GIT_TOKEN: 'must-not-reach-fsmonitor',
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })

  const preservedRoot = '/workspace/.agents-shell-preserved-checkouts'
  const gitOwnedHardLinkCheckout = join(fixture.root, 'git-owned-hard-link-checkout')
  execFileSync(git, ['clone', '--quiet', '--branch', 'main', origin, gitOwnedHardLinkCheckout])
  const gitOwnedHardLinks = runFind([
    join(gitOwnedHardLinkCheckout, '.git', 'objects'),
    '-type',
    'f',
    '-links',
    '+1',
    '-print',
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
  assert.ok(gitOwnedHardLinks.length > 0, 'local Git clone must reproduce Git-owned object hard links')
  for (const objectPath of gitOwnedHardLinks) {
    const objectStat = statSync(objectPath)
    const originPeers = runFind([join(origin, 'objects'), '-type', 'f', '-inum', String(objectStat.ino), '-print'])
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.ok(
      originPeers.length > 0,
      `Git-owned hard link must resolve into the local origin object store: ${objectPath}`,
    )
    assert.equal(statSync(originPeers[0]!).dev, objectStat.dev)
  }
  rmSync(gitOwnedHardLinkCheckout, { recursive: true, force: true })

  const seedLinkTarget = join(fixture.root, 'legacy-seed-link-target')
  const seedLinkCheckout = join(fixture.workspaceRoot, 'legacy-seed-link-checkout')
  execFileSync(git, ['clone', '--quiet', '--no-hardlinks', '--branch', 'main', origin, seedLinkTarget])
  symlinkSync(seedLinkTarget, seedLinkCheckout)
  const seedLinkUpgrade = bootstrap(seedLinkCheckout)
  assert.equal(seedLinkUpgrade.status, 0, seedLinkUpgrade.stderr || seedLinkUpgrade.stdout)
  assert.equal(lstatSync(seedLinkCheckout).isSymbolicLink(), false)
  assert.equal(statSync(join(seedLinkCheckout, '.git')).isDirectory(), true)
  assert.equal(
    runFind([join(seedLinkCheckout, '.git'), '-type', 'f', '-links', '+1', '-print']).trim(),
    '',
    'bootstrap-created Git metadata must not retain local-clone hard links',
  )
  const seedLinkRestart = bootstrap(seedLinkCheckout)
  assert.equal(seedLinkRestart.status, 0, seedLinkRestart.stderr || seedLinkRestart.stdout)
  assert.equal(
    runFind([controlRoot, '-type', 'l', '-print']).trim(),
    '',
    'seed-link upgrade must not poison the control tree',
  )

  const gitLinkCheckout = join(fixture.workspaceRoot, 'legacy-git-link-checkout')
  const gitLinkTarget = join(fixture.root, 'legacy-git-link-target')
  execFileSync(git, ['clone', '--quiet', '--no-hardlinks', '--branch', 'main', origin, gitLinkCheckout])
  renameSync(join(gitLinkCheckout, '.git'), gitLinkTarget)
  symlinkSync(gitLinkTarget, join(gitLinkCheckout, '.git'))
  writeFileSync(join(gitLinkCheckout, 'legacy-working-file.txt'), 'preserve regular legacy bytes\n')
  const gitLinkUpgrade = bootstrap(gitLinkCheckout)
  assert.equal(gitLinkUpgrade.status, 0, gitLinkUpgrade.stderr || gitLinkUpgrade.stdout)
  assert.equal(lstatSync(join(gitLinkCheckout, '.git')).isSymbolicLink(), false)
  assert.equal(statSync(join(gitLinkCheckout, '.git')).isDirectory(), true)
  assert.equal(
    readdirSync(preservedRoot).some((entry) => existsSync(join(preservedRoot, entry, 'legacy-working-file.txt'))),
    true,
    'regular bytes from the rejected .git checkout must be preserved outside the control tree',
  )
  const gitLinkRestart = bootstrap(gitLinkCheckout)
  assert.equal(gitLinkRestart.status, 0, gitLinkRestart.stderr || gitLinkRestart.stdout)
  assert.equal(
    runFind([controlRoot, '-type', 'l', '-print']).trim(),
    '',
    'git-link upgrade must not poison the control tree',
  )

  const protectedFetchTarget = join(fixture.root, 'protected-fetch-head-target')
  const fetchHead = join(checkout, '.git', 'FETCH_HEAD')
  writeFileSync(protectedFetchTarget, 'protected-fetch-head\n')
  rmSync(fetchHead, { force: true })
  symlinkSync(protectedFetchTarget, fetchHead)
  execFileSync(git, ['-c', `safe.directory=${checkout}`, '-C', checkout, 'fetch', 'origin', 'main'])
  assert.notEqual(readFileSync(protectedFetchTarget, 'utf8'), 'protected-fetch-head\n')
  writeFileSync(protectedFetchTarget, 'protected-fetch-head\n')
  rmSync(marker, { force: true })
  const symlinkBlocked = bootstrap()
  assert.notEqual(symlinkBlocked.status, 0)
  assert.match(symlinkBlocked.stderr, /git metadata must not contain nested symlinks/)
  assert.equal(readFileSync(protectedFetchTarget, 'utf8'), 'protected-fetch-head\n')
  assert.equal(existsSync(legacyLeaseState), false, 'untrusted UID-1000 lease state must be discarded')

  rmSync(fetchHead, { force: true })
  linkSync(protectedFetchTarget, fetchHead)
  const hardLinkBlocked = bootstrap()
  assert.notEqual(hardLinkBlocked.status, 0)
  assert.match(hardLinkBlocked.stderr, /git metadata must not contain hard-linked files/)
  assert.equal(readFileSync(protectedFetchTarget, 'utf8'), 'protected-fetch-head\n')
  rmSync(fetchHead, { force: true })

  const result = bootstrap()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(
    runFind([join(checkout, '.git'), '-type', 'f', '-links', '+1', '-print']).trim(),
    '',
    'successful legacy upgrade must leave independently owned Git metadata',
  )
  assert.equal(existsSync(marker), false, 'sanitized bootstrap must not execute legacy fsmonitor')
  assert.equal(statSync(controlRoot).uid, 0)
  assert.equal(statSync(controlMarker).uid, 0)
  assert.equal(statSync(controlRoot).mode & 0o777, 0o711)
  assert.equal(statSync(checkout).uid, 0)
  assert.equal(statSync(join(checkout, 'README.md')).uid, 0)
  assert.equal(
    execFileSync(git, ['-C', checkout, 'config', '--get', 'core.fsmonitor'], { encoding: 'utf8' }).trim(),
    'false',
  )
  assert.equal(
    execFileSync(git, ['-C', checkout, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(),
    '/dev/null',
  )
}

const main = async () => {
  assert.equal(process.geteuid?.(), 0, 'production isolation proof must start as root')
  const capEff = BigInt(`0x${/^CapEff:\s*([0-9a-f]+)$/im.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? '0'}`)
  assert.equal((capEff & (1n << 3n)) === 0n, true, 'production isolation proof must not have CAP_FOWNER')
  const landlock = process.env.AGENTS_SHELL_LANDLOCK_EXECUTABLE ?? '/usr/local/bin/agents-shell-landlock'
  assert.equal(existsSync(landlock), true, `packaged Landlock helper is missing: ${landlock}`)

  const fixture = makeFixture()
  chmodSync(fixture.root, 0o755)
  chmodSync(fixture.trustedBin, 0o755)
  fixture.config.sessionUidStart = 200_000
  fixture.config.sessionUidEnd = 200_001
  fixture.config.inspectionUid = 65_534
  fixture.config.inspectionGid = 65_534
  fixture.config.trustedExecutables.executables.landlock = landlock
  fixture.config.trustedExecutables.executables.rg = findTestExecutable('rg')

  const allocated = [200_000, 200_001]
  const runner = new AgentsShellRunner(fixture.config, { uidAllocator: () => allocated.shift()! })
  verifyLegacyBootstrapUpgrade(fixture)
  chmodSync(fixture.seedPath, 0o755)
  const seed = await connectFixture(fixture, { runner, sessionId: 'production-seed-reader' })
  const first = await connectFixture(fixture, { runner, sessionId: 'production-owner' })
  const second = await connectFixture(fixture, {
    runner,
    auth: makeAuth(undefined, 'different-subject'),
    sessionId: 'production-foreign',
  })

  try {
    const acquisition = await first.client.callTool({
      name: 'workspace_acquire',
      arguments: { task: 'production-isolation' },
    })
    requireToolSuccess(acquisition, 'production workspace acquisition')
    const firstLease = runner.leases.ownedLease(first.sessionId)
    assert.ok(firstLease)
    assert.equal(
      existsSync(join(firstLease.workspacePath, '.git')),
      true,
      'acquired workspace must be a Git repository',
    )

    const seedIdentity = await runner.runProcess({
      command: 'bash',
      args: ['--noprofile', '--norc', '-c', 'printf %s "$EUID"'],
      auth: seed.auth,
      auditEvent: 'production_seed_identity',
      sessionId: seed.sessionId,
    })
    assert.equal(seedIdentity.ok, true, seedIdentity.stderr)
    assert.equal(seedIdentity.stdout.trim(), '65534')
    const seedSearch = await seed.client.callTool({ name: 'search', arguments: { query: 'seed' } })
    requireToolSuccess(seedSearch, 'lease-free seed search')
    const seedGit = await seed.client.callTool({
      name: 'git',
      arguments: { args: ['ls-files', '--', 'README.md'] },
    })
    const seedGitResult = requireToolSuccess(seedGit, 'lease-free seed Git')
    assert.equal((seedGitResult.structuredContent as { stdout?: string }).stdout?.trim(), 'README.md')
    assert.ok(((seedGitResult.structuredContent as { stdoutBytes?: number }).stdoutBytes ?? 0) > 0)
    const serviceAccountTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token'
    const serviceAccountToken = readFileSync(serviceAccountTokenPath, 'utf8').trim()
    const tokenRead = await seed.client.callTool({
      name: 'read_file',
      arguments: { path: serviceAccountTokenPath },
    })
    assert.equal(tokenRead.isError, true, 'lease-free read_file must reject the projected service-account token')
    assert.equal(JSON.stringify(tokenRead).includes(serviceAccountToken), false)

    const identity = await runner.runProcess({
      command: 'bash',
      args: ['--noprofile', '--norc', '-c', 'printf %s "$EUID"'],
      auth: first.auth,
      auditEvent: 'production_lease_identity',
      sessionId: first.sessionId,
      mutation: true,
    })
    assert.equal(identity.ok, true, identity.stderr)
    assert.equal(identity.stdout.trim(), '200000')
    const runtimeRoot = join(fixture.config.sessionRuntimeRoot, firstLease.leaseId)
    assertLeaseRuntimeMetadata(runtimeRoot, firstLease.uid, firstLease.gid)

    const mutation = await first.client.callTool({
      name: 'shell_run',
      arguments: {
        command: 'printf production-owner >> README.md; printf production-owner > production-owner.txt',
      },
    })
    const mutationResult = requireToolSuccess(mutation, 'owned mutation')
    assert.equal((mutationResult.structuredContent as { ok?: boolean }).ok, true, JSON.stringify(mutationResult))
    assert.equal(readFileSync(join(firstLease.workspacePath, 'production-owner.txt'), 'utf8'), 'production-owner')
    assertLeaseRuntimeMetadata(runtimeRoot, firstLease.uid, firstLease.gid)

    const search = await first.client.callTool({
      name: 'search',
      arguments: { query: 'production-owner' },
    })
    const searchResult = requireToolSuccess(search, 'owned search')
    assert.match((searchResult.structuredContent as { stdout?: string }).stdout ?? '', /README\.md/)

    const status = await first.client.callTool({
      name: 'git',
      arguments: { args: ['status', '--short'], cwd: firstLease.workspacePath },
    })
    const statusResult = requireToolSuccess(status, 'owned read-only Git')
    const statusOutput = (statusResult.structuredContent as { stdout?: string; stdoutBytes?: number }).stdout ?? ''
    assert.ok(
      ((statusResult.structuredContent as { stdoutBytes?: number }).stdoutBytes ?? 0) > 0,
      JSON.stringify(statusResult),
    )
    assert.match(statusOutput, /production-owner\.txt/, JSON.stringify(statusResult))
    const diff = await first.client.callTool({
      name: 'git',
      arguments: { args: ['diff', '--name-only'], cwd: firstLease.workspacePath },
    })
    const diffResult = requireToolSuccess(diff, 'owned read-only Git diff')
    assert.match(
      (diffResult.structuredContent as { stdout?: string }).stdout ?? '',
      /README\.md/,
      JSON.stringify(diffResult),
    )
    assert.deepEqual(readdirSync(join(dirname(fixture.config.leaseStatePath), 'git-inspections')), [])
    assert.match(readFileSync(fixture.auditLogPath, 'utf8'), /"event":"git_index_refresh_finished"/)

    assert.equal(firstLease.uid, 200_000)
    assert.equal(firstLease.gid, 200_000)

    const foreignSearch = await second.client.callTool({
      name: 'search',
      arguments: { query: 'production-owner', path: firstLease.workspacePath },
    })
    const foreignSearchResult = toolCallResult(foreignSearch)
    assert.equal(foreignSearchResult.isError, true)
    assert.match(JSON.stringify(foreignSearchResult.content), /current session workspace/)

    const foreignGit = await second.client.callTool({
      name: 'git',
      arguments: { args: ['status', '--short'], cwd: firstLease.workspacePath },
    })
    const foreignGitResult = toolCallResult(foreignGit)
    assert.equal(foreignGitResult.isError, true)
    assert.match(JSON.stringify(foreignGitResult.content), /current session workspace/)

    console.log(
      JSON.stringify({
        ok: true,
        leaseUid: firstLease.uid,
        leaseGid: firstLease.gid,
        inspectionUid: fixture.config.inspectionUid,
        seedInspectionUid: 65_534,
        seedSearch: true,
        seedGit: true,
        capFownerAbsent: true,
        repeatedRuntimePreparation: true,
        legacyControlTreeMigrated: true,
        scratchIndexCleaned: true,
        legacyBootstrapUpgrade: true,
        ownedMutation: true,
        ownedSearch: true,
        ownedGit: true,
        ownedGitDiff: true,
        foreignSearchRejected: true,
        foreignGitRejected: true,
        landlock,
      }),
    )
  } finally {
    await closeFixtureConnection(second)
    await closeFixtureConnection(first)
    await closeFixtureConnection(seed)
    runner.shutdown()
    cleanupFixtures()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
