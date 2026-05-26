import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { extractCompanySymbols, normalizeCompanySymbols } from '~/lib/company-symbols'
import { deriveTopicTagsFromItemContent } from '~/lib/tags'

import { materializeAttachments, normalizeAttachmentInputs } from './assets'
import { enrichCompanyProfile, type CompanyProfile, type CompanyProfileHintInput } from './company'
import {
  buildEmbeddingText,
  cosineSimilarity,
  createSynthesisEmbedding,
  type SynthesisEmbeddingRecord,
} from './embeddings'
import type {
  FeedbackEvent,
  FeedResponse,
  ListFeedInput,
  RecordFeedbackInput,
  SourcePostInput,
  StartRunInput,
  SubmitBatchInput,
  SubmitBatchResult,
  SubmitItemInput,
  SubmitItemResult,
  SynthesisAttachment,
  SynthesisEmbedding,
  SynthesisFactCheck,
  SynthesisItem,
  SynthesisSourcePost,
  SynthesisRun,
} from './schema'

export type SynthesisStore = {
  startRun(input: StartRunInput): Promise<SynthesisRun>
  submitItem(input: SubmitItemInput): Promise<SubmitItemResult>
  submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult>
  listFeed(input: ListFeedInput): Promise<FeedResponse>
  getItem(id: string): Promise<SynthesisItem | null>
  getAttachment(id: string): Promise<SynthesisAttachment | null>
  getCompanyProfile(symbol: string): Promise<CompanyProfile | null>
  upsertCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile>
  prefillCompany(input: CompanyProfileHintInput): Promise<CompanyProfile>
  recordFeedback(input: RecordFeedbackInput): Promise<FeedbackEvent>
}

type CanonicalXPost = {
  canonicalUrl: string
  xPostId: string | null
  postKey: string
}

export const canonicalizeXPostUrl = (input: string): CanonicalXPost => {
  const normalizedInput = input.match(/^https?:\/\//i) ? input : `https://${input}`
  const url = new URL(normalizedInput)
  const hostname = url.hostname.replace(/^mobile\./, '').replace(/^www\./, '')

  if (
    hostname === 'twitter.com' ||
    hostname.endsWith('.twitter.com') ||
    hostname === 'x.com' ||
    hostname.endsWith('.x.com')
  ) {
    url.hostname = 'x.com'
  }

  const statusMatch = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/)
  url.hash = ''
  url.search = ''

  if (statusMatch) {
    const [, handle, postId] = statusMatch
    const canonicalUrl = `https://x.com/${handle}/status/${postId}`
    return {
      canonicalUrl,
      xPostId: postId,
      postKey: `x:${postId}`,
    }
  }

  const canonicalUrl = url.toString().replace(/\/$/, '')
  const digest = createHash('sha256').update(canonicalUrl).digest('base64url').slice(0, 24)
  return {
    canonicalUrl,
    xPostId: null,
    postKey: `url:${digest}`,
  }
}

const toIso = (value: Date | string | null | undefined) => {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return value
}

const nowIso = () => new Date().toISOString()

type FeedCursor = {
  createdAt: string
  id: string
}

const encodeFeedCursor = (item: SynthesisItem) =>
  Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id } satisfies FeedCursor)).toString('base64url')

const decodeFeedCursor = (cursor: string | undefined): FeedCursor | null => {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as FeedCursor).createdAt === 'string' &&
      typeof (parsed as FeedCursor).id === 'string'
    ) {
      return parsed as FeedCursor
    }
  } catch {
    return null
  }
  return null
}

const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      return []
    }
  }
  return []
}

const parseJsonValue = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const parseNumberArray = (value: unknown): number[] => {
  const parsed = parseJsonValue<unknown>(value, value)
  if (!Array.isArray(parsed)) return []
  const vector = parsed.map(Number)
  return vector.every((entry) => Number.isFinite(entry)) ? vector : []
}

type NormalizedSubmitItem = {
  runId: string | undefined
  title: string
  synthesis: string
  takeaways: string[]
  dedupeKey: string
  sourcePosts: SynthesisSourcePost[]
  factChecks: SynthesisFactCheck[]
  attachments: SynthesisAttachment[]
  generatedAttachments: SynthesisAttachment[]
  mediaUrls: string[]
  summary: string
  whyValuable: string | null
  evidence: string[]
  companySymbols: string[]
  topicTags: string[]
  score: number
  confidence: number
}

const normalizeSourcePost = (source: SourcePostInput): SynthesisSourcePost => {
  const canonical = canonicalizeXPostUrl(source.originalUrl)
  return {
    originalUrl: source.originalUrl,
    canonicalUrl: canonical.canonicalUrl,
    xPostId: canonical.xPostId,
    postKey: canonical.postKey,
    authorHandle: source.authorHandle ?? null,
    authorName: source.authorName ?? null,
    postedAt: toIso(source.postedAt),
    observedAt: toIso(source.observedAt) ?? nowIso(),
    observedText: source.observedText,
    mediaUrls: [],
  }
}

const mergeSourcePosts = (left: SynthesisSourcePost[], right: SynthesisSourcePost[]) => {
  const posts = new Map<string, SynthesisSourcePost>()
  for (const source of [...left, ...right]) posts.set(source.postKey, source)
  return [...posts.values()]
}

const attachmentMergeKey = (attachment: SynthesisAttachment) =>
  `${attachment.kind}:${attachment.objectKey ?? attachment.sourceUrl ?? attachment.assetUrl}`

const mergeAttachments = (left: SynthesisAttachment[], right: SynthesisAttachment[]) => {
  const attachments = new Map<string, SynthesisAttachment>()
  for (const attachment of [...left, ...right]) attachments.set(attachmentMergeKey(attachment), attachment)
  return [...attachments.values()]
}

const mergeCompanySymbols = (left: string[], right: string[]) => normalizeCompanySymbols([...left, ...right])

const digestKey = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 24)

const embeddingBackfillLimit = () => {
  const parsed = Number(process.env.SYNTHESIS_EMBEDDING_BACKFILL_LIMIT ?? 1000)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000
}

const normalizeSubmitItem = async (input: SubmitItemInput): Promise<NormalizedSubmitItem> => {
  const sourcePosts = input.sourcePosts.map(normalizeSourcePost)
  const primarySource = sourcePosts[0]
  if (!primarySource) throw new Error('submit item requires at least one source post')
  const sourceKey = sourcePosts
    .map((source) => source.postKey)
    .sort()
    .join('|')
  const dedupeKey = input.dedupeKey || `theme:${digestKey(sourceKey)}`
  const mediaUrls: string[] = []
  const attachments = await materializeAttachments(
    normalizeAttachmentInputs({
      attachments: input.attachments,
      generatedAttachments: input.generatedAttachments,
      mediaUrls,
    }),
  )
  const generatedAttachments = attachments.filter((attachment) => attachment.generated)
  const derivedSymbols = extractCompanySymbols(
    [
      input.title,
      input.synthesis,
      input.whyValuable,
      ...input.takeaways,
      ...input.topicTags,
      ...sourcePosts.flatMap((source) => [source.observedText, source.authorHandle, source.authorName]),
      ...input.factChecks.flatMap((factCheck) => [factCheck.claim, factCheck.explanation]),
    ]
      .filter(Boolean)
      .join(' '),
  )

  return {
    runId: input.runId,
    title: input.title,
    synthesis: input.synthesis,
    takeaways: input.takeaways,
    dedupeKey,
    sourcePosts,
    factChecks: input.factChecks,
    attachments,
    generatedAttachments,
    mediaUrls,
    summary: input.synthesis,
    whyValuable: input.whyValuable,
    evidence: input.factChecks.map((factCheck) => `${factCheck.status}: ${factCheck.claim}`),
    companySymbols: normalizeCompanySymbols([...input.companySymbols, ...derivedSymbols]),
    topicTags: deriveTopicTagsFromItemContent({
      title: input.title,
      synthesis: input.synthesis,
      takeaways: input.takeaways,
      whyValuable: input.whyValuable,
      sourcePosts,
      factChecks: input.factChecks,
      topicTags: input.topicTags,
    }),
    score: input.score,
    confidence: input.confidence,
  }
}

const embeddingMetadata = (record: SynthesisEmbeddingRecord): SynthesisEmbedding => ({
  model: record.model,
  dimension: record.dimension,
  inputHash: record.inputHash,
  createdAt: record.createdAt,
})

class InMemorySynthesisStore implements SynthesisStore {
  private runs = new Map<string, SynthesisRun>()
  private posts = new Map<string, CanonicalXPost & { observedText: string }>()
  private itemByDedupeKey = new Map<string, string>()
  private items = new Map<string, SynthesisItem>()
  private companyProfiles = new Map<string, CompanyProfile>()
  private embeddingVectors = new Map<string, number[]>()
  private feedbackEvents = new Map<string, FeedbackEvent>()
  private interestWeights = new Map<string, number>()

  async startRun(input: StartRunInput): Promise<SynthesisRun> {
    const run: SynthesisRun = {
      id: randomUUID(),
      source: input.source,
      status: 'running',
      notes: input.notes ?? null,
      interests: input.interests,
      createdAt: nowIso(),
      completedAt: null,
    }
    this.runs.set(run.id, run)
    return run
  }

  async submitItem(input: SubmitItemInput): Promise<SubmitItemResult> {
    const normalized = await normalizeSubmitItem(input)
    for (const source of normalized.sourcePosts) {
      this.posts.set(source.postKey, {
        canonicalUrl: source.canonicalUrl,
        xPostId: source.xPostId,
        postKey: source.postKey,
        observedText: source.observedText,
      })
    }

    const primarySource = normalized.sourcePosts[0]
    if (!primarySource) throw new Error('submit item requires at least one source post')
    const runId = normalized.runId ?? (await this.startRun({ source: 'x.com/home', interests: [] })).id
    const existingId = this.itemByDedupeKey.get(normalized.dedupeKey)
    const existing = existingId ? this.items.get(existingId) : null
    const timestamp = nowIso()
    const sourcePosts = mergeSourcePosts(existing?.sourcePosts ?? [], normalized.sourcePosts)
    const attachments = mergeAttachments(existing?.attachments ?? [], normalized.attachments)
    const generatedAttachments = attachments.filter((attachment) => attachment.generated)
    const companySymbols = mergeCompanySymbols(existing?.companySymbols ?? [], normalized.companySymbols)
    const embeddingRecord = await createSynthesisEmbedding(
      buildEmbeddingText({
        title: normalized.title,
        synthesis: normalized.synthesis,
        takeaways: normalized.takeaways,
        whyValuable: normalized.whyValuable,
        topicTags: normalized.topicTags,
        factChecks: normalized.factChecks,
        sourcePosts,
      }),
    )
    const item: SynthesisItem = {
      id: existing?.id ?? randomUUID(),
      runId,
      title: normalized.title,
      synthesis: normalized.synthesis,
      takeaways: normalized.takeaways,
      dedupeKey: normalized.dedupeKey,
      originalUrl: primarySource.canonicalUrl,
      xPostId: primarySource.xPostId,
      authorHandle: primarySource.authorHandle ?? existing?.authorHandle ?? null,
      authorName: primarySource.authorName ?? existing?.authorName ?? null,
      postedAt: primarySource.postedAt ?? existing?.postedAt ?? null,
      observedAt: primarySource.observedAt,
      observedText: primarySource.observedText,
      mediaUrls: normalized.mediaUrls.length ? normalized.mediaUrls : (existing?.mediaUrls ?? []),
      summary: normalized.summary,
      whyValuable: normalized.whyValuable,
      evidence: normalized.evidence,
      sourcePosts,
      sourceCount: sourcePosts.length,
      factChecks: normalized.factChecks,
      attachments,
      generatedAttachments,
      embedding: embeddingMetadata(embeddingRecord),
      companySymbols,
      topicTags: normalized.topicTags,
      score: normalized.score,
      confidence: normalized.confidence,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }

    this.itemByDedupeKey.set(normalized.dedupeKey, item.id)
    this.items.set(item.id, item)
    this.embeddingVectors.set(item.id, embeddingRecord.embedding)
    await this.prefillCompanySymbols(companySymbols)

    return {
      item,
    }
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const items: SynthesisItem[] = []
    for (const item of input.items) {
      const result = await this.submitItem({ ...item, runId: item.runId ?? input.runId })
      items.push(result.item)
    }
    return { items }
  }

  async listFeed(input: ListFeedInput): Promise<FeedResponse> {
    const cursor = decodeFeedCursor(input.cursor)
    let matching = [...this.items.values()]
      .filter((item) => (input.tag ? item.topicTags.includes(input.tag.toLowerCase()) : true))
      .filter((item) => (input.minScore == null ? true : item.score >= input.minScore))
    if (input.query) {
      const queryEmbedding = await createSynthesisEmbedding(input.query)
      const ranked = matching
        .map((item) => ({
          item,
          similarity: cosineSimilarity(queryEmbedding.embedding, this.embeddingVectors.get(item.id) ?? []),
        }))
        .filter((entry) => entry.similarity > -1)
        .sort((left, right) => right.similarity - left.similarity || right.item.id.localeCompare(left.item.id))
      const items = ranked.slice(0, input.limit).map((entry) => entry.item)
      return { items, nextCursor: null, fetchedAt: nowIso() }
    }
    matching = matching
      .sort((left, right) => {
        const createdAtDiff = Date.parse(right.createdAt) - Date.parse(left.createdAt)
        return createdAtDiff || right.id.localeCompare(left.id)
      })
      .filter((item) => {
        if (!cursor) return true
        const itemTime = Date.parse(item.createdAt)
        const cursorTime = Date.parse(cursor.createdAt)
        return itemTime < cursorTime || (itemTime === cursorTime && item.id < cursor.id)
      })
    const items = matching.slice(0, input.limit)
    const nextCursor = matching.length > input.limit && items.length ? encodeFeedCursor(items[items.length - 1]) : null

    return { items, nextCursor, fetchedAt: nowIso() }
  }

  async getItem(id: string): Promise<SynthesisItem | null> {
    return this.items.get(id) ?? null
  }

  async getAttachment(id: string): Promise<SynthesisAttachment | null> {
    for (const item of this.items.values()) {
      const attachment = item.attachments.find((candidate) => candidate.id === id)
      if (attachment) return attachment
    }
    return null
  }

  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    const normalized = normalizeCompanySymbols([symbol])[0]
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
    return this.companyProfiles.get(normalized) ?? null
  }

  async upsertCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile> {
    this.companyProfiles.set(profile.symbol, profile)
    return profile
  }

  async prefillCompany(input: CompanyProfileHintInput): Promise<CompanyProfile> {
    const profile = await enrichCompanyProfile(input)
    return this.upsertCompanyProfile(profile)
  }

  private async prefillCompanySymbols(symbols: string[]) {
    for (const symbol of symbols) {
      if (this.companyProfiles.has(symbol)) continue
      await this.prefillCompany({ symbol }).catch(() => undefined)
    }
  }

  async recordFeedback(input: RecordFeedbackInput): Promise<FeedbackEvent> {
    const item = this.items.get(input.id)
    if (!item) throw new Error(`Unknown synthesis item: ${input.id}`)

    const event: FeedbackEvent = {
      id: randomUUID(),
      itemId: input.id,
      value: input.value,
      reason: input.reason ?? null,
      createdAt: nowIso(),
    }
    this.feedbackEvents.set(event.id, event)

    const delta = input.value === 'up' || input.value === 'save' ? 0.1 : -0.1
    for (const tag of item.topicTags) {
      this.interestWeights.set(tag, Number(((this.interestWeights.get(tag) ?? 1) + delta).toFixed(3)))
    }

    return event
  }
}

type ItemRow = {
  id: string
  run_id: string
  x_post_key: string
  title: string | null
  synthesis: string | null
  takeaways: unknown
  dedupe_key: string | null
  canonical_url: string
  x_post_id: string | null
  author_handle: string | null
  author_name: string | null
  posted_at: Date | string | null
  last_observed_at: Date | string
  observed_text: string
  media_urls: unknown
  summary: string
  why_valuable: string | null
  evidence: unknown
  source_posts: unknown
  fact_checks: unknown
  attachments: unknown
  generated_attachments: unknown
  embedding_model: string | null
  embedding_dimension: number | string | null
  embedding_input_hash: string | null
  embedding_created_at: Date | string | null
  company_symbols: unknown
  topic_tags: unknown
  score: number | string
  confidence: number | string
  created_at: Date | string
  updated_at: Date | string
}

type AttachmentRow = {
  id: string
  kind: SynthesisAttachment['kind']
  source_url: string | null
  asset_url: string
  object_key: string | null
  mime_type: string | null
  size_bytes: number | string | null
  alt: string | null
  label: string | null
  generated: boolean
}

const sourcePostFromRow = (row: ItemRow): SynthesisSourcePost => ({
  originalUrl: row.canonical_url,
  canonicalUrl: row.canonical_url,
  xPostId: row.x_post_id,
  postKey: row.x_post_key,
  authorHandle: row.author_handle,
  authorName: row.author_name,
  postedAt: toIso(row.posted_at),
  observedAt: toIso(row.last_observed_at) ?? nowIso(),
  observedText: row.observed_text,
  mediaUrls: parseJsonArray(row.media_urls),
})

const mapItemRow = (row: ItemRow): SynthesisItem => {
  const sourcePosts = parseJsonValue<SynthesisSourcePost[]>(row.source_posts, [])
  const resolvedSourcePosts = sourcePosts.length ? sourcePosts : [sourcePostFromRow(row)]
  const attachments = parseJsonValue<SynthesisAttachment[]>(row.attachments, [])
  const takeaways = parseJsonValue<string[]>(row.takeaways, [])
  const evidence = parseJsonArray(row.evidence)
  const factChecks = parseJsonValue<SynthesisFactCheck[]>(row.fact_checks, [])
  const title = row.title ?? row.summary
  const synthesis = row.synthesis ?? row.summary
  const topicTags = deriveTopicTagsFromItemContent({
    title,
    synthesis,
    summary: row.summary,
    whyValuable: row.why_valuable,
    observedText: row.observed_text,
    takeaways,
    evidence,
    sourcePosts: resolvedSourcePosts,
    factChecks,
    topicTags: parseJsonArray(row.topic_tags),
  })

  return {
    id: row.id,
    runId: row.run_id,
    title,
    synthesis,
    takeaways,
    dedupeKey: row.dedupe_key ?? row.x_post_key,
    originalUrl: row.canonical_url,
    xPostId: row.x_post_id,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    postedAt: toIso(row.posted_at),
    observedAt: toIso(row.last_observed_at) ?? nowIso(),
    observedText: row.observed_text,
    mediaUrls: parseJsonArray(row.media_urls),
    summary: row.summary,
    whyValuable: row.why_valuable,
    evidence,
    sourcePosts: resolvedSourcePosts,
    sourceCount: resolvedSourcePosts.length,
    factChecks,
    attachments,
    generatedAttachments: parseJsonValue<SynthesisAttachment[]>(
      row.generated_attachments,
      attachments.filter((attachment) => attachment.generated),
    ),
    embedding:
      row.embedding_model && row.embedding_dimension && row.embedding_input_hash && row.embedding_created_at
        ? {
            model: row.embedding_model,
            dimension: Number(row.embedding_dimension),
            inputHash: row.embedding_input_hash,
            createdAt: toIso(row.embedding_created_at) ?? nowIso(),
          }
        : null,
    companySymbols: normalizeCompanySymbols(parseJsonArray(row.company_symbols)),
    topicTags,
    score: Number(row.score),
    confidence: Number(row.confidence),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  }
}

const mapAttachmentRow = (row: AttachmentRow): SynthesisAttachment => ({
  id: row.id,
  kind: row.kind,
  sourceUrl: row.source_url,
  assetUrl: row.asset_url,
  objectKey: row.object_key,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
  alt: row.alt,
  label: row.label,
  generated: row.generated,
})

class PostgresSynthesisStore implements SynthesisStore {
  private readonly pool: Pool
  private schemaPromise: Promise<void> | null = null

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 })
  }

  async startRun(input: StartRunInput): Promise<SynthesisRun> {
    await this.ensureSchema()
    const id = randomUUID()
    const result = await this.pool.query<{
      id: string
      source: string
      status: 'running' | 'completed' | 'failed'
      notes: string | null
      interests: unknown
      created_at: Date
      completed_at: Date | null
    }>(
      `INSERT INTO synthesis_runs (id, source, status, notes, interests)
       VALUES ($1, $2, 'running', $3, $4::jsonb)
       RETURNING *`,
      [id, input.source, input.notes ?? null, JSON.stringify(input.interests)],
    )
    const row = result.rows[0]
    return {
      id: row.id,
      source: row.source,
      status: row.status,
      notes: row.notes,
      interests: parseJsonArray(row.interests),
      createdAt: toIso(row.created_at) ?? nowIso(),
      completedAt: toIso(row.completed_at),
    }
  }

  async submitItem(input: SubmitItemInput): Promise<SubmitItemResult> {
    await this.ensureSchema()
    const normalized = await normalizeSubmitItem(input)
    const primarySource = normalized.sourcePosts[0]
    if (!primarySource) throw new Error('submit item requires at least one source post')

    const runId = normalized.runId ?? (await this.startRun({ source: 'x.com/home', interests: [] })).id
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const source of normalized.sourcePosts) {
        await client.query(
          `INSERT INTO x_posts (
            id, canonical_url, x_post_id, author_handle, author_name, posted_at, first_observed_at, last_observed_at,
            observed_text
          )
          VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()), $8)
          ON CONFLICT (canonical_url) DO UPDATE SET
            author_handle = COALESCE(EXCLUDED.author_handle, x_posts.author_handle),
            author_name = COALESCE(EXCLUDED.author_name, x_posts.author_name),
            posted_at = COALESCE(EXCLUDED.posted_at, x_posts.posted_at),
            last_observed_at = EXCLUDED.last_observed_at,
            observed_text = EXCLUDED.observed_text`,
          [
            source.postKey,
            source.canonicalUrl,
            source.xPostId,
            source.authorHandle,
            source.authorName,
            toIso(source.postedAt),
            toIso(source.observedAt),
            source.observedText,
          ],
        )
      }

      const existingResult = await client.query<ItemRow>(
        `SELECT ${this.itemSelectSql('i')} FROM ${this.itemRelationSql('i')}
         WHERE i.dedupe_key = $1 LIMIT 1`,
        [normalized.dedupeKey],
      )
      const existing = existingResult.rows[0] ? mapItemRow(existingResult.rows[0]) : null
      const sourcePosts = mergeSourcePosts(existing?.sourcePosts ?? [], normalized.sourcePosts)
      const attachments = mergeAttachments(existing?.attachments ?? [], normalized.attachments)
      const generatedAttachments = attachments.filter((attachment) => attachment.generated)
      const companySymbols = mergeCompanySymbols(existing?.companySymbols ?? [], normalized.companySymbols)
      const embeddingRecord = await createSynthesisEmbedding(
        buildEmbeddingText({
          title: normalized.title,
          synthesis: normalized.synthesis,
          takeaways: normalized.takeaways,
          whyValuable: normalized.whyValuable,
          topicTags: normalized.topicTags,
          factChecks: normalized.factChecks,
          sourcePosts,
        }),
      )

      const result = await client.query<{ id: string }>(
        `INSERT INTO synthesis_items (
          id, run_id, x_post_key, dedupe_key, title, synthesis, takeaways, source_posts, fact_checks, attachments,
          generated_attachments, media_urls, summary, why_valuable, evidence, company_symbols, topic_tags, score, confidence
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
          $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19
        )
        ON CONFLICT (dedupe_key) DO UPDATE SET
          run_id = EXCLUDED.run_id,
          title = EXCLUDED.title,
          synthesis = EXCLUDED.synthesis,
          takeaways = EXCLUDED.takeaways,
          source_posts = EXCLUDED.source_posts,
          fact_checks = EXCLUDED.fact_checks,
          attachments = EXCLUDED.attachments,
          generated_attachments = EXCLUDED.generated_attachments,
          media_urls = EXCLUDED.media_urls,
          summary = EXCLUDED.summary,
          why_valuable = EXCLUDED.why_valuable,
          evidence = EXCLUDED.evidence,
          company_symbols = EXCLUDED.company_symbols,
          topic_tags = EXCLUDED.topic_tags,
          score = EXCLUDED.score,
          confidence = EXCLUDED.confidence,
          updated_at = now()
        RETURNING id`,
        [
          randomUUID(),
          runId,
          primarySource.postKey,
          normalized.dedupeKey,
          normalized.title,
          normalized.synthesis,
          JSON.stringify(normalized.takeaways),
          JSON.stringify(sourcePosts),
          JSON.stringify(normalized.factChecks),
          JSON.stringify(attachments),
          JSON.stringify(generatedAttachments),
          JSON.stringify(normalized.mediaUrls),
          normalized.summary,
          normalized.whyValuable,
          JSON.stringify(normalized.evidence),
          JSON.stringify(companySymbols),
          JSON.stringify(normalized.topicTags),
          normalized.score,
          normalized.confidence,
        ],
      )

      await client.query(`DELETE FROM synthesis_item_sources WHERE item_id = $1`, [result.rows[0].id])
      for (const [index, source] of sourcePosts.entries()) {
        await client.query(
          `INSERT INTO synthesis_item_sources (item_id, x_post_key, source_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (item_id, x_post_key) DO UPDATE SET source_order = EXCLUDED.source_order`,
          [result.rows[0].id, source.postKey, index],
        )
      }

      await client.query(`DELETE FROM synthesis_attachments WHERE item_id = $1`, [result.rows[0].id])
      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO synthesis_attachments (
            id, item_id, kind, source_url, asset_url, object_key, mime_type, size_bytes, alt, label, generated
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            attachment.id,
            result.rows[0].id,
            attachment.kind,
            attachment.sourceUrl,
            attachment.assetUrl,
            attachment.objectKey,
            attachment.mimeType,
            attachment.sizeBytes,
            attachment.alt,
            attachment.label,
            attachment.generated,
          ],
        )
      }

      await client.query(`DELETE FROM synthesis_item_companies WHERE item_id = $1`, [result.rows[0].id])
      for (const symbol of companySymbols) {
        await client.query(
          `INSERT INTO synthesis_item_companies (item_id, symbol)
           VALUES ($1, $2)
           ON CONFLICT (item_id, symbol) DO NOTHING`,
          [result.rows[0].id, symbol],
        )
      }

      await this.upsertEmbedding(client, result.rows[0].id, embeddingRecord)

      const itemResult = await client.query<ItemRow>(
        `SELECT ${this.itemSelectSql('i')} FROM ${this.itemRelationSql('i')} WHERE i.id = $1`,
        [result.rows[0].id],
      )
      const item = mapItemRow(itemResult.rows[0])
      await client.query('COMMIT')
      await this.prefillCompanySymbols(item.companySymbols)
      return { item }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const items: SynthesisItem[] = []
    for (const item of input.items) {
      const result = await this.submitItem({ ...item, runId: item.runId ?? input.runId })
      items.push(result.item)
    }
    return { items }
  }

  async listFeed(input: ListFeedInput): Promise<FeedResponse> {
    await this.ensureSchema()
    const where: string[] = []
    const values: unknown[] = []
    const cursor = decodeFeedCursor(input.cursor)
    if (input.tag) {
      values.push(input.tag.toLowerCase())
      where.push(`i.topic_tags ? $${values.length}`)
    }
    if (input.minScore != null) {
      values.push(input.minScore)
      where.push(`i.score >= $${values.length}`)
    }
    if (input.query) {
      const queryEmbedding = await createSynthesisEmbedding(input.query)
      values.push(Math.max(input.limit * 12, 240))
      const result = await this.pool.query<ItemRow & { embedding_vector: unknown }>(
        `SELECT ${this.itemSelectSql('i')}, e.embedding AS embedding_vector
         FROM ${this.itemRelationSql('i', { requireEmbedding: true })}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT $${values.length}`,
        values,
      )
      const ranked = result.rows
        .map((row) => ({
          item: mapItemRow(row),
          similarity: cosineSimilarity(queryEmbedding.embedding, parseNumberArray(row.embedding_vector)),
        }))
        .filter((entry) => entry.similarity > -1)
        .sort((left, right) => right.similarity - left.similarity || right.item.id.localeCompare(left.item.id))
      return {
        items: ranked.slice(0, input.limit).map((entry) => entry.item),
        nextCursor: null,
        fetchedAt: nowIso(),
      }
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id)
      where.push(`(i.created_at, i.id) < ($${values.length - 1}::timestamptz, $${values.length})`)
    }
    values.push(input.limit + 1)
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')}
       FROM ${this.itemRelationSql('i')}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT $${values.length}`,
      values,
    )
    const rows = result.rows.map(mapItemRow)
    const items = rows.slice(0, input.limit)
    return {
      items,
      nextCursor: rows.length > input.limit && items.length ? encodeFeedCursor(items[items.length - 1]) : null,
      fetchedAt: nowIso(),
    }
  }

  async getItem(id: string): Promise<SynthesisItem | null> {
    await this.ensureSchema()
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')} FROM ${this.itemRelationSql('i')} WHERE i.id = $1`,
      [id],
    )
    return result.rows[0] ? mapItemRow(result.rows[0]) : null
  }

  async getAttachment(id: string): Promise<SynthesisAttachment | null> {
    await this.ensureSchema()
    const result = await this.pool.query<AttachmentRow>(`SELECT * FROM synthesis_attachments WHERE id = $1`, [id])
    return result.rows[0] ? mapAttachmentRow(result.rows[0]) : null
  }

  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    await this.ensureSchema()
    const normalized = normalizeCompanySymbols([symbol])[0]
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
    const result = await this.pool.query<{ profile: unknown }>(
      `SELECT profile FROM synthesis_company_profiles WHERE symbol = $1`,
      [normalized],
    )
    return result.rows[0]?.profile ? (result.rows[0].profile as CompanyProfile) : null
  }

  async upsertCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile> {
    await this.ensureSchema()
    await this.pool.query(
      `INSERT INTO synthesis_company_profiles (symbol, profile, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (symbol) DO UPDATE SET
         profile = EXCLUDED.profile,
         updated_at = EXCLUDED.updated_at`,
      [profile.symbol, JSON.stringify(profile), profile.updatedAt],
    )
    return profile
  }

  async prefillCompany(input: CompanyProfileHintInput): Promise<CompanyProfile> {
    const profile = await enrichCompanyProfile(input)
    return this.upsertCompanyProfile(profile)
  }

  async recordFeedback(input: RecordFeedbackInput): Promise<FeedbackEvent> {
    await this.ensureSchema()
    const item = await this.getItem(input.id)
    if (!item) throw new Error(`Unknown synthesis item: ${input.id}`)

    const event: FeedbackEvent = {
      id: randomUUID(),
      itemId: input.id,
      value: input.value,
      reason: input.reason ?? null,
      createdAt: nowIso(),
    }
    await this.pool.query(
      `INSERT INTO feedback_events (id, item_id, value, reason, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.id, event.itemId, event.value, event.reason, event.createdAt],
    )

    const delta = input.value === 'up' || input.value === 'save' ? 0.1 : -0.1
    for (const tag of item.topicTags) {
      await this.pool.query(
        `INSERT INTO interest_weights (tag, weight, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (tag) DO UPDATE SET weight = interest_weights.weight + $2, updated_at = now()`,
        [tag, delta],
      )
    }

    return event
  }

  private itemSelectSql(alias: string) {
    return `${alias}.id, ${alias}.run_id, ${alias}.x_post_key, ${alias}.dedupe_key, ${alias}.title, ${alias}.synthesis,
      ${alias}.takeaways, ${alias}.source_posts, ${alias}.fact_checks, ${alias}.attachments,
      ${alias}.generated_attachments, p.canonical_url, p.x_post_id, p.author_handle, p.author_name, p.posted_at,
      p.last_observed_at, p.observed_text, ${alias}.media_urls, ${alias}.summary, ${alias}.why_valuable,
      ${alias}.evidence, ${alias}.company_symbols, ${alias}.topic_tags, ${alias}.score, ${alias}.confidence, ${alias}.created_at,
      ${alias}.updated_at, e.model AS embedding_model, e.dimension AS embedding_dimension,
      e.input_hash AS embedding_input_hash, e.created_at AS embedding_created_at`
  }

  private itemRelationSql(alias: string, options: { requireEmbedding?: boolean } = {}) {
    const embeddingJoin = options.requireEmbedding
      ? `JOIN synthesis_item_embeddings e ON e.item_id = ${alias}.id`
      : `LEFT JOIN synthesis_item_embeddings e ON e.item_id = ${alias}.id`
    return `synthesis_items ${alias} JOIN x_posts p ON p.id = ${alias}.x_post_key ${embeddingJoin}`
  }

  private async upsertEmbedding(client: PoolClient, itemId: string, embeddingRecord: SynthesisEmbeddingRecord) {
    await client.query(
      `INSERT INTO synthesis_item_embeddings (item_id, model, dimension, input_hash, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       ON CONFLICT (item_id) DO UPDATE SET
         model = EXCLUDED.model,
         dimension = EXCLUDED.dimension,
         input_hash = EXCLUDED.input_hash,
         embedding = EXCLUDED.embedding,
         created_at = EXCLUDED.created_at`,
      [
        itemId,
        embeddingRecord.model,
        embeddingRecord.dimension,
        embeddingRecord.inputHash,
        JSON.stringify(embeddingRecord.embedding),
        embeddingRecord.createdAt,
      ],
    )
  }

  private async prefillCompanySymbols(symbols: string[]) {
    for (const symbol of symbols) {
      const existing = await this.getCompanyProfile(symbol).catch(() => null)
      if (existing) continue
      await this.prefillCompany({ symbol }).catch(() => undefined)
    }
  }

  private async backfillMissingTopicTags() {
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')}
       FROM ${this.itemRelationSql('i')}
       WHERE jsonb_array_length(i.topic_tags) = 0
       ORDER BY i.created_at ASC, i.id ASC
       LIMIT $1`,
      [embeddingBackfillLimit()],
    )
    if (!result.rows.length) return

    const client = await this.pool.connect()
    try {
      for (const row of result.rows) {
        const item = mapItemRow(row)
        if (!item.topicTags.length) continue
        await client.query(`UPDATE synthesis_items SET topic_tags = $2::jsonb, updated_at = updated_at WHERE id = $1`, [
          item.id,
          JSON.stringify(item.topicTags),
        ])
      }
    } finally {
      client.release()
    }
  }

  private async backfillMissingEmbeddings() {
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')}
       FROM ${this.itemRelationSql('i')}
       WHERE e.item_id IS NULL
       ORDER BY i.created_at ASC, i.id ASC
       LIMIT $1`,
      [embeddingBackfillLimit()],
    )
    if (!result.rows.length) return

    const client = await this.pool.connect()
    try {
      for (const row of result.rows) {
        const item = mapItemRow(row)
        const embeddingRecord = await createSynthesisEmbedding(
          buildEmbeddingText({
            title: item.title,
            synthesis: item.synthesis,
            takeaways: item.takeaways,
            whyValuable: item.whyValuable,
            topicTags: item.topicTags,
            factChecks: item.factChecks,
            sourcePosts: item.sourcePosts,
          }),
        )
        await this.upsertEmbedding(client, item.id, embeddingRecord)
      }
    } finally {
      client.release()
    }
  }

  private ensureSchema() {
    this.schemaPromise ??= this.createSchema()
    return this.schemaPromise
  }

  private async createSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS synthesis_runs (
        id text PRIMARY KEY,
        source text NOT NULL,
        status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        notes text,
        interests jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS x_posts (
        id text PRIMARY KEY,
        canonical_url text NOT NULL UNIQUE,
        x_post_id text,
        author_handle text,
        author_name text,
        posted_at timestamptz,
        first_observed_at timestamptz NOT NULL DEFAULT now(),
        last_observed_at timestamptz NOT NULL DEFAULT now(),
        observed_text text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS synthesis_items (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES synthesis_runs(id) ON DELETE CASCADE,
        x_post_key text NOT NULL UNIQUE REFERENCES x_posts(id) ON DELETE CASCADE,
        dedupe_key text NOT NULL UNIQUE,
        title text NOT NULL,
        synthesis text NOT NULL,
        takeaways jsonb NOT NULL DEFAULT '[]'::jsonb,
        source_posts jsonb NOT NULL DEFAULT '[]'::jsonb,
        fact_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        generated_attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        summary text NOT NULL,
        why_valuable text,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        company_symbols jsonb NOT NULL DEFAULT '[]'::jsonb,
        topic_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
        confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS media_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS dedupe_key text;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS title text;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS synthesis text;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS takeaways jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS source_posts jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS fact_checks jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS generated_attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items ADD COLUMN IF NOT EXISTS company_symbols jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE synthesis_items DROP COLUMN IF EXISTS engagement_recommendation;
      ALTER TABLE synthesis_items DROP COLUMN IF EXISTS engagement_status;
      ALTER TABLE synthesis_items DROP COLUMN IF EXISTS reply_text;
      UPDATE synthesis_items
      SET
        dedupe_key = COALESCE(dedupe_key, x_post_key),
        title = COALESCE(title, summary),
        synthesis = COALESCE(synthesis, summary)
      WHERE dedupe_key IS NULL OR title IS NULL OR synthesis IS NULL;
      ALTER TABLE synthesis_items ALTER COLUMN dedupe_key SET NOT NULL;
      ALTER TABLE synthesis_items ALTER COLUMN title SET NOT NULL;
      ALTER TABLE synthesis_items ALTER COLUMN synthesis SET NOT NULL;

      CREATE TABLE IF NOT EXISTS synthesis_item_sources (
        item_id text NOT NULL REFERENCES synthesis_items(id) ON DELETE CASCADE,
        x_post_key text NOT NULL REFERENCES x_posts(id) ON DELETE CASCADE,
        source_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (item_id, x_post_key)
      );

      CREATE TABLE IF NOT EXISTS synthesis_attachments (
        id text PRIMARY KEY,
        item_id text NOT NULL REFERENCES synthesis_items(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('source_image', 'source_screenshot', 'generated_infographic')),
        source_url text,
        asset_url text NOT NULL,
        object_key text,
        mime_type text,
        size_bytes bigint,
        alt text,
        label text,
        generated boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS synthesis_item_embeddings (
        item_id text PRIMARY KEY REFERENCES synthesis_items(id) ON DELETE CASCADE,
        model text NOT NULL,
        dimension integer NOT NULL CHECK (dimension > 0),
        input_hash text NOT NULL,
        embedding jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS synthesis_company_profiles (
        symbol text PRIMARY KEY,
        profile jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS synthesis_item_companies (
        item_id text NOT NULL REFERENCES synthesis_items(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (item_id, symbol)
      );

      DROP TABLE IF EXISTS engagement_actions;

      CREATE TABLE IF NOT EXISTS feedback_events (
        id text PRIMARY KEY,
        item_id text NOT NULL REFERENCES synthesis_items(id) ON DELETE CASCADE,
        value text NOT NULL CHECK (value IN ('up', 'down', 'save', 'hide')),
        reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS interest_weights (
        tag text PRIMARY KEY,
        weight double precision NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id text PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS synthesis_items_created_at_idx ON synthesis_items (created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS synthesis_items_dedupe_key_idx ON synthesis_items (dedupe_key);
      CREATE INDEX IF NOT EXISTS synthesis_items_score_idx ON synthesis_items (score DESC);
      CREATE INDEX IF NOT EXISTS synthesis_item_sources_x_post_idx ON synthesis_item_sources (x_post_key);
      CREATE INDEX IF NOT EXISTS synthesis_attachments_item_idx ON synthesis_attachments (item_id);
      CREATE INDEX IF NOT EXISTS synthesis_item_embeddings_model_idx ON synthesis_item_embeddings (model, dimension);
      CREATE INDEX IF NOT EXISTS synthesis_item_companies_symbol_idx ON synthesis_item_companies (symbol);
    `)
    await this.backfillMissingTopicTags()
    await this.backfillMissingEmbeddings()
  }
}

let storeSingleton: SynthesisStore | null = null

export const createInMemorySynthesisStore = (): SynthesisStore => new InMemorySynthesisStore()

export const getSynthesisStore = () => {
  if (storeSingleton) return storeSingleton

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl || process.env.SYNTHESIS_STORAGE === 'memory') {
    storeSingleton = createInMemorySynthesisStore()
    return storeSingleton
  }

  storeSingleton = new PostgresSynthesisStore(databaseUrl)
  return storeSingleton
}

export const setSynthesisStoreForTests = (store: SynthesisStore | null) => {
  storeSingleton = store
}
