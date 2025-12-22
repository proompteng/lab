import { getFlagValue, parseCliFlags, parseCommaList, parseJson, resolveJangarBaseUrl } from './cli'

const flags = parseCliFlags(process.argv.slice(2))

const taskName = getFlagValue(flags, 'task-name')
if (!taskName) {
  throw new Error('task-name is required')
}

const contentValue = getFlagValue(flags, 'content')
const contentFile = getFlagValue(flags, 'content-file')

if (!contentValue && !contentFile) {
  throw new Error('either --content or --content-file is required')
}

let content: string
if (contentValue) {
  content = contentValue
} else if (contentFile) {
  content = await Bun.file(contentFile).text()
} else {
  throw new Error('either --content or --content-file is required')
}
if (!content.trim()) {
  throw new Error('content cannot be empty')
}

const summary = getFlagValue(flags, 'summary') ?? content.trim().slice(0, 300)
const tags = parseCommaList(getFlagValue(flags, 'tags'))
const metadata = parseJson(getFlagValue(flags, 'metadata'))

const ignoredFlags: Array<[string, string | undefined]> = [
  ['description', getFlagValue(flags, 'description')],
  ['repository-ref', getFlagValue(flags, 'repository-ref')],
  ['repository-commit', getFlagValue(flags, 'repository-commit')],
  ['repository-path', getFlagValue(flags, 'repository-path')],
  ['execution-id', getFlagValue(flags, 'execution-id')],
  ['source', getFlagValue(flags, 'source')],
  ['metadata', Object.keys(metadata).length ? 'provided' : undefined],
  ['model', getFlagValue(flags, 'model')],
  ['encoder-version', getFlagValue(flags, 'encoder-version')],
]

const ignored = ignoredFlags.filter(([, value]) => value)
if (ignored.length > 0) {
  const names = ignored.map(([name]) => `--${name}`).join(', ')
  console.warn(`Ignoring unused flags for Jangar REST: ${names}`)
}

const baseUrl = resolveJangarBaseUrl()
const endpoint = new URL('/api/memories', baseUrl).toString()

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    namespace: taskName,
    content,
    summary,
    tags,
  }),
})

if (!response.ok) {
  const body = await response.text()
  throw new Error(`Jangar memory save failed (${response.status}): ${body}`)
}

const payload = (await response.json()) as { ok?: boolean; memory?: { id?: string } }
const memoryId = payload.memory?.id ?? 'unknown'
console.log(`saved memory ${memoryId} (${taskName})`)
