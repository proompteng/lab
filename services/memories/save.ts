import { spawnSync } from 'node:child_process'
import { parsePersistMemoryNoteInput, persistMemoryNoteToAgentsService } from '@proompteng/agent-contracts'
import { getFlagValue, parseCliFlags, parseCommaList, resolveAgentsBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))
const supported = new Set(['task-name', 'content', 'content-file', 'summary', 'tags', 'repository', 'commit', 'json'])
for (const key of Object.keys(flags)) if (!supported.has(key)) throw new Error(`unsupported flag --${key}`)
const namespace = getFlagValue(flags, 'task-name')
if (!namespace) throw new Error('task-name is required')
const file = getFlagValue(flags, 'content-file')
const content = getFlagValue(flags, 'content') ?? (file ? await Bun.file(file).text() : '')
const repository = getFlagValue(flags, 'repository') ?? 'proompteng/lab'
const checkout = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const commit = (getFlagValue(flags, 'commit') ?? checkout.stdout?.trim() ?? '').toLowerCase()
if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.length > 200) throw new Error('repository must be owner/name')
if (!/^[0-9a-f]{40}$/.test(commit))
  throw new Error('Provide --commit with a full Git SHA or run inside the source checkout')
const parsed = parsePersistMemoryNoteInput({
  namespace,
  content,
  summary: getFlagValue(flags, 'summary'),
  tags: parseCommaList(getFlagValue(flags, 'tags')),
  metadata: { repository, commit },
})
if (!parsed.ok) throw new Error(parsed.message)
const response = await persistMemoryNoteToAgentsService(parsed.value, {
  ...process.env,
  AGENTS_SERVICE_BASE_URL: resolveAgentsBaseUrl(),
})
if (!response.ok) throw new Error(`Agents memory save failed (${response.status}): ${response.error}`)
const note = response.body.memory
if (!response.body.ok || !note) throw new Error('Agents memory API returned no saved note')
const receipt = { id: note.id, createdAt: note.createdAt, retiredAt: note.retiredAt, replacementId: note.replacementId }
console.log(
  flags.json === true
    ? JSON.stringify({ ok: true, memory: receipt })
    : `saved memory ${note.id} (${note.namespace})${note.retiredAt ? ' [retired; use its replacement or save corrected knowledge]' : ''}`,
)
