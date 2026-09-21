#!/usr/bin/env bun
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Schema } from 'effect'

import { matchesRecordedReleaseBase } from './release-plan'
import { verifyPublishedPack } from './verify-packed-readiness'

const repository = 'proompteng/lab'
const packageName = '@proompteng/temporal-bun-sdk'
const packagePath = 'packages/temporal-bun-sdk/package.json'
const releaseBranch = 'release-please--branches--main--components--temporal-bun-sdk'
const workflow = 'temporal-bun-sdk.yml'
const root = resolve(import.meta.dir, '../../..')
const usage = `Usage: bun run release:temporal [patch|minor|major|X.Y.Z] [--dry-run|--prepare-only]

Publish from main using your existing GitHub CLI login. With no version argument,
Conventional Commits select the next version. Waits for CI and review, merges the
version PR, follows publication, and verifies the package downloaded from npm.

  --dry-run       Preview the version PR without changing GitHub or npm.
  --prepare-only  Open or update the version PR and stop before merging.

Run the same command again to resume an unfinished release. Failed publication
jobs are retried when resuming a merged release PR. No local npm token is needed.`

type VersionRequest =
  | { kind: 'automatic' }
  | { kind: 'bump'; level: 'patch' | 'minor' | 'major' }
  | { kind: 'exact'; version: string }

export const parseReleaseArgs = (args: readonly string[]) => {
  let version: VersionRequest = { kind: 'automatic' }
  let mode: 'publish' | 'preview' | 'prepare' = 'publish'
  for (const arg of args) {
    if (arg === '--dry-run' || arg === '--prepare-only') {
      if (mode !== 'publish') throw new Error('Choose only one of --dry-run and --prepare-only')
      mode = arg === '--dry-run' ? 'preview' : 'prepare'
    } else if (version.kind === 'automatic' && (arg === 'patch' || arg === 'minor' || arg === 'major')) {
      version = { kind: 'bump', level: arg }
    } else if (version.kind === 'automatic' && isStableVersion(arg)) {
      version = { kind: 'exact', version: arg }
    } else {
      throw new Error(usage)
    }
  }
  return { version, mode }
}

const isStableVersion = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)

export const selectReleaseVersion = (request: VersionRequest, current: string): string | undefined => {
  if (!isStableVersion(current)) throw new Error(`The current main version is not stable: ${current}`)
  if (request.kind === 'automatic') return undefined
  const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number)
  const next =
    request.kind === 'exact'
      ? request.version
      : { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[
          request.level
        ]
  if (Bun.semver.order(next, current) !== 1) throw new Error(`Release version ${next} must be newer than ${current}`)
  return next
}

const pullRequestSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.Literal('OPEN', 'MERGED', 'CLOSED'),
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  baseRefOid: Schema.String,
  isCrossRepository: Schema.Boolean,
  headRepositoryOwner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
})
const prFields =
  'number,url,state,headRefOid,headRefName,baseRefName,baseRefOid,isCrossRepository,headRepositoryOwner,mergeCommit,labels'
const isRepositoryRelease = (pr: typeof pullRequestSchema.Type) =>
  !pr.isCrossRepository && pr.headRepositoryOwner?.login === 'proompteng' && pr.headRefName === releaseBranch
const authorSchema = Schema.NullOr(Schema.Struct({ login: Schema.String }))
const checksSchema = Schema.Struct({
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  state: Schema.Literal('OPEN', 'MERGED', 'CLOSED'),
  reviewDecision: Schema.String,
  statusCheckRollup: Schema.Array(
    Schema.Union(
      Schema.Struct({
        __typename: Schema.Literal('CheckRun'),
        name: Schema.String,
        status: Schema.String,
        conclusion: Schema.String,
        workflowName: Schema.String,
      }),
      Schema.Struct({ __typename: Schema.Literal('StatusContext'), context: Schema.String, state: Schema.String }),
    ),
  ),
  reviews: Schema.Array(
    Schema.Struct({ author: authorSchema, state: Schema.String, commit: Schema.Struct({ oid: Schema.String }) }),
  ),
  comments: Schema.Array(Schema.Struct({ author: authorSchema, body: Schema.String })),
})

export const assessReleaseChecks = (input: unknown, head: string, base: string) => {
  const pr = Schema.decodeUnknownSync(checksSchema)(input)
  if (pr.headRefOid !== head)
    throw new Error('The release PR changed while waiting. Run the command again to recheck it.')
  if (pr.baseRefOid !== base)
    throw new Error('main changed while waiting. Run the command again to regenerate and recheck the release PR.')
  if (pr.state === 'CLOSED') throw new Error('The release PR was closed without merging')
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    throw new Error('The release PR has requested changes. Resolve its review first.')
  const pending: string[] = []
  let sdkPassed = false
  for (const check of pr.statusCheckRollup) {
    if (check.__typename === 'StatusContext') {
      if (check.state === 'PENDING' || check.state === 'EXPECTED') pending.push(check.context)
      else if (check.state !== 'SUCCESS') throw new Error(`Release check failed: ${check.context} (${check.state})`)
    } else if (check.status !== 'COMPLETED') {
      pending.push(check.name)
    } else if (!['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion)) {
      throw new Error(`Release check failed: ${check.name} (${check.conclusion})`)
    } else if (
      check.workflowName === 'Temporal Bun SDK CI' &&
      check.name === 'test' &&
      check.conclusion === 'SUCCESS'
    ) {
      sdkPassed = true
    }
  }
  if (!sdkPassed) pending.push('SDK validation')
  const reviewed =
    pr.reviews.some(
      (review) =>
        review.commit.oid === head &&
        (review.state === 'APPROVED' ||
          (review.author?.login === 'chatgpt-codex-connector' && review.state === 'COMMENTED')),
    ) ||
    pr.comments.some(
      (comment) =>
        comment.author?.login === 'chatgpt-codex-connector' &&
        comment.body.includes('<!-- codex-pull-request-review-summary -->') &&
        comment.body
          .split('\n')
          .some(
            (line) =>
              line.includes('Code Review') &&
              line.includes('✅ **Completed**') &&
              line.includes(`\`${head.slice(0, 7)}\``),
          ),
    )
  if (!reviewed || pr.reviewDecision === 'REVIEW_REQUIRED') pending.push('release review')
  return pending
}

const run = async (args: string[], stdin?: Blob, inherit = false) => {
  const child = Bun.spawn(args, {
    cwd: root,
    stdin: stdin ?? 'ignore',
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : '',
    child.stderr ? new Response(child.stderr).text() : '',
  ])
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ''} failed (${code}). ${stderr.trim()}`)
  return stdout.trim()
}

const ghJson = async <A>(schema: Schema.Schema<A>, args: string[]): Promise<A> =>
  Schema.decodeUnknownSync(schema)(JSON.parse(await run(['gh', ...args])))

const readVersion = async (ref: string) => {
  const encoded = await run(['gh', 'api', `repos/${repository}/contents/${packagePath}?ref=${ref}`, '--jq', '.content'])
  return Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    JSON.parse(Buffer.from(encoded, 'base64').toString()),
  ).version
}

const latestReleasePr = async (version?: string) => {
  const candidates = (
    await ghJson(Schema.Array(pullRequestSchema), [
      'pr',
      'list',
      '-R',
      repository,
      '--head',
      releaseBranch,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      prFields,
    ])
  ).filter(isRepositoryRelease)
  if (version) {
    for (const candidate of candidates) {
      if (candidate.state === 'MERGED' && (await readVersion(candidate.headRefOid)) === version) return candidate
    }
    return undefined
  }
  return candidates[0]
}

const readPr = (number: number) =>
  ghJson(pullRequestSchema, ['pr', 'view', String(number), '-R', repository, '--json', prFields])

const receiptSchema = Schema.Struct({ number: Schema.Number, version: Schema.String, request: Schema.String })
const readReceipt = async (path: string) => {
  try {
    return Schema.decodeUnknownSync(receiptSchema)(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

const saveReceipt = async (path: string, receipt: typeof receiptSchema.Type) => {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const ensureResolvedReviews = async (number: number) => {
  const query = `query { repository(owner:"proompteng", name:"lab") { pullRequest(number:${number}) { reviewThreads(first:100) { pageInfo { hasNextPage } nodes { isResolved } } } } }`
  const result = await ghJson(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            reviewThreads: Schema.Struct({
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
              nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
            }),
          }),
        }),
      }),
    }),
    ['api', 'graphql', '-f', `query=${query}`],
  )
  const threads = result.data.repository.pullRequest.reviewThreads
  if (threads.pageInfo.hasNextPage || threads.nodes.some((thread) => !thread.isResolved)) {
    throw new Error('The release PR has unresolved review threads. Resolve them and run this command again.')
  }
}

const wait = async (description: string, deadline: number) => {
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}. Run the same command to resume.`)
  console.log(`Waiting for ${description}...`)
  await Bun.sleep(30_000)
}

const waitForPublication = async (sha: string, resume: boolean, deadline: number) => {
  const runSchema = Schema.Struct({
    databaseId: Schema.Number,
    status: Schema.String,
    conclusion: Schema.String,
    url: Schema.String,
  })
  let releaseRun
  while (!releaseRun) {
    releaseRun = (
      await ghJson(Schema.Array(runSchema), [
        'run',
        'list',
        '-R',
        repository,
        '--workflow',
        workflow,
        '--commit',
        sha,
        '--event',
        'push',
        '--limit',
        '1',
        '--json',
        'databaseId,status,conclusion,url',
      ])
    )[0]
    if (!releaseRun) await wait('the publication workflow to start', deadline)
  }
  console.log(`Publication: ${releaseRun.url}`)
  if (resume && releaseRun.status === 'completed' && releaseRun.conclusion !== 'success') {
    console.log('Retrying the failed publication jobs.')
    await run(['gh', 'run', 'rerun', String(releaseRun.databaseId), '-R', repository, '--failed'])
  }
  await run(
    ['gh', 'run', 'watch', String(releaseRun.databaseId), '-R', repository, '--exit-status', '--interval', '30'],
    undefined,
    true,
  )
  return releaseRun.url
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(usage)
    return
  }
  const request = parseReleaseArgs(args)
  const token = await run(['gh', 'auth', 'token', '--hostname', 'github.com'])
  if (!token) throw new Error('Run gh auth login before releasing.')
  const requestKey =
    request.version.kind === 'bump'
      ? request.version.level
      : request.version.kind === 'exact'
        ? request.version.version
        : 'automatic'
  const receiptPath = resolve(root, await run(['git', 'rev-parse', '--git-path', 'temporal-bun-sdk-release.json']))
  let receipt = await readReceipt(receiptPath)
  const currentVersion = await readVersion('main')
  const completedVersion =
    request.version.kind === 'exact' && Bun.semver.order(request.version.version, currentVersion) <= 0
      ? request.version.version
      : undefined
  let previous = receipt ? await readPr(receipt.number) : await latestReleasePr(completedVersion)
  let rejectedRelease: typeof pullRequestSchema.Type | undefined
  if (
    previous?.state === 'MERGED' &&
    previous.mergeCommit &&
    isRepositoryRelease(previous) &&
    previous.baseRefName === 'main'
  ) {
    const commit = await ghJson(
      Schema.Struct({ message: Schema.String, parents: Schema.Array(Schema.Struct({ sha: Schema.String })) }),
      ['api', `repos/${repository}/git/commits/${previous.mergeCommit.oid}`],
    )
    if (
      !matchesRecordedReleaseBase(
        commit.message,
        commit.parents.map((parent) => parent.sha),
        !previous.labels.some((label) => label.name === 'autorelease: tagged'),
      )
    ) {
      console.log(
        `Release PR #${previous.number} has a missing or mismatched merge base and cannot publish. Preparing a replacement from main.`,
      )
      rejectedRelease = previous
      receipt = undefined
      previous = undefined
    }
  }
  if (receipt && requestKey !== receipt.request && requestKey !== receipt.version) {
    throw new Error(
      `Release ${receipt.version} still needs verification. Run bun run release:temporal ${receipt.version} to finish it first.`,
    )
  }
  const resume =
    previous?.state === 'MERGED' &&
    (receipt !== undefined ||
      previous.labels.some((label) => label.name === 'autorelease: pending') ||
      (request.version.kind === 'exact' && (await readVersion(previous.headRefOid)) === request.version.version))
  if (receipt && previous?.state !== 'OPEN' && !resume)
    throw new Error(`Saved release PR #${receipt.number} is closed. Reopen it before continuing.`)
  let pr = previous
  let selectedVersion: string | undefined
  if (!resume) {
    const version = selectReleaseVersion(
      receipt
        ? { kind: 'exact', version: receipt.version }
        : rejectedRelease && request.version.kind === 'automatic'
          ? { kind: 'bump', level: 'patch' }
          : request.version,
      currentVersion,
    )
    selectedVersion = version
    if (rejectedRelease?.labels.some((label) => label.name === 'autorelease: pending') && request.mode !== 'preview') {
      await run([
        'gh',
        'pr',
        'edit',
        String(rejectedRelease.number),
        '-R',
        repository,
        '--remove-label',
        'autorelease: pending',
      ])
    }
    console.log(
      `Preparing ${version ?? 'the next SDK version'} from main${request.mode === 'preview' ? ' (dry run)' : ''}.`,
    )
    await run(
      [
        'bunx',
        '--bun',
        'release-please@17.11.2',
        'release-pr',
        `--repo-url=${repository}`,
        '--target-branch=main',
        '--config-file=release-please-config.json',
        '--manifest-file=.release-please-manifest.json',
        '--token=/dev/stdin',
        ...(version ? [`--release-as=${version}`] : []),
        ...(request.mode === 'preview' ? ['--dry-run'] : []),
      ],
      new Blob([token]),
      true,
    )
    if (request.mode === 'preview') return
    pr = await latestReleasePr()
    if (!pr || pr.state !== 'OPEN')
      throw new Error('No release PR was prepared. There may be no releasable commits on main.')
  }
  if (!pr) throw new Error('No release PR was found')
  if (receipt && receipt.number !== pr.number) throw new Error('The saved release PR was replaced during preparation')
  if (!isRepositoryRelease(pr)) throw new Error('The release PR must belong to proompteng/lab')
  if (pr.baseRefName !== 'main') throw new Error('The release PR must target main')
  const version = await readVersion(pr.headRefOid)
  if (receipt && receipt.version !== version) throw new Error('The saved release version does not match its PR')
  if (!isStableVersion(version))
    throw new Error('This command publishes stable versions. Use the documented manual workflow for prereleases.')
  if (selectedVersion && selectedVersion !== version)
    throw new Error(`The release PR contains ${version}, expected ${selectedVersion}`)
  if (pr.state === 'OPEN' && Bun.semver.order(version, await readVersion(pr.baseRefOid)) !== 1) {
    throw new Error(`Release ${version} is not newer than its main base. Run the command again for current main.`)
  }
  if (request.version.kind === 'exact' && request.version.version !== version) {
    throw new Error(`An unfinished ${version} release exists. Finish it before releasing ${request.version.version}.`)
  }
  console.log(`Release ${version}: ${pr.url}`)
  if (request.mode !== 'publish') return
  await saveReceipt(receiptPath, { number: pr.number, version, request: receipt?.request ?? requestKey })
  const deadline = Date.now() + 120 * 60_000
  if (pr.state === 'OPEN') {
    const head = pr.headRefOid
    const base = pr.baseRefOid
    for (;;) {
      const status = await ghJson(checksSchema, [
        'pr',
        'view',
        String(pr.number),
        '-R',
        repository,
        '--json',
        'headRefOid,baseRefOid,state,reviewDecision,statusCheckRollup,reviews,comments',
      ])
      if (status.state === 'MERGED' && status.headRefOid === head) {
        if (status.baseRefOid !== base)
          throw new Error('main changed before the concurrent merge. Inspect the release PR before continuing.')
        pr = await readPr(pr.number)
        break
      }
      const pending = assessReleaseChecks(status, head, base)
      if (pending.length === 0) break
      await wait(pending.join(', '), deadline)
    }
    if (pr.state === 'OPEN') {
      const current = await readPr(pr.number)
      if (
        !isRepositoryRelease(current) ||
        current.baseRefName !== 'main' ||
        current.headRefOid !== head ||
        current.baseRefOid !== base
      ) {
        throw new Error('The release PR identity changed while waiting. Run the command again to recheck it.')
      }
      await ensureResolvedReviews(pr.number)
      console.log(`CI and review passed. Merging release PR #${pr.number}.`)
      try {
        await run(
          [
            'gh',
            'pr',
            'merge',
            String(pr.number),
            '-R',
            repository,
            '--squash',
            '--match-head-commit',
            head,
            '--body-file',
            '-',
          ],
          new Blob([`Release ${packageName}@${version}\n\nTemporal-Bun-Release-Base: ${base}\n`]),
        )
      } catch (error) {
        const concurrent = await readPr(pr.number)
        if (concurrent.state !== 'MERGED' || concurrent.headRefOid !== head || concurrent.baseRefOid !== base)
          throw error
      }
      pr = await readPr(pr.number)
    }
    if (pr.headRefOid !== head || pr.baseRefOid !== base) {
      throw new Error(
        'The release was merged with a different head or base commit. Inspect the release PR before continuing.',
      )
    }
  }
  if (pr.state !== 'MERGED' || !pr.mergeCommit) throw new Error(`Release PR has not merged: ${pr.url}`)
  const sha = pr.mergeCommit.oid
  const publicationUrl = await waitForPublication(sha, resume, deadline)
  await verifyPublishedPack({ name: packageName, version }, `${packageName}@${version}`, sha)
  const tag = `temporal-bun-sdk-v${version}`
  const taggedSha = await run(['gh', 'api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'])
  if (taggedSha !== sha) throw new Error('The GitHub release tag does not match the published commit')
  console.log(
    `\nPublished and verified ${packageName}@${version}\n\nbun add ${packageName}@${version}\n\n${publicationUrl}\nhttps://github.com/${repository}/releases/tag/${tag}`,
  )
  const verifiedReceipt = await readReceipt(receiptPath)
  if (verifiedReceipt?.number === pr.number && verifiedReceipt.version === version) {
    await rm(receiptPath, { force: true })
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
