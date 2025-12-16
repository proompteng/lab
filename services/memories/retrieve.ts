import { SQL } from 'bun'
import {
  DEFAULT_DATABASE_URL,
  getFlagValue,
  parseCliFlags,
  parseCommaList,
  toPgTextArray,
  vectorToPgArray,
} from './cli'

type MemoryRow = {
  id: string
  task_name: string
  summary: string
  content: string
  metadata: Record<string, unknown>
  tags: string[]
  source: string
  repository_ref: string
  repository_commit: string | null
  repository_path: string | null
  encoder_model: string
  encoder_version: string | null
  distance: number
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

const encoderModel = getFlagValue(flags, 'model') ?? process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
const openAiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY?.trim()
const expectedDimension = parseInt(process.env.OPENAI_EMBEDDING_DIMENSION ?? '1536', 10)
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

if (!apiKey && isHostedOpenAiBaseUrl(openAiBaseUrl)) {
  throw new Error(
    'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
  )
}

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
}
if (apiKey) {
  headers.Authorization = `Bearer ${apiKey}`
}

const embedResponse = await fetch(`${openAiBaseUrl}/embeddings`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: encoderModel, input: queryText }),
})

if (!embedResponse.ok) {
  const body = await embedResponse.text()
  throw new Error(`embedding request failed (${embedResponse.status}): ${body}`)
}

const embedJson = (await embedResponse.json()) as { data?: { embedding?: number[] }[] } & {
  model?: string
}
const embedding = embedJson.data?.[0]?.embedding
if (!embedding || !Array.isArray(embedding)) {
  throw new Error('embedding response missing data[0].embedding')
}

if (embedding.length !== expectedDimension) {
  throw new Error(
    `embedding dimension mismatch: expected ${expectedDimension} but received ${embedding.length}.` +
      ' Adjust OPENAI_EMBEDDING_DIMENSION or model to create embeddings with the matching dimension.',
  )
}

const vectorString = vectorToPgArray(embedding)
const repositoryRef = getFlagValue(flags, 'repository-ref')
const source = getFlagValue(flags, 'source')
const taskName = getFlagValue(flags, 'task-name')
const tags = parseCommaList(getFlagValue(flags, 'tags'))
const limitRaw = Number(getFlagValue(flags, 'limit') ?? '5')
if (Number.isNaN(limitRaw)) {
  throw new Error('--limit must be a positive number')
}
const limit = Math.max(1, Math.floor(limitRaw))

const db = new SQL(databaseUrl)

const params: unknown[] = []
const pushParam = (value: unknown) => {
  params.push(value)
  return `$${params.length}`
}

const tagsArrayLiteral = tags.length ? toPgTextArray(tags) : undefined
const conditions: string[] = ['TRUE']
if (repositoryRef) {
  conditions.push(`repository_ref = ${pushParam(repositoryRef)}`)
}
if (source) {
  conditions.push(`source = ${pushParam(source)}`)
}
if (taskName) {
  conditions.push(`task_name = ${pushParam(taskName)}`)
}
if (tags.length && tagsArrayLiteral) {
  conditions.push(`tags && ${pushParam(tagsArrayLiteral)}::text[]`)
}
const vectorParam = pushParam(vectorString)
const limitParam = pushParam(limit)

const querySql = `
  SELECT
    id,
    task_name,
    summary,
    content,
    metadata,
    tags,
    source,
    repository_ref,
    repository_commit,
    repository_path,
    encoder_model,
    encoder_version,
    embedding <=> ${vectorParam}::vector AS distance
  FROM memories.entries
  WHERE ${conditions.join(' AND ')}
  ORDER BY distance ASC
  LIMIT ${limitParam};
`

try {
  const rows = await db.unsafe<MemoryRow[]>(querySql, params)

  if (!rows.length) {
    console.log('no memories matched your query')
  } else {
    rows.forEach((row, index) => {
      console.log(`\n[${index + 1}] ${row.task_name} (${row.id})`)
      console.log(`  summary: ${row.summary}`)
      console.log(`  source: ${row.source} repository_ref: ${row.repository_ref}`)
      console.log(`  tags: ${Array.isArray(row.tags) ? row.tags.join(', ') : ''}`)
      console.log(`  distance: ${Number(row.distance).toFixed(4)}`)
      console.log(`  content preview: ${String(row.content).slice(0, 200).replace(/\s+/g, ' ')}
`)
    })

    const ids = rows.map((row) => row.id)
    const snippet = queryText.trim().slice(0, 120)
    const idsArrayLiteral = toPgTextArray(ids)

    await db.unsafe('UPDATE memories.entries SET last_accessed_at = now() WHERE id = ANY($1::uuid[])', [
      idsArrayLiteral,
    ])

    await db.unsafe(
      `INSERT INTO memories.events (entry_id, event_type, event_summary)
       SELECT id, 'retrieved', $2 FROM memories.entries WHERE id = ANY($1::uuid[])`,
      [idsArrayLiteral, `retrieved for query: ${snippet}`],
    )
  }
} finally {
  await db.close()
}
