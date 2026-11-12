import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { calendarTargets, compileCalendar, requireDate, type TargetSplit } from './cosmosalpha-calendar-targets'

type SourceInput = { root: 'market' | 'masks'; path: string; sha256: string; sizeBytes: number }
type Request = { marketRoot: string; maskRoot: string; fromDate: string; splits: TargetSplit[] }
type Interval = { first: string; last: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a nonempty string`)
  return value
}
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const decodeRequest = (path: string): Request => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(value) || value.schemaVersion !== 'bayn.cosmosalpha-calendar-target-request.v1')
    throw new Error('Unsupported target request')
  if (
    Object.keys(value).some((key) => !['schemaVersion', 'marketRoot', 'maskRoot', 'fromDate', 'splits'].includes(key))
  )
    throw new Error('Unknown target request field')
  if (!Array.isArray(value.splits)) throw new Error('splits must be an array')
  const splits = value.splits.map((raw: unknown): TargetSplit => {
    if (!isObject(raw) || !['name', 'startDate', 'endDate'].every((key) => key in raw) || Object.keys(raw).length !== 3)
      throw new Error('Invalid split fields')
    if (raw.name !== 'train' && raw.name !== 'validation' && raw.name !== 'test') throw new Error('Invalid split name')
    return { name: raw.name, startDate: string(raw.startDate, 'startDate'), endDate: string(raw.endDate, 'endDate') }
  })
  return {
    marketRoot: resolve(dirname(path), string(value.marketRoot, 'marketRoot')),
    maskRoot: resolve(dirname(path), string(value.maskRoot, 'maskRoot')),
    fromDate: requireDate(string(value.fromDate, 'fromDate')),
    splits,
  }
}

const lines = (bytes: Buffer) => bytes.toString('utf8').trimEnd().split(/\r?\n/)

export const decodeQlibSeries = (bytes: Buffer, calendarLength: number): Float64Array => {
  if (bytes.length < 4 || bytes.length % 4 !== 0) throw new Error('Invalid float32 Qlib series length')
  const offset = bytes.readFloatLE(0)
  const count = bytes.length / 4 - 1
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > calendarLength)
    throw new Error('Qlib series offset or extent exceeds calendar')
  const values = new Float64Array(calendarLength).fill(Number.NaN)
  for (let index = 0; index < count; index += 1) values[offset + index] = bytes.readFloatLE((index + 1) * 4)
  return values
}

const mask = (value: number): 0 | 1 | null => {
  if (!Number.isFinite(value)) return null
  if (value !== 0 && value !== 1) throw new Error('Mask must be zero, one or unknown')
  return value
}

export const generateCosmosalphaTargets = (requestPath: string, outputDirectory: string) => {
  const request = decodeRequest(resolve(requestPath))
  const inputs: SourceInput[] = []
  const read = (root: 'market' | 'masks', path: string) => {
    const bytes = readFileSync(resolve(root === 'market' ? request.marketRoot : request.maskRoot, path))
    inputs.push({ root, path, sha256: digest(bytes), sizeBytes: bytes.length })
    return bytes
  }
  const calendar = lines(read('market', 'calendars/day.txt'))
  const maskCalendar = lines(read('masks', 'calendars/day.txt'))
  if (JSON.stringify(calendar) !== JSON.stringify(maskCalendar)) throw new Error('Market and mask calendars differ')
  const layout = compileCalendar(calendar, request.splits)
  const firstDate = calendar[0]
  const firstSplit = request.splits[0]
  const lastSplit = request.splits.at(-1)
  if (
    !firstDate ||
    !firstSplit ||
    !lastSplit ||
    request.fromDate < firstDate ||
    request.fromDate > firstSplit.startDate
  )
    throw new Error('fromDate must cover warmup through the first split')
  const membership = new Map<string, Interval[]>()
  for (const line of lines(read('market', 'instruments/csi300.txt'))) {
    const [symbol, first, last, extra] = line.trim().split(/\s+/)
    if (!symbol || !/^(?:sh|sz)\d{6}$/.test(symbol) || !first || !last || extra)
      throw new Error('Invalid CSI300 membership row')
    requireDate(first)
    requireDate(last)
    if (first > last) throw new Error('Invalid membership interval')
    const intervals = membership.get(symbol) ?? []
    intervals.push({ first, last })
    membership.set(symbol, intervals)
  }
  const generatorSources = ['cosmosalpha-calendar-targets.ts', 'generate-cosmosalpha-targets.ts'].map((path) => ({
    path,
    sha256: digest(readFileSync(resolve(import.meta.dir, path))),
  }))
  const output = resolve(outputDirectory)
  mkdirSync(output)
  const partial = resolve(output, 'targets.csv.partial')
  const fd = openSync(partial, 'wx')
  const targetHash = createHash('sha256')
  let rows = 0
  let instruments = 0
  let eligibleRows = 0
  let unknownEligibleRows = 0
  let labeledRows = 0
  let eligibleLabeledRows = 0
  const statuses: Record<string, number> = {}
  const splitRows: Record<string, number> = {}
  const write = (text: string) => {
    writeFileSync(fd, text)
    targetHash.update(text)
  }
  try {
    write('instrument,date,split,universe,eligible,target_date,horizon_sessions,forward_return,status\n')
    for (const [symbol, intervals] of [...membership].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const selected = calendar.flatMap((date, index) =>
        date >= request.fromDate &&
        date <= lastSplit.endDate &&
        intervals.some(({ first, last }) => first <= date && date <= last)
          ? [index]
          : [],
      )
      if (selected.length === 0) continue
      const closes = decodeQlibSeries(read('market', `features/${symbol}/close.day.bin`), calendar.length)
      const eligible = decodeQlibSeries(read('masks', `features/${symbol}/eligible_mask.day.bin`), calendar.length)
      const universe = decodeQlibSeries(read('masks', `features/${symbol}/universe_mask.day.bin`), calendar.length)
      const targets = calendarTargets(layout, closes)
      const block: string[] = []
      for (const index of selected) {
        const target = targets[index]
        const date = calendar[index]
        if (!target || !date) throw new Error('Projected row is outside calendar')
        const eligibleValue = mask(eligible[index])
        const universeValue = mask(universe[index])
        rows += 1
        eligibleRows += eligibleValue === 1 ? 1 : 0
        unknownEligibleRows += eligibleValue === null ? 1 : 0
        labeledRows += target.status === 'ok' ? 1 : 0
        eligibleLabeledRows += target.status === 'ok' && eligibleValue === 1 ? 1 : 0
        statuses[target.status] = (statuses[target.status] ?? 0) + 1
        const split = target.split ?? 'outside'
        splitRows[split] = (splitRows[split] ?? 0) + 1
        block.push(
          [
            symbol,
            date,
            target.split ?? '',
            universeValue ?? '',
            eligibleValue ?? '',
            target.endpoint === null ? '' : calendar[target.endpoint.index],
            target.endpoint?.sessions ?? '',
            target.value ?? '',
            target.status,
          ].join(',') + '\n',
        )
      }
      write(block.join(''))
      instruments += 1
    }
  } finally {
    closeSync(fd)
  }
  if (rows === 0) throw new Error('No membership rows were generated')
  inputs.sort((a, b) =>
    `${a.root}:${a.path}` < `${b.root}:${b.path}` ? -1 : `${a.root}:${a.path}` > `${b.root}:${b.path}` ? 1 : 0,
  )
  const identity = {
    schemaVersion: 'bayn.cosmosalpha-calendar-targets.v1',
    rule: {
      endpoint: 'first-finite-close-in-split',
      currentAndEndpointMustBePositive: true,
      compressionLimit: 0.1,
      compressWhenSessionGapExceeds: 1,
    },
    window: { fromDate: request.fromDate, splits: request.splits },
    inputs,
    generatorSources,
    targets: {
      file: 'targets.csv',
      sha256: targetHash.digest('hex'),
      rows,
      instruments,
      eligibleRows,
      unknownEligibleRows,
      labeledRows,
      eligibleLabeledRows,
      statuses,
      splitRows,
    },
  }
  const targetId = digest(JSON.stringify(identity))
  renameSync(partial, resolve(output, 'targets.csv'))
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ targetId, identity }, null, 2) + '\n', {
    flag: 'wx',
  })
  return { targetId, outputDirectory: output, ...identity.targets }
}

if (import.meta.main) {
  const [request, output, extra] = process.argv.slice(2)
  if (request === '--help')
    process.stdout.write('Usage: bun generate-cosmosalpha-targets.ts REQUEST_JSON FRESH_OUTPUT_DIRECTORY\n')
  else {
    if (!request || !output || extra) throw new Error('Expected request JSON and a fresh output directory')
    process.stdout.write(JSON.stringify(generateCosmosalphaTargets(request, output)) + '\n')
  }
}
