import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Deferred, Effect, Exit, Fiber, Result } from 'effect'

import type { CandidateDevelopmentCommandReport } from '../candidate-development-command/contracts'
import { frozenSourceVerifiedSourceFiles } from '../candidate-development-command/test-support/provenance-fixtures'
import {
  finalizeCandidateDevelopmentLocalReceipt,
  makeCandidateDevelopmentLocalAttempt,
  reserveCandidateDevelopmentLocalReceipt,
  resolveCandidateDevelopmentLocalArguments,
  runCandidateDevelopmentLocally,
  verifyCandidateDevelopmentLocalSourceTree,
  type CandidateDevelopmentLocalAttemptPort,
  type CandidateDevelopmentLocalDependencies,
  type PreparedCandidateDevelopmentLocalAttempt,
} from './command'
import {
  bindCandidateDevelopmentLocalSource,
  CandidateDevelopmentLocalError,
  makeCandidateDevelopmentLocalReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  type CandidateDevelopmentLocalDecisionStatus,
  type CandidateDevelopmentLocalAttemptReceipt,
} from './domain'

const boundSource = bindCandidateDevelopmentLocalSource(frozenSourceVerifiedSourceFiles)
if (Result.isFailure(boundSource)) throw new Error('candidate local source fixture must be valid')

const prepared: PreparedCandidateDevelopmentLocalAttempt = {
  repositoryRoot: '/repo',
  args: {
    modulePath: 'services/bayn/src/strategy/candidate-20.ts',
    sourceManifestPath: 'services/bayn/candidates/candidate-20.json',
    runtimeMarketDataPath: '/sealed/runtime-market-data.json',
  },
  receiptPath: '/repo/.git/bayn/candidate-development-attempts/ordinal-20.json',
  legacyReceiptPath: '/repo/.git/bayn-candidate-development-local-receipt.json',
  legacyReceiptPaths: ['/repo/.git/bayn-candidate-development-local-receipt.json'],
  source: boundSource.success,
}

const reportFor = (status: CandidateDevelopmentLocalDecisionStatus): CandidateDevelopmentCommandReport =>
  ({
    contentHash: status === 'PASS' ? 'f'.repeat(64) : 'e'.repeat(64),
    decision: { status },
  }) as CandidateDevelopmentCommandReport

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path, 'utf8')
    return true
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return false
    throw cause
  }
}

const legacyReceiptFor = (source: typeof boundSource.success, overrides: { readonly sourceRevision?: string } = {}) => {
  const legacySource = {
    sourceRevision: overrides.sourceRevision ?? source.sourceRevision,
    modulePath: source.modulePath,
    moduleBlobOid: source.moduleBlobOid,
    moduleSha256: source.moduleSha256,
    sourceManifestPath: source.sourceManifestPath,
    sourceManifestBlobOid: source.sourceManifestBlobOid,
    sourceManifestSha256: source.sourceManifestSha256,
  }
  const bindingHash = createHash('sha256')
    .update(
      JSON.stringify([
        'bayn.candidate-development-local-source-binding.v1',
        legacySource.sourceRevision,
        legacySource.modulePath,
        legacySource.moduleBlobOid,
        legacySource.moduleSha256,
        legacySource.sourceManifestPath,
        legacySource.sourceManifestBlobOid,
        legacySource.sourceManifestSha256,
      ]),
      'utf8',
    )
    .digest('hex')
  return {
    schemaVersion: 'bayn.candidate-development-local-attempt.v1',
    attempt: 1,
    status: 'completed',
    source: { ...legacySource, bindingHash },
  }
}

const legacyReceiptContext = (candidateOrdinal: number, manifestBlobOid: string) => ({
  repositoryRoot: '/repo',
  sourceGit: {
    text: async () => manifestBlobOid,
    bytes: async () => Buffer.from(JSON.stringify({ candidateOrdinal }), 'utf8'),
  },
})

const dependencies = (
  execute: CandidateDevelopmentLocalAttemptPort['execute'] = () => Effect.succeed(reportFor('PASS')),
): {
  readonly value: CandidateDevelopmentLocalDependencies
  readonly events: string[]
  readonly finalized: CandidateDevelopmentLocalAttemptReceipt[]
} => {
  const events: string[] = []
  const finalized: CandidateDevelopmentLocalAttemptReceipt[] = []
  const port: CandidateDevelopmentLocalAttemptPort = {
    reserve: (_path, receipt) =>
      Effect.sync(() => {
        events.push(`reserve:${receipt.status}`)
      }),
    execute: (preparedAttempt) =>
      Effect.sync(() =>
        events.push(`execute:${preparedAttempt.source.sourceRevision}:${preparedAttempt.args.runtimeMarketDataPath}`),
      ).pipe(Effect.andThen(execute(preparedAttempt))),
    finalize: (_path, receipt) =>
      Effect.sync(() => {
        finalized.push(receipt)
        events.push(`finalize:${receipt.status}`)
      }),
  }
  return {
    events,
    finalized,
    value: {
      prepare: () => Effect.sync(() => (events.push('prepare'), prepared)),
      attempt: makeCandidateDevelopmentLocalAttempt(port),
    },
  }
}

const runWithDependencies = (fixture: { readonly value: CandidateDevelopmentLocalDependencies }) =>
  runCandidateDevelopmentLocally(
    [prepared.args.modulePath, prepared.args.sourceManifestPath, prepared.args.runtimeMarketDataPath],
    fixture.value,
  )

describe('candidate development local domain', () => {
  test('requires exactly three opaque paths', () => {
    expect(
      Result.isSuccess(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json', 'runtime.json'])),
    ).toBe(true)
    expect(Result.isFailure(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json']))).toBe(true)
  })

  test('binds reviewed source identity without recording the runtime witness path or contents', () => {
    const receipt = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'PASS', reportFor('PASS').contentHash)
    const serialized = serializeCandidateDevelopmentLocalReceipt(receipt)
    expect(receipt.source).toMatchObject({
      sourceRevision: frozenSourceVerifiedSourceFiles.sourceRevision,
      moduleBlobOid: frozenSourceVerifiedSourceFiles.moduleBlobOid,
      moduleSha256: frozenSourceVerifiedSourceFiles.moduleSha256,
      sourceManifestBlobOid: frozenSourceVerifiedSourceFiles.sourceManifestBlobOid,
      sourceManifestSha256: frozenSourceVerifiedSourceFiles.sourceManifestSha256,
    })
    expect(receipt.source.bindingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(serialized).not.toContain('/sealed/runtime-market-data.json')
    expect(serialized).not.toContain('bars')
    expect(serialized).not.toContain('strategyProtocol')
  })

  test('resolves documented repository-relative paths from the repository root', () => {
    expect(
      resolveCandidateDevelopmentLocalArguments('/repo', {
        modulePath: 'services/bayn/src/strategy/candidate-20.ts',
        sourceManifestPath: 'services/bayn/candidates/candidate-20.json',
        runtimeMarketDataPath: 'sealed/runtime-market-data.json',
      }),
    ).toEqual({
      modulePath: '/repo/services/bayn/src/strategy/candidate-20.ts',
      sourceManifestPath: '/repo/services/bayn/candidates/candidate-20.json',
      runtimeMarketDataPath: '/repo/sealed/runtime-market-data.json',
    })
  })

  test('rejects evaluator source drift before executing a reviewed module', async () => {
    const sourceGit = {
      text: async (_repositoryRoot: string, args: readonly string[]) => {
        if (args[0] === 'ls-files') return 'H services/bayn/src/evaluator.ts'
        if (args[0] === 'diff') return ''
        if (args[0] === 'status') return ' M services/bayn/src/evaluator.ts'
        throw new Error(`unexpected Git command: ${args.join(' ')}`)
      },
      bytes: async () => Buffer.alloc(0),
    }
    const exit = await Effect.runPromiseExit(
      verifyCandidateDevelopmentLocalSourceTree('/repo', ['services/bayn/src'], sourceGit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('rejects a changed HEAD even when the evaluator tree is otherwise clean', async () => {
    const sourceGit = {
      text: async (_repositoryRoot: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse') return 'a'.repeat(40)
        if (args[0] === 'ls-files') return 'H services/bayn/src/evaluator.ts'
        if (args[0] === 'diff') return ''
        if (args[0] === 'status') return ''
        throw new Error(`unexpected Git command: ${args.join(' ')}`)
      },
      bytes: async () => Buffer.alloc(0),
    }
    const exit = await Effect.runPromiseExit(
      verifyCandidateDevelopmentLocalSourceTree('/repo', ['services/bayn/src'], sourceGit, 'b'.repeat(40)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('candidate development local program', () => {
  test('reserves before evaluation and finalizes PASS exactly once', async () => {
    const fixture = dependencies()
    const receipt = await Effect.runPromise(runWithDependencies(fixture))

    expect(fixture.events).toEqual([
      'prepare',
      'reserve:RESERVED',
      `execute:${prepared.source.sourceRevision}:${prepared.args.runtimeMarketDataPath}`,
      'finalize:PASS',
    ])
    expect(fixture.finalized).toHaveLength(1)
    expect(receipt).toMatchObject({ status: 'PASS', terminalReportHash: reportFor('PASS').contentHash })
  })

  test('records HOLD_REJECT separately from PASS while retaining the report hash', async () => {
    const fixture = dependencies(() => Effect.succeed(reportFor('HOLD_REJECT')))
    const receipt = await Effect.runPromise(runWithDependencies(fixture))

    expect(fixture.finalized).toHaveLength(1)
    expect(fixture.finalized[0]).toMatchObject({
      status: 'HOLD_REJECT',
      terminalReportHash: reportFor('HOLD_REJECT').contentHash,
    })
    expect(receipt).toMatchObject({
      status: 'HOLD_REJECT',
      terminalReportHash: reportFor('HOLD_REJECT').contentHash,
    })
  })

  test('burns and finalizes the reservation as FAILED when evaluation fails', async () => {
    const fixture = dependencies(() => Effect.fail({ _tag: 'CandidateDevelopmentCommandModulePathMissing' } as const))
    const exit = await Effect.runPromiseExit(runWithDependencies(fixture))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.events.at(-1)).toBe('finalize:FAILED')
    expect(fixture.finalized).toHaveLength(1)
    expect(fixture.finalized[0]).toMatchObject({ status: 'FAILED', terminalReportHash: null })
  })

  test('finalizes FAILED on interruption exactly once', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const fixture = dependencies(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
    const fiber = Effect.runFork(runWithDependencies(fixture))

    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.finalized).toHaveLength(1)
    expect(fixture.finalized[0]).toMatchObject({ status: 'FAILED', terminalReportHash: null })
  })

  test('never starts evaluation when the atomic reservation already exists', async () => {
    const fixture = dependencies()
    const blocked: CandidateDevelopmentLocalDependencies = {
      ...fixture.value,
      attempt: makeCandidateDevelopmentLocalAttempt({
        reserve: () =>
          Effect.fail(
            new CandidateDevelopmentLocalError({
              code: 'RECEIPT_ALREADY_CONSUMED',
              message: 'already consumed',
            }),
          ),
        execute: () => Effect.fail({ _tag: 'CandidateDevelopmentCommandModulePathMissing' } as const),
        finalize: () => Effect.void,
      }),
    }
    const exit = await Effect.runPromiseExit(runWithDependencies({ value: blocked }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.events.some((event) => event.startsWith('execute:'))).toBe(false)
  })

  test('an existing RESERVED receipt burns the ordinal across a crash and blocks retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'receipt.json')
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    let executeCount = 0
    try {
      await Effect.runPromise(reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved))
      const exit = await Effect.runPromiseExit(
        runCandidateDevelopmentLocally(
          [prepared.args.modulePath, prepared.args.sourceManifestPath, prepared.args.runtimeMarketDataPath],
          {
            prepare: () => Effect.succeed({ ...prepared, receiptPath }),
            attempt: makeCandidateDevelopmentLocalAttempt({
              reserve: reserveCandidateDevelopmentLocalReceipt,
              execute: () =>
                Effect.sync(() => {
                  executeCount += 1
                  return reportFor('PASS')
                }),
              finalize: finalizeCandidateDevelopmentLocalReceipt,
            }),
          },
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(executeCount).toBe(0)
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({
        attempt: 1,
        status: 'RESERVED',
        terminalReportHash: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('claims and replaces one compact receipt atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'receipt.json')
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    const completed = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'PASS', reportFor('PASS').contentHash)
    try {
      await Effect.runPromise(reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved))
      const duplicate = await Effect.runPromiseExit(reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved))
      expect(Exit.isFailure(duplicate)).toBe(true)
      await Effect.runPromise(finalizeCandidateDevelopmentLocalReceipt(receiptPath, completed))
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({
        schemaVersion: 'bayn.candidate-development-local-attempt.v3',
        status: 'PASS',
        terminalReportHash: reportFor('PASS').contentHash,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a legacy receipt before creating the v3 reservation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'bayn', 'candidate-development-attempts', 'ordinal-20.json')
    const legacyReceiptPath = join(directory, 'bayn-candidate-development-local-receipt.json')
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    try {
      await mkdir(join(directory, 'bayn', 'candidate-development-attempts'), { recursive: true })
      await writeFile(
        legacyReceiptPath,
        `${JSON.stringify(legacyReceiptFor(boundSource.success, { sourceRevision: '1'.repeat(40) }))}\n`,
        'utf8',
      )
      const exit = await Effect.runPromiseExit(
        reserveCandidateDevelopmentLocalReceipt(
          receiptPath,
          reserved,
          legacyReceiptPath,
          legacyReceiptContext(20, '5'.repeat(40)),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(await fileExists(receiptPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('allows a valid legacy receipt for a different source binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'bayn', 'candidate-development-attempts', 'ordinal-20.json')
    const legacyReceiptPath = join(directory, 'bayn-candidate-development-local-receipt.json')
    const differentSource = {
      ...boundSource.success,
      sourceRevision: '3'.repeat(40),
      modulePath: 'services/bayn/src/strategy/other-candidate.ts',
      moduleBlobOid: '7'.repeat(40),
      moduleSha256: '8'.repeat(64),
      sourceManifestPath: 'services/bayn/candidates/ordinal-21.json',
      sourceManifestBlobOid: '9'.repeat(40),
      sourceManifestSha256: 'a'.repeat(64),
    }
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    try {
      await mkdir(join(directory, 'bayn', 'candidate-development-attempts'), { recursive: true })
      await writeFile(legacyReceiptPath, `${JSON.stringify(legacyReceiptFor(differentSource))}\n`, 'utf8')

      await Effect.runPromise(
        reserveCandidateDevelopmentLocalReceipt(
          receiptPath,
          reserved,
          legacyReceiptPath,
          legacyReceiptContext(21, differentSource.sourceManifestBlobOid),
        ),
      )

      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ status: 'RESERVED' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a matching legacy receipt from a registered linked worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'bayn', 'candidate-development-attempts', 'ordinal-20.json')
    const currentLegacyReceiptPath = join(
      directory,
      'current-worktree',
      'bayn-candidate-development-local-receipt.json',
    )
    const linkedWorktreeLegacyReceiptPath = join(
      directory,
      'linked-worktree-git',
      'bayn-candidate-development-local-receipt.json',
    )
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    try {
      await mkdir(dirname(receiptPath), { recursive: true })
      await mkdir(dirname(linkedWorktreeLegacyReceiptPath), { recursive: true })
      await writeFile(
        linkedWorktreeLegacyReceiptPath,
        `${JSON.stringify(legacyReceiptFor(boundSource.success, { sourceRevision: '1'.repeat(40) }))}\n`,
        'utf8',
      )
      const exit = await Effect.runPromiseExit(
        reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved, currentLegacyReceiptPath, {
          ...legacyReceiptContext(20, '5'.repeat(40)),
          legacyReceiptPaths: [linkedWorktreeLegacyReceiptPath],
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(await fileExists(receiptPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('leaves a crash marker as the consumed reservation without publishing a partial receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'receipt.json')
    const reserved = makeCandidateDevelopmentLocalReceipt(boundSource.success, 'RESERVED')
    try {
      await writeFile(`${receiptPath}.reservation`, '', 'utf8')
      const exit = await Effect.runPromiseExit(reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(await fileExists(receiptPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
