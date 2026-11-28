import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { assessReleaseChecks, parseReleaseArgs, selectReleaseVersion } from '../../scripts/release'

const head = 'a'.repeat(40)
const merged = 'b'.repeat(40)
const base = 'd'.repeat(40)
const passingChecks = () => ({
  headRefOid: head,
  baseRefOid: base,
  state: 'OPEN',
  reviewDecision: '',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', workflowName: 'Temporal Bun SDK CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
  reviews: [{ author: { login: 'chatgpt-codex-connector' }, state: 'COMMENTED', commit: { oid: head } }],
  comments: [],
})

describe('release command decisions', () => {
  test('selects requested bumps from main and accepts automatic or exact releases', () => {
    for (const [input, version] of [['patch', '0.11.4'], ['minor', '0.12.0'], ['major', '1.0.0'], ['0.15.0', '0.15.0']]) {
      expect(selectReleaseVersion(parseReleaseArgs([input!]).version, '0.11.3')).toBe(version)
    }
    expect(selectReleaseVersion(parseReleaseArgs([]).version, '0.11.3')).toBeUndefined()
    expect(parseReleaseArgs(['patch', '--dry-run']).mode).toBe('preview')
    expect(parseReleaseArgs(['--prepare-only']).mode).toBe('prepare')
  })

  test('rejects rollback, malformed versions, ambiguous modes, and extra arguments', () => {
    for (const args of [['0.11.3'], ['0.10.0']]) {
      expect(() => selectReleaseVersion(parseReleaseArgs(args).version, '0.11.3')).toThrow('must be newer')
    }
    for (const args of [['patch', 'minor'], ['--dry-run', '--prepare-only'], ['01.2.3'], ['1.2.3-beta.1'], ['--force']]) {
      expect(() => parseReleaseArgs(args)).toThrow()
    }
  })

  test('requires SDK validation and completed review of the selected commit', () => {
    expect(assessReleaseChecks(passingChecks(), head, base)).toEqual([])
    expect(assessReleaseChecks({ ...passingChecks(), statusCheckRollup: [] }, head, base)).toContain('SDK validation')
    expect(assessReleaseChecks({ ...passingChecks(), reviews: [] }, head, base)).toContain('release review')
    const stale = passingChecks()
    stale.reviews[0]!.commit.oid = 'c'.repeat(40)
    expect(assessReleaseChecks(stale, head, base)).toContain('release review')
  })

  test('waits for pending checks and refuses failures or a changed PR', () => {
    const pending = passingChecks()
    pending.statusCheckRollup[0]!.status = 'IN_PROGRESS'
    expect(assessReleaseChecks(pending, head, base)).toContain('test')
    const failed = passingChecks()
    failed.statusCheckRollup[0]!.conclusion = 'FAILURE'
    expect(() => assessReleaseChecks(failed, head, base)).toThrow('Release check failed')
    expect(() => assessReleaseChecks(passingChecks(), 'c'.repeat(40), base)).toThrow('changed while waiting')
    expect(() => assessReleaseChecks({ ...passingChecks(), reviewDecision: 'CHANGES_REQUESTED' }, head, base)).toThrow('requested changes')
  })

  test('recognizes the current Codex completion receipt only from the bot', () => {
    const receipt = {
      ...passingChecks(), reviews: [],
      comments: [{ author: { login: 'chatgpt-codex-connector' }, body: `<!-- codex-pull-request-review-summary -->\n| Code Review | ✅ **Completed** | \`${head.slice(0, 7)}\` |` }],
    }
    expect(assessReleaseChecks(receipt, head, base)).toEqual([])
    receipt.comments[0]!.author.login = 'another-user'
    expect(assessReleaseChecks(receipt, head, base)).toContain('release review')
  })
})

const directories: string[] = []
const stopProcesses: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(stopProcesses.splice(0).map((stop) => stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const exerciseCommand = async (scenario: string, args = ['patch']) => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-release-command-'))
  directories.push(directory)
  const bin = join(directory, 'bin')
  const dist = join(directory, 'package', 'dist')
  await mkdir(bin)
  await mkdir(dist, { recursive: true })
  const packageJson = { name: '@proompteng/temporal-bun-sdk', version: ['rejected-merge', 'missing-base'].includes(scenario) ? '0.11.5' : '0.11.4' }
  const production = { package: packageJson, defaultChoice: { recommended: true, blockers: [] }, gates: { releaseProvenanceEvidence: { passed: true } } }
  const provenance = {
    package: packageJson, passed: true, git: { githubSha: scenario === 'wrong-artifact' ? 'c'.repeat(40) : merged },
    releaseProvenanceManifest: 'dist/release-provenance.json',
    readinessArtifacts: ['production-readiness', 'agent-readiness'].map((name) => ({ path: `dist/${name}.json`, present: true, sha256: 'fixture', sizeBytes: 1 })),
  }
  await writeFile(join(dist, 'production-readiness.json'), JSON.stringify(production))
  await writeFile(join(dist, 'agent-readiness.json'), JSON.stringify({ recommended: true }))
  await writeFile(join(dist, 'release-provenance.json'), JSON.stringify(provenance))
  const files = await Promise.all(['production-readiness', 'agent-readiness', 'release-provenance'].map(async (name) => ({ path: `dist/${name}.json`, size: (await readFile(join(dist, `${name}.json`))).byteLength })))
  const archive = join(directory, 'sdk.tgz')
  const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', directory, 'package'])
  expect(tar.exitCode).toBe(0)
  const statePath = join(directory, 'state.json')
  const logPath = join(directory, 'calls.jsonl')
  await writeFile(statePath, JSON.stringify({
    scenario, phase: ['resume', 'verify-tagged', 'verify-with-newer-open', 'rejected-merge', 'missing-base'].includes(scenario) ? 'merged' : 'initial', tagged: ['verify-tagged', 'verify-with-newer-open'].includes(scenario), head, merged, checks: passingChecks(), archive,
    pack: { ...packageJson, id: `${packageJson.name}@${packageJson.version}`, filename: 'sdk.tgz', integrity: 'sha512-fixture', shasum: 'fixture', files },
  }))
  if (['rejected-merge', 'missing-base'].includes(scenario)) await writeFile(statePath + '.release', JSON.stringify({ number: 12, version: '0.11.4', request: 'patch' }))
  const stub = `#!${process.execPath}
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const args = process.argv.slice(2)
const command = basename(process.argv[1])
const statePath = process.env.RELEASE_COMMAND_TEST_STATE
const state = JSON.parse(readFileSync(statePath, 'utf8'))
appendFileSync(process.env.RELEASE_COMMAND_TEST_LOG, JSON.stringify([command, ...args]) + '\\n')
const save = () => writeFileSync(statePath, JSON.stringify(state))
const print = (value) => console.log(JSON.stringify(value))
const pr = () => ({ number: state.replaced ? 13 : 12, url: 'https://github.com/proompteng/lab/pull/12', state: state.phase === 'merged' ? 'MERGED' : 'OPEN', headRefName: 'release-please--branches--main--components--temporal-bun-sdk', baseRefName: 'main', baseRefOid: (['late-base', 'concurrent-new-base'].includes(state.scenario) && state.checked ? 'e' : 'd').repeat(40), headRefOid: state.head, isCrossRepository: state.scenario === 'fork', headRepositoryOwner: { login: state.scenario === 'fork' ? 'another-owner' : 'proompteng' }, mergeCommit: state.phase === 'merged' ? { oid: state.merged } : null, labels: [{ name: state.tagged ? 'autorelease: tagged' : 'autorelease: pending' }] })
if (command === 'bunx') {
  if (['rejected-merge', 'missing-base'].includes(state.scenario) && !state.pendingRemoved && !args.includes('--dry-run')) { console.log('There are untagged, merged release PRs outstanding - aborting'); process.exit(0) }
  if (!args.includes('--dry-run')) { state.phase = 'prepared'; if (['rejected-merge', 'missing-base'].includes(state.scenario)) { state.replaced = true; state.head = 'f'.repeat(40); state.checks.headRefOid = state.head; state.checks.reviews[0].commit.oid = state.head }; save() }
  console.log('Release Please preview/preparation completed')
} else if (command === 'git') {
  console.log(statePath + '.release')
} else if (command === 'npm') {
  if (state.scenario === 'resume-tagged' && !state.tagged) { state.tagged = true; save(); process.exit(1) }
  copyFileSync(state.archive, join(process.cwd(), 'sdk.tgz')); print([state.pack])
} else if (args[0] === 'auth') {
  console.log('fixture-token-kept-off-argv')
} else if (args[0] === 'pr' && args[1] === 'list') {
  const candidates = state.scenario === 'fork-collision' ? [{ ...pr(), number: 99, isCrossRepository: true, headRepositoryOwner: { login: 'another-owner' } }, pr()] : [pr()]
  if (state.scenario === 'verify-with-newer-open') candidates.unshift({ ...pr(), number: 99, state: 'OPEN', headRefOid: 'f'.repeat(40), mergeCommit: null })
  print(state.phase === 'initial' ? [] : candidates)
} else if (args[0] === 'api' && args[1].includes('/contents/')) {
  const ref = args[1].split('?ref=')[1]
  const version = ref === 'main' ? (['verify-with-newer-open', 'rejected-merge', 'missing-base'].includes(state.scenario) ? '0.11.4' : '0.11.3') : ref === 'd'.repeat(40) ? (state.scenario === 'base-version-ahead' ? '0.11.5' : '0.11.3') : ref === 'f'.repeat(40) ? '0.11.5' : '0.11.4'
  console.log(Buffer.from(JSON.stringify({ version })).toString('base64'))
} else if (args[0] === 'pr' && args[1] === 'view') {
  if (state.scenario === 'interrupt-after-merge' && state.phase === 'merged' && !state.interrupted) { state.interrupted = true; save(); process.exit(1) }
  if (args.at(-1).includes('statusCheckRollup')) {
    if (state.scenario === 'interrupt-during-checks' && !state.interrupted) { state.interrupted = true; save(); process.exit(1) }
    state.checked = true; save()
    if (state.scenario === 'failed-check') state.checks.statusCheckRollup[0].conclusion = 'FAILURE'
    if (state.scenario === 'base-moved') state.checks.baseRefOid = 'e'.repeat(40)
    if (state.scenario.startsWith('concurrent-')) { state.phase = 'merged'; state.checks.state = 'MERGED'; state.checks.baseRefOid = pr().baseRefOid; save() }
    print(state.checks)
  } else print(pr())
} else if (args[0] === 'api' && args[1] === 'graphql') {
  print({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: state.scenario === 'unresolved-review' ? [{ isResolved: false }] : [] } } } } })
} else if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label') && args.includes('autorelease: pending')) {
  state.pendingRemoved = true; save()
} else if (args[0] === 'pr' && args[1] === 'merge') {
  state.mergeBody = await new Response(Bun.stdin.stream()).text(); save()
  if (state.scenario === 'interrupt-after-merge') { state.phase = 'merged'; state.tagged = true; save(); process.exit(1) }
  state.phase = 'merged'; save()
} else if (args[0] === 'run' && args[1] === 'list') {
  print([{ databaseId: 34, status: 'completed', conclusion: state.scenario === 'resume' ? 'failure' : 'success', url: 'https://github.com/proompteng/lab/actions/runs/34' }])
} else if (args[0] === 'run' && args[1] === 'watch') {
  if (state.scenario === 'failed-publication') process.exit(1)
} else if (args[0] === 'run' && args[1] === 'rerun') {
  state.retried = true; save()
} else if (args[0] === 'api' && args[1].includes('/git/commits/')) {
  print({ message: ['missing-base', 'verify-tagged', 'verify-with-newer-open'].includes(state.scenario) ? 'Legacy or manual release' : 'Release SDK\\n\\nTemporal-Bun-Release-Base: ' + 'd'.repeat(40), parents: [{ sha: (state.scenario === 'rejected-merge' && !state.replaced ? 'e' : 'd').repeat(40) }] })
} else if (args[0] === 'api' && args[1].includes('/commits/')) {
  console.log(state.merged)
} else {
  console.error('Unexpected fixture command', args); process.exit(2)
}
`
  for (const command of ['gh', 'bunx', 'npm', 'git']) {
    await writeFile(join(bin, command), stub)
    await chmod(join(bin, command), 0o755)
  }
  const execute = async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../scripts/release.ts'), ...args], {
    env: { ...process.env, GITHUB_OUTPUT: undefined, PATH: `${bin}:${process.env.PATH}`, RELEASE_COMMAND_TEST_STATE: statePath, RELEASE_COMMAND_TEST_LOG: logPath },
    stdout: 'pipe', stderr: 'pipe',
  })
  stopProcesses.push(async () => { if (child.exitCode === null) child.kill(); await child.exited })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr, receiptExists: await Bun.file(statePath + '.release').exists() }
  }
  const first = await execute()
  const result = ['resume-tagged', 'interrupt-after-merge', 'interrupt-during-checks'].includes(scenario) ? await execute() : first
  return { ...result, first, calls: (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)), state: JSON.parse(await readFile(statePath, 'utf8')) }
}

describe('release command through CLI boundaries', () => {
  test('publishes after checks and review, then downloads and verifies the release', async () => {
    const result = await exerciseCommand('success')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Published and verified @proompteng/temporal-bun-sdk@0.11.4')
    expect(result.stdout).toContain('bun add @proompteng/temporal-bun-sdk@0.11.4')
    expect(result.receiptExists).toBe(false)
    expect(result.calls.find((args) => args[0] === 'bunx')).toContain('--release-as=0.11.4')
    expect(result.calls.find((args) => args[1] === 'pr' && args[2] === 'merge')).toContain(head)
    expect(result.state.mergeBody).toContain('Temporal-Bun-Release-Base: ' + base)
    expect(JSON.stringify(result.calls) + result.stdout + result.stderr).not.toContain('fixture-token-kept-off-argv')
  })

  test('dry run cannot merge, watch a publication, or query npm', async () => {
    const result = await exerciseCommand('success', ['patch', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.state.phase).toBe('initial')
    expect(result.calls.some((args) => args.includes('merge') || args.includes('watch') || args[0] === 'npm')).toBe(false)
  })

  test('prepare-only stops with the release PR open', async () => {
    const result = await exerciseCommand('success', ['patch', '--prepare-only'])
    expect(result.code).toBe(0)
    expect(result.state.phase).toBe('prepared')
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test('refuses a same-named release branch from a fork', async () => {
    const result = await exerciseCommand('fork')
    expect(result.code).toBe(1)
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test('selects the repository-owned release PR when a newer fork uses its branch name', async () => {
    const result = await exerciseCommand('fork-collision')
    expect(result.code).toBe(0)
    const merge = result.calls.find((args) => args[1] === 'pr' && args[2] === 'merge')
    expect(merge?.[3]).toBe('12')
  })

  test.each(['failed-check', 'unresolved-review'])('refuses to merge when %s', async (scenario) => {
    const result = await exerciseCommand(scenario)
    expect(result.code).toBe(1)
    expect(result.state.phase).toBe('prepared')
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test('resumes a merged release and retries its failed jobs without creating another PR', async () => {
    const result = await exerciseCommand('resume')
    expect(result.code).toBe(0)
    expect(result.state.retried).toBe(true)
    expect(result.calls.some((args) => args[0] === 'bunx' || args.includes('merge'))).toBe(false)
  })

  test.each(['base-moved', 'late-base'])('does not merge after main changes at %s', async (scenario) => {
    const result = await exerciseCommand(scenario)
    expect(result.code).toBe(1)
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test('the same command resumes verification after the workflow removes the pending label', async () => {
    const result = await exerciseCommand('resume-tagged')
    expect(result.first.code).toBe(1)
    expect(result.first.receiptExists).toBe(true)
    expect(result.code).toBe(0)
    expect(result.receiptExists).toBe(false)
    expect(result.calls.filter((args) => args[0] === 'bunx')).toHaveLength(1)
    expect(result.calls.filter((args) => args[1] === 'pr' && args[2] === 'merge')).toHaveLength(1)
    expect(result.stdout).toContain('Published and verified')
  })

  test('resumes the same version when the connection drops immediately after GitHub merges', async () => {
    const result = await exerciseCommand('interrupt-after-merge')
    expect(result.first.code).toBe(1)
    expect(result.first.receiptExists).toBe(true)
    expect(result.code).toBe(0)
    expect(result.calls.filter((args) => args[0] === 'bunx')).toHaveLength(1)
    expect(result.calls.filter((args) => args[1] === 'pr' && args[2] === 'merge')).toHaveLength(1)
    expect(result.receiptExists).toBe(false)
  })

  test('resumes the saved open PR and version after a connection failure during checks', async () => {
    const result = await exerciseCommand('interrupt-during-checks')
    expect(result.first.code).toBe(1)
    expect(result.first.receiptExists).toBe(true)
    expect(result.code).toBe(0)
    const preparations = result.calls.filter((args) => args[0] === 'bunx')
    expect(preparations).toHaveLength(2)
    for (const preparation of preparations) expect(preparation).toContain('--release-as=0.11.4')
    expect(result.calls.filter((args) => args[1] === 'pr' && args[2] === 'merge')).toHaveLength(1)
    expect(result.receiptExists).toBe(false)
  })

  test.each(['patch', '0.11.5', 'automatic'])('replaces a permanently rejected merge when releasing %s', async (version) => {
    const result = await exerciseCommand('rejected-merge', version === 'automatic' ? [] : [version])
    expect(result.code).toBe(0)
    expect(result.calls.find((args) => args[0] === 'bunx')).toContain('--release-as=0.11.5')
    expect(result.calls.find((args) => args[1] === 'pr' && args[2] === 'merge')?.[3]).toBe('13')
    expect(result.calls.some((args) => args.includes('rerun'))).toBe(false)
    expect(result.state.pendingRemoved).toBe(true)
    expect(result.stdout).toContain('Published and verified @proompteng/temporal-bun-sdk@0.11.5')
    expect(result.receiptExists).toBe(false)
  })

  test('previewing a replacement retains the saved receipt and pending label', async () => {
    const result = await exerciseCommand('rejected-merge', ['patch', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.state.pendingRemoved).toBeUndefined()
    expect(result.receiptExists).toBe(true)
    expect(result.calls.find((args) => args[0] === 'bunx')).toContain('--release-as=0.11.5')
  })

  test('replaces an untagged manual merge that omitted the base record', async () => {
    const result = await exerciseCommand('missing-base')
    expect(result.code).toBe(0)
    expect(result.calls.find((args) => args[0] === 'bunx')).toContain('--release-as=0.11.5')
    expect(result.calls.some((args) => args.includes('rerun'))).toBe(false)
    expect(result.receiptExists).toBe(false)
  })

  test('verifies an exact tagged version from another checkout without opening a new release', async () => {
    const result = await exerciseCommand('verify-tagged', ['0.11.4'])
    expect(result.code).toBe(0)
    expect(result.calls.some((args) => args[0] === 'bunx' || args.includes('merge'))).toBe(false)
    expect(result.receiptExists).toBe(false)
  })

  test('finds the completed exact version when a newer version PR is open', async () => {
    const result = await exerciseCommand('verify-with-newer-open', ['0.11.4'])
    expect(result.code).toBe(0)
    expect(result.calls.some((args) => args[0] === 'bunx' || args.includes('merge'))).toBe(false)
  })

  test('rejects a concurrent merge that used a different base', async () => {
    const result = await exerciseCommand('concurrent-new-base')
    expect(result.code).toBe(1)
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test('accepts a concurrent merge of the selected head and base', async () => {
    const result = await exerciseCommand('concurrent-same-base')
    expect(result.code).toBe(0)
    expect(result.calls.some((args) => args.includes('merge'))).toBe(false)
  })

  test('rejects a version superseded on main while Release Please was preparing the PR', async () => {
    const result = await exerciseCommand('base-version-ahead')
    expect(result.code).toBe(1)
    expect(result.calls.some((args) => args.includes('merge') || args[0] === 'npm')).toBe(false)
  })

  test.each(['failed-publication', 'wrong-artifact'])('does not claim a release for %s', async (scenario) => {
    const result = await exerciseCommand(scenario)
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('Published and verified')
    expect(result.receiptExists).toBe(true)
  })
})
