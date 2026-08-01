import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeCandidateDevelopmentLocalAttemptReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  validateCandidateDevelopmentLocalSourceBinding,
  type CandidateDevelopmentLocalAttemptReceipt,
} from './contract'
import {
  runCandidateDevelopmentLocally,
  finalizeCandidateDevelopmentLocalReceipt,
  reserveCandidateDevelopmentLocalReceipt,
  type CandidateDevelopmentLocalDependencies,
  type CandidateDevelopmentLocalProcessRequest,
  type CandidateDevelopmentLocalSourceResolution,
} from './command'

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
      },
    ])
    expect(fixture.receipts.map(({ status }) => status)).toEqual(['reserved', 'completed'])
    expect(result.receipt.status).toBe('completed')
    expect(JSON.stringify(result.receipt)).not.toContain('/sealed/typed-runtime-market-data.json')
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
})
