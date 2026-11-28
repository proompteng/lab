import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeQlibSeries, generateCosmosalphaTargets } from './generate-cosmosalpha-targets'

let root: string
const days = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07']
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'calendar-targets-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const binary = (values: number[], offset = 0) => {
  const bytes = Buffer.alloc((values.length + 1) * 4)
  bytes.writeFloatLE(offset, 0)
  values.forEach((value, index) => bytes.writeFloatLE(value, (index + 1) * 4))
  return bytes
}

const fixture = (
  name = 'inputs',
  membership = 'sh600176\t2020-01-02\t2020-01-02\nsh600176\t2020-01-07\t2020-01-07\n',
) => {
  const base = join(root, name)
  for (const role of ['market', 'masks']) {
    mkdirSync(join(base, role, 'calendars'), { recursive: true })
    mkdirSync(join(base, role, 'features/sh600176'), { recursive: true })
    writeFileSync(join(base, role, 'calendars/day.txt'), days.join('\n') + '\n')
  }
  mkdirSync(join(base, 'market/instruments'))
  writeFileSync(join(base, 'market/instruments/csi300.txt'), membership)
  writeFileSync(join(base, 'market/features/sh600176/close.day.bin'), binary([100, 101, Number.NaN, 180]))
  writeFileSync(join(base, 'masks/features/sh600176/eligible_mask.day.bin'), binary([1, 1, 1, 1]))
  writeFileSync(join(base, 'masks/features/sh600176/universe_mask.day.bin'), binary([1, 1, 1, 1]))
  const request = join(base, 'request.json')
  writeFileSync(
    request,
    JSON.stringify({
      schemaVersion: 'bayn.cosmosalpha-calendar-target-request.v1',
      marketRoot: 'market',
      maskRoot: 'masks',
      fromDate: days[0],
      splits: [{ name: 'train', startDate: days[0], endDate: days[3] }],
    }),
  )
  return request
}

const verify = (request: string, output: string) =>
  Bun.spawnSync(['python3', join(import.meta.dir, 'verify-cosmosalpha-targets.py'), request, output])

describe('calendar-target artifact generation and independent verification', () => {
  test('CLI fixes an index gap and the independent verifier checks every projected row', () => {
    const request = fixture()
    const output = join(root, 'targets')
    const child = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, 'generate-cosmosalpha-targets.ts'),
      request,
      output,
    ])
    expect(child.exitCode).toBe(0)
    const csv = readFileSync(join(output, 'targets.csv'), 'utf8')
    expect(csv).toContain('sh600176,2020-01-02,train,1,1,2020-01-03,1,0.010000000000000009,ok')
    expect(csv).toContain('sh600176,2020-01-07,train,1,1,,,,cutoff')
    const checked = verify(request, output)
    expect(checked.exitCode).toBe(0)
    const report = JSON.parse(checked.stdout.toString())
    expect(report.unexplainedMismatches).toBe(0)
    expect(report.rows).toBe(2)
    expect(report.sourceFilesVerified).toBe(6)
  })

  test('artifact identity is reproducible across paths and refuses overwrites', () => {
    const first = fixture('one')
    const second = fixture('two')
    const a = join(root, 'a')
    const b = join(root, 'b')
    expect(generateCosmosalphaTargets(first, a).targetId).toBe(generateCosmosalphaTargets(second, b).targetId)
    const original = readFileSync(join(a, 'manifest.json'), 'utf8')
    expect(() => generateCosmosalphaTargets(first, a)).toThrow()
    expect(readFileSync(join(a, 'manifest.json'), 'utf8')).toBe(original)
  })

  test('independent verification detects a wrong target even after output hashes are resealed', () => {
    const request = fixture()
    const output = join(root, 'tamper')
    generateCosmosalphaTargets(request, output)
    const csvPath = join(output, 'targets.csv')
    const changed = readFileSync(csvPath, 'utf8').replace('0.010000000000000009,ok', '0.25,ok')
    writeFileSync(csvPath, changed)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    manifest.identity.targets.sha256 = sha(changed)
    manifest.targetId = sha(JSON.stringify(manifest.identity))
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const checked = verify(request, output)
    expect(checked.exitCode).toBe(1)
    expect(JSON.parse(checked.stdout.toString()).unexplainedMismatches).toBe(1)
  })

  test('independent coverage verification rejects a dropped row with resealed counts and hashes', () => {
    const request = fixture()
    const output = join(root, 'missing')
    generateCosmosalphaTargets(request, output)
    const csvPath = join(output, 'targets.csv')
    const changed = readFileSync(csvPath, 'utf8').split('\n').slice(0, 2).join('\n') + '\n'
    writeFileSync(csvPath, changed)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    manifest.identity.targets.sha256 = sha(changed)
    manifest.identity.targets.rows = 1
    manifest.targetId = sha(JSON.stringify(manifest.identity))
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const checked = verify(request, output)
    expect(checked.exitCode).toBe(1)
    expect(JSON.parse(checked.stdout.toString()).unexplainedMismatches).toBeGreaterThan(0)
  })

  test('unknown eligibility is retained and malformed masks never produce a manifest', () => {
    const request = fixture()
    const maskPath = join(root, 'inputs/masks/features/sh600176/eligible_mask.day.bin')
    writeFileSync(maskPath, binary([Number.NaN, 1, 1, 1]))
    const result = generateCosmosalphaTargets(request, join(root, 'unknown'))
    expect(result.unknownEligibleRows).toBe(1)
    expect(verify(request, join(root, 'unknown')).exitCode).toBe(0)
    writeFileSync(maskPath, binary([0.5, 1, 1, 1]))
    expect(() => generateCosmosalphaTargets(request, join(root, 'bad-mask'))).toThrow('Mask must')
    expect(existsSync(join(root, 'bad-mask/manifest.json'))).toBe(false)
  })

  test('full CLI output respects split cutoffs and remains invariant to later split prices', () => {
    const request = fixture('split', 'sh600176\t2020-01-02\t2020-01-07\n')
    const spec = JSON.parse(readFileSync(request, 'utf8'))
    spec.splits = [
      { name: 'train', startDate: days[0], endDate: '2020-01-05' },
      { name: 'test', startDate: days[2], endDate: days[3] },
    ]
    writeFileSync(request, JSON.stringify(spec))
    const prices = join(root, 'split/market/features/sh600176/close.day.bin')
    writeFileSync(prices, binary([100, 110, 200, 220]))
    const first = join(root, 'split-first')
    generateCosmosalphaTargets(request, first)
    expect(verify(request, first).exitCode).toBe(0)
    const prefix = readFileSync(join(first, 'targets.csv'), 'utf8').split('\n').slice(1, 3)
    expect(prefix[1]).toBe('sh600176,2020-01-03,train,1,1,,,,cutoff')
    writeFileSync(prices, binary([100, 110, 999999, Number.NaN]))
    const second = join(root, 'split-second')
    generateCosmosalphaTargets(request, second)
    expect(verify(request, second).exitCode).toBe(0)
    expect(readFileSync(join(second, 'targets.csv'), 'utf8').split('\n').slice(1, 3)).toEqual(prefix)
  })

  test('source identity changes are detected even when projected target values stay the same', () => {
    const request = fixture()
    const output = join(root, 'source-drift')
    generateCosmosalphaTargets(request, output)
    writeFileSync(join(root, 'inputs/market/features/sh600176/close.day.bin'), binary([100, 101, Number.NaN, 181]))
    const checked = verify(request, output)
    expect(checked.exitCode).not.toBe(0)
    expect(checked.stderr.toString()).toContain('Recorded input inventory differs')
  })

  test('validates Qlib binary extents instead of silently realigning them', () => {
    expect(Number.isNaN(decodeQlibSeries(binary([100], 1), 4)[0])).toBe(true)
    expect(decodeQlibSeries(binary([100], 1), 4)[1]).toBe(100)
    expect(() => decodeQlibSeries(binary([100], 0.5), 4)).toThrow()
    expect(() => decodeQlibSeries(binary([100], 4), 4)).toThrow()
    expect(() => decodeQlibSeries(Buffer.alloc(3), 4)).toThrow()
  })

  test('verification rejects a resealed manifest pointing at another target filename', () => {
    const request = fixture()
    const output = join(root, 'wrong-file')
    generateCosmosalphaTargets(request, output)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    manifest.identity.targets.file = 'unverified.csv'
    manifest.targetId = sha(JSON.stringify(manifest.identity))
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const checked = verify(request, output)
    expect(checked.exitCode).not.toBe(0)
    expect(checked.stderr.toString()).toContain('Unexpected target filename')
  })

  test('verification rejects an invalid unprojected calendar date even with resealed inputs', () => {
    const request = fixture()
    const output = join(root, 'invalid-calendar')
    generateCosmosalphaTargets(request, output)
    const changed = days.join('\n').replace('2020-01-06', '2020-01-06x') + '\n'
    for (const role of ['market', 'masks']) writeFileSync(join(root, 'inputs', role, 'calendars/day.txt'), changed)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    for (const input of manifest.identity.inputs) {
      if (input.path === 'calendars/day.txt') {
        input.sha256 = sha(changed)
        input.sizeBytes = Buffer.byteLength(changed)
      }
    }
    manifest.targetId = sha(JSON.stringify(manifest.identity))
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const checked = verify(request, output)
    expect(checked.exitCode).not.toBe(0)
    expect(checked.stderr.toString()).toContain('Invalid source date')
  })

  test('an empty panel cannot be resealed into a zero-mismatch proof', () => {
    const request = fixture()
    const output = join(root, 'empty-proof')
    generateCosmosalphaTargets(request, output)
    writeFileSync(join(root, 'inputs/market/instruments/csi300.txt'), '')
    const csvPath = join(output, 'targets.csv')
    const header = readFileSync(csvPath, 'utf8').split('\n')[0] + '\n'
    writeFileSync(csvPath, header)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    manifest.identity.inputs = manifest.identity.inputs.filter(
      (input: { path: string }) => !input.path.startsWith('features/'),
    )
    for (const input of manifest.identity.inputs) {
      if (input.path === 'instruments/csi300.txt') {
        input.sha256 = sha('')
        input.sizeBytes = 0
      }
    }
    Object.assign(manifest.identity.targets, {
      sha256: sha(header),
      rows: 0,
      instruments: 0,
      eligibleRows: 0,
      unknownEligibleRows: 0,
      labeledRows: 0,
      eligibleLabeledRows: 0,
      statuses: {},
      splitRows: {},
    })
    manifest.targetId = sha(JSON.stringify(manifest.identity))
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const checked = verify(request, output)
    expect(checked.exitCode).not.toBe(0)
    expect(checked.stderr.toString()).toContain('No membership rows to verify')
  })
})
