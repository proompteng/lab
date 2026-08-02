import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  makeCandidateDevelopmentLocalAttemptReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  validateCandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalAttemptReceipt,
} from './contract'
import {
  CandidateDevelopmentLocalError,
  candidateDevelopmentGitCommand,
  revalidateCandidateDevelopmentLocalSource,
  runCandidateDevelopmentLocally,
  finalizeCandidateDevelopmentLocalReceipt,
  reserveCandidateDevelopmentLocalReceipt,
  type CandidateDevelopmentLocalDependencies,
  type CandidateDevelopmentLocalProcessRequest,
  type CandidateDevelopmentLocalSourceResolution,
} from './command'

const execFileAsync = promisify(execFile)

const source = validateCandidateDevelopmentLocalSourceBinding({
  sourceRevision: 'a'.repeat(40),
  modulePath: 'services/bayn/src/strategy/example.ts',
  moduleBlobOid: 'b'.repeat(40),
  moduleSha256: 'c'.repeat(64),
  sourceManifestPath: 'services/bayn/candidates/example.json',
  sourceManifestBlobOid: 'd'.repeat(40),
  sourceManifestSha256: 'e'.repeat(64),
})

if (!source.ok) throw new Error(source.message)

const resolved: CandidateDevelopmentLocalSourceResolution = {
  repositoryRoot: '/repo',
  modulePath: 'services/bayn/src/strategy/example.ts',
  sourceManifestPath: 'services/bayn/candidates/example.json',
  runtimeMarketDataPath: '/sealed/typed-runtime-market-data.json',
  receiptPath: '/repo/.git/bayn-candidate-development-local-receipt.json',
  candidateOrdinal: 20,
  source: source.value,
}

const dependenciesFor = (
  exitCode: number | null = 0,
): {
  readonly dependencies: CandidateDevelopmentLocalDependencies
  readonly receipts: CandidateDevelopmentLocalAttemptReceipt[]
  readonly processes: CandidateDevelopmentLocalProcessRequest[]
} => {
  const receipts: CandidateDevelopmentLocalAttemptReceipt[] = []
  const processes: CandidateDevelopmentLocalProcessRequest[] = []
  const consumed = { value: false }
  return {
    receipts,
    processes,
    dependencies: {
      resolveSourceBinding: async () => resolved,
      revalidateSourceBinding: async () => undefined,
      reserveReceipt: async (_path, receipt) => {
        if (consumed.value) throw new Error('receipt exists')
        consumed.value = true
        receipts.push(receipt)
      },
      finalizeReceipt: async (_path, receipt) => {
        receipts.push(receipt)
      },
      runCandidateDevelopment: async (request) => {
        processes.push(request)
        if (exitCode === null) throw new Error('child process failed')
        return exitCode
      },
    },
  }
}

describe('candidate development local contract', () => {
  test('requires exactly three paths and does not interpret runtime market data', () => {
    expect(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json', 'runtime.json'])).toEqual({
      ok: true,
      value: { modulePath: 'module.ts', sourceManifestPath: 'manifest.json', runtimeMarketDataPath: 'runtime.json' },
    })
    expect(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json'])).toMatchObject({
      ok: false,
      code: 'invalid-arguments',
    })
  })

  test('binds source and manifest identity without putting runtime data in the compact receipt', () => {
    const receipt = makeCandidateDevelopmentLocalAttemptReceipt(source.value, 'reserved')
    const serialized = serializeCandidateDevelopmentLocalReceipt(receipt)
    expect(receipt.source.bindingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(serialized).not.toContain('/sealed/typed-runtime-market-data.json')
    expect(serialized).not.toContain('runtime')
  })
})

describe('candidate development local command', () => {
  test('uses the hardened Git view for every reviewed source read', () => {
    const previousReplacementRef = process.env.GIT_REPLACE_REF_BASE
    process.env.GIT_REPLACE_REF_BASE = '/tmp/replacement-refs'
    try {
      const command = candidateDevelopmentGitCommand(['rev-parse', 'HEAD'])
      expect(command.args).toEqual(['--no-replace-objects', 'rev-parse', 'HEAD'])
      expect(command.env).not.toHaveProperty('GIT_REPLACE_REF_BASE')
    } finally {
      if (previousReplacementRef === undefined) delete process.env.GIT_REPLACE_REF_BASE
      else process.env.GIT_REPLACE_REF_BASE = previousReplacementRef
    }
  })

  test('rejects an untracked evaluator source file during source revalidation', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-evaluator-source-'))
    const modulePath = 'services/bayn/src/strategy/example.ts'
    const sourceManifestPath = 'services/bayn/candidates/example.json'
    try {
      await mkdir(join(repository, 'services/bayn/src/strategy'), { recursive: true })
      await mkdir(join(repository, 'services/bayn/candidates'), { recursive: true })
      await writeFile(join(repository, modulePath), 'export const candidateDevelopmentProgram = {}\n')
      await writeFile(join(repository, sourceManifestPath), '{}\n')
      await execFileAsync('git', ['init', '-q'], { cwd: repository })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
      await execFileAsync('git', ['config', 'user.name', 'Bayn Test'], { cwd: repository })
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '-qm', 'test: bind evaluator source'], { cwd: repository })
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
      const sourceRevision = String(stdout).trim()
      const sourceBinding = validateCandidateDevelopmentLocalSourceBinding({
        ...source.value,
        sourceRevision,
      })
      if (!sourceBinding.ok) throw new Error(sourceBinding.message)
      const resolution: CandidateDevelopmentLocalSourceResolution = {
        ...resolved,
        repositoryRoot: repository,
        modulePath,
        sourceManifestPath,
        source: sourceBinding.value,
      }
      await writeFile(join(repository, 'services/bayn/src/untracked-evaluator-helper.ts'), 'export const value = 1\n')

      await expect(revalidateCandidateDevelopmentLocalSource(resolution)).rejects.toMatchObject({
        code: 'source-working-tree-dirty',
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('rejects an index-hidden evaluator modification during source revalidation', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-index-source-'))
    const modulePath = 'services/bayn/src/strategy/example.ts'
    const sourceManifestPath = 'services/bayn/candidates/example.json'
    const evaluatorPath = 'services/bayn/src/evaluator.ts'
    try {
      await mkdir(join(repository, 'services/bayn/src/strategy'), { recursive: true })
      await mkdir(join(repository, 'services/bayn/candidates'), { recursive: true })
      await writeFile(join(repository, modulePath), 'export const candidateDevelopmentProgram = {}\n')
      await writeFile(join(repository, sourceManifestPath), '{}\n')
      await writeFile(join(repository, evaluatorPath), 'export const evaluator = 1\n')
      await execFileAsync('git', ['init', '-q'], { cwd: repository })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
      await execFileAsync('git', ['config', 'user.name', 'Bayn Test'], { cwd: repository })
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '-qm', 'test: bind evaluator source'], { cwd: repository })
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
      const sourceRevision = String(stdout).trim()
      const sourceBinding = validateCandidateDevelopmentLocalSourceBinding({
        ...source.value,
        sourceRevision,
      })
      if (!sourceBinding.ok) throw new Error(sourceBinding.message)
      const resolution: CandidateDevelopmentLocalSourceResolution = {
        ...resolved,
        repositoryRoot: repository,
        modulePath,
        sourceManifestPath,
        source: sourceBinding.value,
      }
      await execFileAsync('git', ['update-index', '--assume-unchanged', '--', evaluatorPath], { cwd: repository })
      await writeFile(join(repository, evaluatorPath), 'export const evaluator = 2\n')

      await expect(revalidateCandidateDevelopmentLocalSource(resolution)).rejects.toMatchObject({
        code: 'source-working-tree-dirty',
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('rejects invalid arguments before source resolution or process execution', async () => {
    const fixture = dependenciesFor()
    let resolvedCount = 0
    const dependencies: CandidateDevelopmentLocalDependencies = {
      ...fixture.dependencies,
      resolveSourceBinding: async () => {
        resolvedCount += 1
        return resolved
      },
    }

    await expect(runCandidateDevelopmentLocally(['module.ts'], dependencies)).rejects.toMatchObject({
      code: 'invalid-arguments',
    })
    expect(resolvedCount).toBe(0)
    expect(fixture.processes).toEqual([])
  })

  test('reserves once, invokes the exact existing command, and finalizes success', async () => {
    const fixture = dependenciesFor()
    const result = await runCandidateDevelopmentLocally(
      ['module.ts', 'manifest.json', '/sealed/typed-runtime-market-data.json'],
      fixture.dependencies,
    )

    expect(fixture.processes).toEqual([
      {
        repositoryRoot: '/repo',
        argv: [
          'services/bayn/src/strategy/example.ts',
          'services/bayn/candidates/example.json',
          '/sealed/typed-runtime-market-data.json',
        ],
        sourceRevision: 'a'.repeat(40),
      },
    ])
    expect(fixture.receipts.map(({ status }) => status)).toEqual(['reserved', 'completed'])
    expect(result.receipt.status).toBe('completed')
    expect(JSON.stringify(result.receipt)).not.toContain('/sealed/typed-runtime-market-data.json')
  })

  test('does not launch when the reviewed binding changes before the child starts', async () => {
    const fixture = dependenciesFor()
    let revalidationCount = 0
    const dependencies: CandidateDevelopmentLocalDependencies = {
      ...fixture.dependencies,
      revalidateSourceBinding: async () => {
        revalidationCount += 1
        throw new CandidateDevelopmentLocalError('source-binding-invalid', 'source changed')
      },
    }

    await expect(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], dependencies),
    ).rejects.toMatchObject({ code: 'source-binding-invalid' })
    expect(revalidationCount).toBe(1)
    expect(fixture.processes).toEqual([])
    expect(fixture.receipts.map(({ status }) => status)).toEqual(['reserved', 'failed'])
  })

  test('burns the attempt when the reviewed binding changes after the child exits', async () => {
    const fixture = dependenciesFor()
    let revalidationCount = 0
    const dependencies: CandidateDevelopmentLocalDependencies = {
      ...fixture.dependencies,
      revalidateSourceBinding: async () => {
        revalidationCount += 1
        if (revalidationCount === 2)
          throw new CandidateDevelopmentLocalError('source-binding-invalid', 'source changed')
      },
    }

    await expect(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], dependencies),
    ).rejects.toMatchObject({ code: 'source-binding-invalid' })
    expect(revalidationCount).toBe(2)
    expect(fixture.processes).toHaveLength(1)
    expect(fixture.receipts.map(({ status, exitCode }) => [status, exitCode])).toEqual([
      ['reserved', undefined],
      ['failed', 0],
    ])
  })

  test('consumes the one-shot receipt when the child exits nonzero', async () => {
    const fixture = dependenciesFor(7)
    await expect(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], fixture.dependencies),
    ).rejects.toMatchObject({ code: 'candidate-exited' })
    expect(fixture.receipts.map(({ status, exitCode }) => [status, exitCode])).toEqual([
      ['reserved', undefined],
      ['failed', 7],
    ])
    expect(fixture.processes).toHaveLength(1)
  })

  test('finalizes a failed receipt when process startup throws', async () => {
    const fixture = dependenciesFor(null)
    await expect(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], fixture.dependencies),
    ).rejects.toMatchObject({ code: 'candidate-process-failed' })
    expect(fixture.receipts.map(({ status }) => status)).toEqual(['reserved', 'failed'])
  })

  test('does not start a second process after receipt reservation fails', async () => {
    const fixture = dependenciesFor()
    await runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], fixture.dependencies)
    await expect(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'runtime.json'], fixture.dependencies),
    ).rejects.toMatchObject({})
    expect(fixture.processes).toHaveLength(1)
  })

  test('claims and finalizes the compact receipt atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const receiptPath = join(directory, 'receipt.json')
    const reserved = makeCandidateDevelopmentLocalAttemptReceipt(source.value, 'reserved')
    const completed = makeCandidateDevelopmentLocalAttemptReceipt(source.value, 'completed', 0)
    try {
      await reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved)
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ status: 'reserved', attempt: 1 })
      await expect(reserveCandidateDevelopmentLocalReceipt(receiptPath, reserved)).rejects.toMatchObject({
        code: 'receipt-already-consumed',
      })
      await finalizeCandidateDevelopmentLocalReceipt(receiptPath, completed)
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ status: 'completed', exitCode: 0 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('claims the v3 ordinal path before the legacy path for upgrade coordination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-development-local-'))
    const legacyReceiptPath = join(directory, 'bayn-candidate-development-local-receipt.json')
    const reserved = makeCandidateDevelopmentLocalAttemptReceipt(source.value, 'reserved')
    try {
      await reserveCandidateDevelopmentLocalReceipt(legacyReceiptPath, reserved, 20)

      expect(
        JSON.parse(
          await readFile(join(directory, 'bayn', 'candidate-development-attempts', 'ordinal-20.json'), 'utf8'),
        ),
      ).toMatchObject({ status: 'reserved', attempt: 1 })
      expect(JSON.parse(await readFile(legacyReceiptPath, 'utf8'))).toMatchObject({ status: 'reserved', attempt: 1 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
