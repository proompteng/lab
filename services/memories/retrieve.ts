import { getFlagValue, parseCliFlags, parseCommaList, resolveJangarBaseUrl } from './cli'

type MemoryRecord = {
  id: string
  namespace: string
  summary: string | null
  content: string
  tags: string[]
  metadata?: Record<string, unknown>
  distance?: number
}

const flags = parseCliFlags(process.argv.slice(2))

const queryValue = getFlagValue(flags, 'query')
const queryFile = getFlagValue(flags, 'query-file')

if (!queryValue && !queryFile) {
  throw new Error('either --query or --query-file is required')
}

let queryText: string
if (queryValue) {
  queryText = queryValue
} else if (queryFile) {
  queryText = await Bun.file(queryFile).text()
} else {
  throw new Error('either --query or --query-file is required')
}
if (!queryText.trim()) {
  throw new Error('query text cannot be empty')
}

const repositoryRef = getFlagValue(flags, 'repository-ref')
const source = getFlagValue(flags, 'source')
const taskName = getFlagValue(flags, 'task-name')
const tags = parseCommaList(getFlagValue(flags, 'tags'))
const limitRaw = Number(getFlagValue(flags, 'limit') ?? '5')
if (Number.isNaN(limitRaw)) {
  throw new Error('--limit must be a positive number')
}
const limit = Math.max(1, Math.floor(limitRaw))

const ignoredFlags: Array<[string, string | undefined]> = [
  ['repository-ref', repositoryRef],
  ['source', source],
  ['tags', tags.length ? 'provided' : undefined],
]

const ignored = ignoredFlags.filter(([, value]) => value)
if (ignored.length > 0) {
  const names = ignored.map(([name]) => `--${name}`).join(', ')
  console.warn(`Ignoring unused flags for Jangar REST: ${names}`)
}

const baseUrl = resolveJangarBaseUrl()
const endpoint = new URL('/api/memories', baseUrl)
endpoint.searchParams.set('query', queryText)
if (taskName) {
  endpoint.searchParams.set('namespace', taskName)
}
endpoint.searchParams.set('limit', String(limit))

const response = await fetch(endpoint.toString(), {
  method: 'GET',
  headers: { accept: 'application/json' },
})

if (!response.ok) {
  const body = await response.text()
  throw new Error(`Jangar memory retrieve failed (${response.status}): ${body}`)
}

const payload = (await response.json()) as { ok?: boolean; memories?: MemoryRecord[] }
const rows = payload.memories ?? []

if (!rows.length) {
  console.log('no memories matched your query')
} else {
  rows.forEach((row, index) => {
    console.log(`\n[${index + 1}] ${row.namespace} (${row.id})`)
    console.log(`  summary: ${row.summary ?? ''}`)
    console.log(`  tags: ${Array.isArray(row.tags) ? row.tags.join(', ') : ''}`)
    if (row.distance != null) {
      console.log(`  distance: ${Number(row.distance).toFixed(4)}`)
    }
    console.log(`  content preview: ${String(row.content).slice(0, 200).replace(/\s+/g, ' ')}\n`)
  })
}
