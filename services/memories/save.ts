import { SQL } from 'bun'
import {
  DEFAULT_DATABASE_URL,
  getFlagValue,
  parseCliFlags,
  parseCommaList,
  parseJson,
  toPgTextArray,
  vectorToPgArray,
} from './cli'

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
const taskDescription = getFlagValue(flags, 'description')
const repositoryRef = getFlagValue(flags, 'repository-ref') ?? process.env.REPOSITORY_REF ?? 'main'
const repositoryCommit = getFlagValue(flags, 'repository-commit')
const repositoryPath = getFlagValue(flags, 'repository-path')
const executionId = getFlagValue(flags, 'execution-id')
const source = getFlagValue(flags, 'source') ?? 'codex-memory'
const tags = parseCommaList(getFlagValue(flags, 'tags'))
const metadata = parseJson(getFlagValue(flags, 'metadata'))
const encoderModel = getFlagValue(flags, 'model') ?? process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
const encoderVersion = getFlagValue(flags, 'encoder-version')
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
  body: JSON.stringify({ model: encoderModel, input: content }),
})

if (!embedResponse.ok) {
  const body = await embedResponse.text()
  throw new Error(`embedding request failed (${embedResponse.status}): ${body}`)
}

const embedJson = (await embedResponse.json()) as { data?: { embedding?: number[] }[] } & { model?: string }
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
const metadataJson = JSON.stringify(metadata)
const tagsArrayLiteral = toPgTextArray(tags)
const db = new SQL(databaseUrl)

const insertParams = [
  taskName,
  taskDescription,
  repositoryRef,
  repositoryCommit,
  repositoryPath,
  summary,
  content,
  metadataJson,
  tagsArrayLiteral,
  source,
  vectorString,
  encoderModel,
  encoderVersion,
  executionId,
]

try {
  const inserted = await db.unsafe<Array<{ id: string; created_at: string }>>(
    `
      INSERT INTO memories.entries (
        task_name,
        task_description,
        repository_ref,
        repository_commit,
        repository_path,
        summary,
        content,
        metadata,
        tags,
        source,
        embedding,
        encoder_model,
        encoder_version,
        execution_id
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9::text[],
        $10,
        $11::vector,
        $12,
        $13,
        $14
      )
      RETURNING id, created_at;
    `,
    insertParams,
  )

  const memoryId = inserted[0]?.id
  console.log(`saved memory ${memoryId} (${taskName})`)

  if (memoryId) {
    await db.unsafe(`INSERT INTO memories.events (entry_id, event_type, event_summary) VALUES ($1, 'created', $2)`, [
      memoryId,
      `saved by codex save script for ${taskName}`,
    ])
  }
} finally {
  await db.close()
}
