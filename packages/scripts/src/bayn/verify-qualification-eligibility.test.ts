import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'

import {
  verifyQualificationEligibility,
  type QualificationEligibilityInput,
  type QualificationEligibilityOptions,
  type QualificationGit,
} from './verify-qualification-eligibility'

const execFilePromise = promisify(execFile)
const h = (value: string) => value.repeat(64).slice(0, 64)
const r = (value: string) => value.repeat(40).slice(0, 40)

interface GitFixture {
  readonly repository: string
  readonly rootRevision: string
  readonly preregistrationRevision: string
  readonly currentRevision: string
}

const git = async (repository: string, args: readonly string[]): Promise<string> => {
  const result = await execFilePromise('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  })
  return result.stdout.trim()
}

const commit = async (repository: string, value: string, message: string): Promise<string> => {
  await writeFile(join(repository, 'marker.txt'), `${value}\n`)
  await git(repository, ['add', 'marker.txt'])
  await git(repository, ['commit', '-qm', message])
  return git(repository, ['rev-parse', 'HEAD'])
}

const makeGitFixture = async (origin = 'https://github.com/proompteng/lab.git'): Promise<GitFixture> => {
  const repository = await mkdtemp(join(tmpdir(), 'bayn-qualification-eligibility-'))
  await git(repository, ['init', '-q', '-b', 'main'])
  await git(repository, ['config', 'user.name', 'Qualification Test'])
  await git(repository, ['config', 'user.email', 'qualification@example.test'])
  const rootRevision = await commit(repository, 'root', 'test: root')
  const preregistrationRevision = await commit(repository, 'preregistered', 'test: preregister candidate')
  const currentRevision = await commit(repository, 'implemented', 'test: implement candidate')
  await git(repository, ['remote', 'add', 'origin', origin])
  await git(repository, ['update-ref', 'refs/remotes/origin/main', currentRevision])
  return { repository, rootRevision, preregistrationRevision, currentRevision }
}

const fixture = (repository: GitFixture): QualificationEligibilityInput => ({
  eventName: 'schedule',
  repository: 'proompteng/lab',
  currentMainSha: repository.currentRevision,
  workflowSha: repository.currentRevision,
  sourceSha: repository.currentRevision,
  imageRepository: 'registry.example/bayn',
  imageDigest: `sha256:${h('b')}`,
  strategyBehaviorHash: h('c'),
  strategyParameterHash: h('d'),
  preregistrationBlobOid: r('e'),
  preregistration: {
    schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
    candidateOrdinal: 17,
    priorTrialCount: 16,
    strategyProtocolHash: h('f'),
    modulePath: 'services/bayn/src/strategy/candidate-17.ts',
    moduleSha256: h('1'),
    marketData: {
      schemaVersion: 'bayn.candidate-development-market-data-source.v1',
      snapshotId: h('2'),
      finalizedSnapshotContentHash: h('3'),
      inputManifestHash: h('4'),
      boundedContentHash: h('5'),
    },
    preregistration: {
      sourceRevision: repository.preregistrationRevision,
      path: 'candidate.json',
      blobOid: r('e'),
    },
  },
  publication: {
    natural: true,
    completed: true,
    publicationDate: '2026-08-01',
    sourceSha: repository.currentRevision,
    imageDigest: `sha256:${h('b')}`,
    snapshotId: h('2'),
    finalizedSnapshotContentHash: h('3'),
    inputManifestHash: h('4'),
    boundedContentHash: h('5'),
  },
  attempts: [],
  database: { lockCount: 0, resultCount: 0, trialCount: 16 },
})

const options = (
  repository: GitFixture,
  patch: Partial<QualificationEligibilityOptions> = {},
): QualificationEligibilityOptions => ({
  repositoryRoot: repository.repository,
  trustedRepository: 'proompteng/lab',
  gitTimeoutMs: 5_000,
  ...patch,
})

const withRepository = async <A>(run: (repository: GitFixture) => Promise<A>): Promise<A> => {
  const repository = await makeGitFixture()
  try {
    return await run(repository)
  } finally {
    await rm(repository.repository, { recursive: true, force: true })
  }
}

const commitTree = async (repository: GitFixture, parent: string, message: string): Promise<string> => {
  const tree = await git(repository.repository, ['rev-parse', `${repository.currentRevision}^{tree}`])
  return git(repository.repository, ['commit-tree', tree, '-p', parent, '-m', message])
}

describe('qualification eligibility immutable Git verification', () => {
  test('is safely dormant before a reviewed preregistration exists without opening Git', async () => {
    const result = await verifyQualificationEligibility(
      {
        ...fixture({
          repository: '/missing',
          rootRevision: r('1'),
          preregistrationRevision: r('2'),
          currentRevision: r('3'),
        }),
        preregistration: null,
      },
      { repositoryRoot: '/missing', trustedRepository: 'proompteng/lab' },
    )
    expect(result).toEqual({ status: 'dormant', code: 'preregistration-missing' })
  })

  test('accepts a strict proper ancestor in the exact trusted current-main repository', async () => {
    await withRepository(async (repository) => {
      const result = await verifyQualificationEligibility(fixture(repository), options(repository))
      expect(result).toMatchObject({
        status: 'eligible',
        trustedRepository: 'proompteng/lab',
        sourceSha: repository.currentRevision,
      })
      if (result.status === 'eligible') {
        expect(result.repositoryHash).toBe(
          createHash('sha256').update('github.repository.v1:proompteng/lab').digest('hex'),
        )
        expect(result.eligibilityHash).toMatch(/^[0-9a-f]{64}$/)
      }
    })
  })

  test('rejects equal, descendant, divergent, and missing preregistration revisions', async () => {
    await withRepository(async (repository) => {
      const descendant = await commitTree(repository, repository.currentRevision, 'test: descendant')
      const divergent = await commitTree(repository, repository.rootRevision, 'test: divergent')
      for (const sourceRevision of [repository.currentRevision, descendant, divergent, r('9')]) {
        const input = fixture(repository)
        const result = await verifyQualificationEligibility(
          {
            ...input,
            preregistration: {
              ...input.preregistration!,
              preregistration: { ...input.preregistration!.preregistration, sourceRevision },
            },
          },
          options(repository),
        )
        expect(result).toMatchObject({ status: 'hold', code: 'preregistration-lineage-invalid' })
      }
    })
  })

  test('rejects replacement-ref ancestry that makes a divergent current source appear related', async () => {
    await withRepository(async (repository) => {
      const divergent = await commitTree(repository, repository.rootRevision, 'test: divergent')
      const forged = await commitTree(repository, repository.preregistrationRevision, 'test: forged ancestry')
      await git(repository.repository, ['update-ref', 'refs/heads/main', divergent])
      await git(repository.repository, ['update-ref', 'refs/remotes/origin/main', divergent])
      await git(repository.repository, ['replace', divergent, forged])
      await git(repository.repository, ['merge-base', '--is-ancestor', repository.preregistrationRevision, divergent])
      const input = fixture({ ...repository, currentRevision: divergent })
      expect(await verifyQualificationEligibility(input, options(repository))).toMatchObject({
        status: 'hold',
        code: 'repository-integrity-invalid',
      })
    })
  })

  test('rejects graft-spoofed ancestry before raw parent verification', async () => {
    await withRepository(async (repository) => {
      const divergent = await commitTree(repository, repository.rootRevision, 'test: divergent')
      await git(repository.repository, ['update-ref', 'refs/heads/main', divergent])
      await git(repository.repository, ['update-ref', 'refs/remotes/origin/main', divergent])
      const graftsPath = join(
        repository.repository,
        await git(repository.repository, ['rev-parse', '--git-path', 'info/grafts']),
      )
      await mkdir(dirname(graftsPath), { recursive: true })
      await writeFile(graftsPath, `${divergent} ${repository.preregistrationRevision}\n`)
      await git(repository.repository, ['merge-base', '--is-ancestor', repository.preregistrationRevision, divergent])
      const input = fixture({ ...repository, currentRevision: divergent })
      expect(await verifyQualificationEligibility(input, options(repository))).toMatchObject({
        status: 'hold',
        code: 'repository-integrity-invalid',
      })
    })
  })

  test('rejects alternate-object metadata even when ordinary history is otherwise valid', async () => {
    await withRepository(async (repository) => {
      const alternate = await mkdtemp(join(tmpdir(), 'bayn-qualification-alternate-'))
      try {
        await git(alternate, ['init', '-q', '--bare'])
        const alternatesPath = join(
          repository.repository,
          await git(repository.repository, ['rev-parse', '--git-path', 'objects/info/alternates']),
        )
        await mkdir(dirname(alternatesPath), { recursive: true })
        await writeFile(alternatesPath, `${join(alternate, 'objects')}\n`)
        expect(await verifyQualificationEligibility(fixture(repository), options(repository))).toMatchObject({
          status: 'hold',
          code: 'repository-integrity-invalid',
        })
      } finally {
        await rm(alternate, { recursive: true, force: true })
      }
    })
  })

  test('rejects identical history from a different repository and hashes the accepted canonical identity', async () => {
    await withRepository(async (repository) => {
      const upstream = await verifyQualificationEligibility(fixture(repository), options(repository))
      expect(upstream.status).toBe('eligible')

      await git(repository.repository, ['remote', 'set-url', 'origin', 'git@github.com:foreign/lab.git'])
      const foreignInput = { ...fixture(repository), repository: 'foreign/lab' }
      expect(await verifyQualificationEligibility(foreignInput, options(repository))).toMatchObject({
        status: 'hold',
        code: 'repository-identity-invalid',
      })

      const foreign = await verifyQualificationEligibility(
        foreignInput,
        options(repository, { trustedRepository: 'foreign/lab' }),
      )
      expect(foreign.status).toBe('eligible')
      if (upstream.status === 'eligible' && foreign.status === 'eligible') {
        expect(foreign.repositoryHash).not.toBe(upstream.repositoryHash)
        expect(foreign.eligibilityHash).not.toBe(upstream.eligibilityHash)
      }
    })
  })

  test('rejects a foreign raw origin hidden by repository-local URL rewrite configuration', async () => {
    const repository = await makeGitFixture('https://github.com/foreign/lab.git')
    try {
      await git(repository.repository, [
        'config',
        'url.https://github.com/proompteng/lab.git.insteadOf',
        'https://github.com/foreign/lab.git',
      ])
      expect(await git(repository.repository, ['remote', 'get-url', 'origin'])).toBe(
        'https://github.com/proompteng/lab.git',
      )
      expect(await verifyQualificationEligibility(fixture(repository), options(repository))).toMatchObject({
        status: 'hold',
        code: 'repository-integrity-invalid',
      })
    } finally {
      await rm(repository.repository, { recursive: true, force: true })
    }
  })

  test('rejects a checked-out HEAD or origin/main that differs from declared current main', async () => {
    await withRepository(async (repository) => {
      const changed = r('8')
      const input = {
        ...fixture(repository),
        currentMainSha: changed,
        workflowSha: changed,
        sourceSha: changed,
        publication: { ...fixture(repository).publication!, sourceSha: changed },
      }
      expect(await verifyQualificationEligibility(input, options(repository))).toMatchObject({
        status: 'hold',
        code: 'source-head-mismatch',
      })
    })
  })

  test('cancels an in-flight Git verification', async () => {
    await withRepository(async (repository) => {
      let aborted = false
      const hangingGit: QualificationGit = {
        text: (_root, _args, signal) =>
          new Promise((_resolve, reject) => {
            const abort = () => {
              aborted = true
              reject(signal.reason ?? new Error('aborted'))
            }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          }),
      }
      const controller = new AbortController()
      const resultPromise = verifyQualificationEligibility(
        fixture(repository),
        options(repository, { git: hangingGit, signal: controller.signal }),
      )
      setTimeout(() => controller.abort(new Error('test cancellation')), 10)
      expect(await resultPromise).toMatchObject({ status: 'hold', code: 'git-verification-cancelled' })
      expect(aborted).toBe(true)
    })
  })

  test('bounds a stalled Git verification with one overall timeout', async () => {
    await withRepository(async (repository) => {
      const hangingGit: QualificationGit = {
        text: (_root, _args, signal) =>
          new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason ?? new Error('aborted'))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          }),
      }
      expect(
        await verifyQualificationEligibility(
          fixture(repository),
          options(repository, { git: hangingGit, gitTimeoutMs: 10 }),
        ),
      ).toMatchObject({ status: 'hold', code: 'git-verification-timeout' })
    })
  })
})

describe('qualification eligibility evidence checks', () => {
  test('rejects manual dispatch before Git access', async () => {
    const input = fixture({
      repository: '/missing',
      rootRevision: r('1'),
      preregistrationRevision: r('2'),
      currentRevision: r('3'),
    })
    expect(
      await verifyQualificationEligibility(
        { ...input, eventName: 'workflow_dispatch' },
        { repositoryRoot: '/missing', trustedRepository: 'proompteng/lab' },
      ),
    ).toMatchObject({ status: 'hold', code: 'manual-dispatch-rejected' })
  })

  test.each([
    ['changed preregistration blob', { preregistrationBlobOid: r('9') }, 'preregistration-invalid'],
    [
      'stale publication source',
      (input: QualificationEligibilityInput) => ({ publication: { ...input.publication!, sourceSha: r('9') } }),
      'publication-source-mismatch',
    ],
    [
      'changed data',
      (input: QualificationEligibilityInput) => ({
        publication: { ...input.publication!, boundedContentHash: h('9') },
      }),
      'publication-data-mismatch',
    ],
    ['prior lock', { database: { lockCount: 1, resultCount: 0, trialCount: 16 } }, 'database-state-not-pristine'],
    ['prior result', { database: { lockCount: 0, resultCount: 1, trialCount: 16 } }, 'database-state-not-pristine'],
    [
      'in-flight run',
      { attempts: [{ candidateOrdinal: 17, status: 'in_progress' as const, conclusion: null }] },
      'prior-or-inflight-attempt',
    ],
    [
      'duplicate completed run',
      { attempts: [{ candidateOrdinal: 17, status: 'completed' as const, conclusion: 'failure' }] },
      'prior-or-inflight-attempt',
    ],
  ])('rejects %s after immutable Git verification', async (_name, patch, code) => {
    await withRepository(async (repository) => {
      const input = fixture(repository)
      const resolvedPatch = typeof patch === 'function' ? patch(input) : patch
      expect(await verifyQualificationEligibility({ ...input, ...resolvedPatch }, options(repository))).toMatchObject({
        status: 'hold',
        code,
      })
    })
  })
})
