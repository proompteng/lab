import {
  listMemoryNotesFromAgentsService,
  parseMemoryNoteFilters,
  parseRetrieveMemoryNotesInput,
  retrieveMemoryNotesFromAgentsService,
} from '@proompteng/agent-contracts'

import { getFlagValue, parseCliFlags, parseCommaList, resolveAgentsBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const supported = new Set([
  'query',
  'query-file',
  'latest',
  'task-name',
  'repository',
  'tags',
  'model',
  'after',
  'before',
  'include-retired',
  'limit',
  'json',
])
for (const key of Object.keys(flags)) {
  if (!supported.has(key)) throw new Error(`unsupported flag --${key}`)
}
const queryFile = getFlagValue(flags, 'query-file')
const query = getFlagValue(flags, 'query') ?? (queryFile ? await Bun.file(queryFile).text() : '')
const latest = flags.latest === true
if (latest && (query || queryFile)) throw new Error('--latest cannot be combined with a query')
const input = {
  query,
  namespace: getFlagValue(flags, 'task-name'),
  repository: getFlagValue(flags, 'repository'),
  tags: parseCommaList(getFlagValue(flags, 'tags')),
  model: getFlagValue(flags, 'model'),
  createdAfter: getFlagValue(flags, 'after'),
  createdBefore: getFlagValue(flags, 'before'),
  includeRetired: flags['include-retired'] === true,
  limit: getFlagValue(flags, 'limit') ?? 5,
}
const parsed = latest ? parseMemoryNoteFilters(input, 5) : parseRetrieveMemoryNotesInput(input, 5)
if (!parsed.ok) throw new Error(parsed.message)
const env = { ...process.env, AGENTS_SERVICE_BASE_URL: resolveAgentsBaseUrl() }
const response = latest
  ? await listMemoryNotesFromAgentsService(parsed.value, env)
  : await retrieveMemoryNotesFromAgentsService({ ...parsed.value, query: query.trim() }, env)
if (!response.ok) throw new Error(`Agents memory retrieve failed (${response.status}): ${response.error}`)
if (!response.body.ok) throw new Error('Agents memory API did not return success')
const rows = response.body.memories ?? []
if (flags.json === true) {
  console.log(JSON.stringify(response.body, null, 2))
} else if (!rows.length) {
  console.log('no memories matched your request')
} else {
  rows.forEach((row, index) => {
    console.log(`\n[${index + 1}] ${row.namespace} (${row.id})`)
    console.log(`  created: ${row.createdAt}`)
    console.log(
      `  repository: ${row.metadata.repository ?? 'unrecorded'}; commit: ${row.metadata.commit ?? 'unrecorded'}; model: ${row.metadata.noteModel ?? 'unrecorded'}`,
    )
    console.log(`  summary: ${row.summary ?? ''}`)
    console.log(`  tags: ${row.tags.join(', ')}`)
    if (row.distance != null) console.log(`  distance: ${row.distance.toFixed(4)}`)
    if (row.retiredAt)
      console.log(
        `  retired: ${row.retiredAt}; reason: ${row.retirementReason}; replacement: ${row.replacementId ?? 'none'}`,
      )
    console.log(
      `  content: ${row.content.slice(0, 4_000)}${row.content.length > 4_000 ? '\n[truncated; use --json for full content]' : ''}`,
    )
  })
}
