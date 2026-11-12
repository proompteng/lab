import {
  getMemoryNoteFromAgentsService,
  readMemoryNote,
  listMemoryNotesFromAgentsService,
  parseListMemoryNotesInput,
  parseRetrieveMemoryNotesInput,
  retrieveMemoryNotesFromAgentsService,
  type AgentsMemoryNoteRecord,
} from '@proompteng/agent-contracts'
import { getFlagValue, parseCliFlags, parseCommaList, resolveAgentsBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const supported = new Set([
  'query',
  'query-file',
  'latest',
  'id',
  'cursor',
  'offset',
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
for (const key of Object.keys(flags)) if (!supported.has(key)) throw new Error(`unsupported flag --${key}`)
const queryFile = getFlagValue(flags, 'query-file')
const query = getFlagValue(flags, 'query') ?? (queryFile ? await Bun.file(queryFile).text() : '')
const id = getFlagValue(flags, 'id')
const latest = flags.latest === true
if ((latest && (query || queryFile || id)) || (id && (query || queryFile)))
  throw new Error('Choose one of --latest, --id or --query')
if (flags.cursor !== undefined && !latest) throw new Error('--cursor requires --latest')
if (flags.offset !== undefined && !id) throw new Error('--offset requires --id')
if (flags.offset === true) throw new Error('--offset requires a value')
const env = { ...process.env, AGENTS_SERVICE_BASE_URL: resolveAgentsBaseUrl() }
const filters = {
  namespace: getFlagValue(flags, 'task-name'),
  repository: getFlagValue(flags, 'repository'),
  tags: parseCommaList(getFlagValue(flags, 'tags')),
  model: getFlagValue(flags, 'model'),
  createdAfter: getFlagValue(flags, 'after'),
  createdBefore: getFlagValue(flags, 'before'),
  includeRetired: flags['include-retired'] === true,
  limit: getFlagValue(flags, 'limit') ?? 5,
}
const printNote = (row: AgentsMemoryNoteRecord) => {
  console.log(
    `\n${row.namespace} (${row.id})\ncreated: ${row.createdAt}\nrepository: ${row.metadata.repository ?? 'unrecorded'}; commit: ${row.metadata.commit ?? 'unrecorded'}; model: ${row.metadata.noteModel ?? 'unrecorded'}\nsummary: ${row.summary ?? ''}\ntags: ${row.tags.join(', ')}`,
  )
  if (row.retiredAt)
    console.log(
      `retired: ${row.retiredAt}; reason: ${row.retirementReason}; replacement: ${row.replacementId ?? 'none'}`,
    )
  console.log(row.content.slice(0, 4000))
  if (row.content.length > 4000) console.log(`[truncated; use --id ${row.id} for full content]`)
}
if (latest) {
  const parsed = parseListMemoryNotesInput({ ...filters, cursor: getFlagValue(flags, 'cursor') }, 5)
  if (!parsed.ok) throw new Error(parsed.message)
  const response = await listMemoryNotesFromAgentsService(parsed.value, env)
  if (!response.ok) throw new Error(`Agents memory list failed (${response.status}): ${response.error}`)
  const page = response.body
  if (flags.json === true) console.log(JSON.stringify(page))
  else {
    for (const note of page.memories)
      console.log(
        `\n${note.id} · ${note.createdAt}\n${note.summary}${note.summaryTruncated ? ' [summary truncated]' : ''}\nrepository: ${note.repository ?? 'unrecorded'}; commit: ${note.commit ?? 'unrecorded'}`,
      )
    if (!page.memories.length) console.log('no memories matched your request')
    if (page.nextCursor) console.log(`\nnext page: repeat these filters with --cursor ${page.nextCursor}`)
  }
} else if (id) {
  const response = await getMemoryNoteFromAgentsService(id, env)
  if (!response.ok) throw new Error(`Agents memory read failed (${response.status}): ${response.error}`)
  if (!response.body.memory) throw new Error('Agents memory API returned no note')
  const page = readMemoryNote(response.body.memory, Number(getFlagValue(flags, 'offset') ?? 0))
  if (flags.json === true) console.log(JSON.stringify(page))
  else {
    console.log(
      `\n${page.memory.id} · ${page.memory.createdAt}\n${page.memory.summary}\nrepository: ${page.memory.repository ?? 'unrecorded'}; commit: ${page.memory.commit ?? 'unrecorded'}; model: ${page.memory.model ?? 'unrecorded'}`,
    )
    if (page.memory.retiredAt)
      console.log(
        `retired: ${page.memory.retiredAt}; reason: ${page.memory.retirementReason}; replacement: ${page.memory.replacementId ?? 'none'}`,
      )
    console.log(page.content)
    if (page.nextOffset !== null) console.log(`\nnext chunk: --id ${id} --offset ${page.nextOffset}`)
  }
} else {
  const parsed = parseRetrieveMemoryNotesInput({ ...filters, query }, 5)
  if (!parsed.ok) throw new Error(parsed.message)
  const response = await retrieveMemoryNotesFromAgentsService(parsed.value, env)
  if (!response.ok) throw new Error(`Agents memory retrieve failed (${response.status}): ${response.error}`)
  if (!response.body.ok) throw new Error('Agents memory API did not return success')
  if (flags.json === true) console.log(JSON.stringify(response.body))
  else {
    const rows = response.body.memories ?? []
    if (!rows.length) console.log('no memories matched your request')
    for (const note of rows) printNote(note)
  }
}
