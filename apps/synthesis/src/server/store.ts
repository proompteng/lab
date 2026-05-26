import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { materializeAttachments, normalizeAttachmentInputs } from './assets'
import type {
  EngagementAction,
  EngagementActionKind,
  EngagementMode,
  EngagementStatus,
  FeedbackEvent,
  FeedResponse,
  ListFeedInput,
  NextEngagementInput,
  NextEngagementResult,
  RecordEngagementResultInput,
  RecordFeedbackInput,
  SourcePostInput,
  StartRunInput,
  SubmitBatchInput,
  SubmitBatchResult,
  SubmitItemInput,
  SubmitItemResult,
  SynthesisAttachment,
  SynthesisFactCheck,
  SynthesisItem,
  SynthesisSourcePost,
  SynthesisRun,
} from './schema'

const likeDailyLimit = 25
const replyDailyLimit = 5
const oneDayMs = 24 * 60 * 60 * 1_000

export type SynthesisStore = {
  startRun(input: StartRunInput): Promise<SynthesisRun>
  submitItem(input: SubmitItemInput): Promise<SubmitItemResult>
  submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult>
  listFeed(input: ListFeedInput): Promise<FeedResponse>
  getItem(id: string): Promise<SynthesisItem | null>
  getAttachment(id: string): Promise<SynthesisAttachment | null>
  recordFeedback(input: RecordFeedbackInput): Promise<FeedbackEvent>
  nextEngagement(input: NextEngagementInput): Promise<NextEngagementResult>
  recordEngagementResult(input: RecordEngagementResultInput): Promise<EngagementAction>
}

type CanonicalXPost = {
  canonicalUrl: string
  xPostId: string | null
  postKey: string
}

type EngagementDecision =
  | { status: 'none'; reason: string | null }
  | { status: 'suppressed'; reason: string }
  | { status: 'queued'; action: EngagementActionKind; replyText: string | null; reason: string }

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

const getEngagementMode = (): EngagementMode => {
  const raw = process.env.SYNTHESIS_ENGAGEMENT_MODE?.trim().toLowerCase()
  return raw === 'off' ? 'off' : 'queue'
}

const normalizeReplyText = (replyText: string | undefined) => {
  const trimmed = replyText?.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.length > 160) return null
  if (trimmed.includes('#') || trimmed.includes('http://') || trimmed.includes('https://')) return null
  return trimmed
}

const planEngagement = async (
  input: SubmitItemInput,
  countRecent: (action: EngagementActionKind) => Promise<number>,
): Promise<EngagementDecision> => {
  if (input.engagementRecommendation === 'none') {
    return { status: 'none', reason: null }
  }

  if (getEngagementMode() === 'off') {
    return { status: 'suppressed', reason: 'SYNTHESIS_ENGAGEMENT_MODE=off' }
  }

  if (input.engagementRecommendation === 'reply') {
    const replyText = normalizeReplyText(input.replyText)
    if (!replyText) {
      return { status: 'suppressed', reason: 'reply text failed guardrails' }
    }
    const replyCount = await countRecent('reply')
    if (replyCount >= replyDailyLimit) {
      return { status: 'suppressed', reason: `daily reply limit ${replyDailyLimit} reached` }
    }
    return { status: 'queued', action: 'reply', replyText, reason: 'reply recommended by synthesis' }
  }

  const likeCount = await countRecent('like')
  if (likeCount >= likeDailyLimit) {
    return { status: 'suppressed', reason: `daily like limit ${likeDailyLimit} reached` }
  }
  return { status: 'queued', action: 'like', replyText: null, reason: 'like recommended by synthesis' }
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
  topicTags: string[]
  score: number
  confidence: number
  engagementRecommendation: SubmitItemInput['engagementRecommendation']
  replyText: string | undefined
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
    mediaUrls: source.mediaUrls,
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

const digestKey = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 24)

const normalizeSubmitItem = async (input: SubmitItemInput): Promise<NormalizedSubmitItem> => {
  const sourcePosts = input.sourcePosts.map(normalizeSourcePost)
  const primarySource = sourcePosts[0]
  if (!primarySource) throw new Error('submit item requires at least one source post')
  const sourceKey = sourcePosts
    .map((source) => source.postKey)
    .sort()
    .join('|')
  const dedupeKey = input.dedupeKey || `theme:${digestKey(sourceKey)}`
  const mediaUrls = [...new Set(sourcePosts.flatMap((source) => source.mediaUrls))]
  const attachments = await materializeAttachments(
    normalizeAttachmentInputs({
      attachments: input.attachments,
      generatedAttachments: input.generatedAttachments,
      mediaUrls,
    }),
  )
  const generatedAttachments = attachments.filter((attachment) => attachment.generated)

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
    topicTags: input.topicTags,
    score: input.score,
    confidence: input.confidence,
    engagementRecommendation: input.engagementRecommendation,
    replyText: input.replyText,
  }
}

class InMemorySynthesisStore implements SynthesisStore {
  private runs = new Map<string, SynthesisRun>()
  private posts = new Map<string, CanonicalXPost & { observedText: string }>()
  private itemByDedupeKey = new Map<string, string>()
  private items = new Map<string, SynthesisItem>()
  private engagements = new Map<string, EngagementAction>()
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
      topicTags: normalized.topicTags,
      score: normalized.score,
      confidence: normalized.confidence,
      engagementRecommendation: normalized.engagementRecommendation,
      engagementStatus: existing?.engagementStatus ?? 'none',
      replyText: normalized.replyText ? normalizeReplyText(normalized.replyText) : null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }

    this.itemByDedupeKey.set(normalized.dedupeKey, item.id)
    this.items.set(item.id, item)

    const engagementAction = await this.maybeQueueEngagement(item, input)
    return {
      item: this.items.get(item.id) ?? item,
      engagementAction,
    }
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const items: SynthesisItem[] = []
    const engagementActions: EngagementAction[] = []
    for (const item of input.items) {
      const result = await this.submitItem({ ...item, runId: item.runId ?? input.runId })
      items.push(result.item)
      if (result.engagementAction) engagementActions.push(result.engagementAction)
    }
    return { items, engagementActions }
  }

  async listFeed(input: ListFeedInput): Promise<FeedResponse> {
    const cursor = decodeFeedCursor(input.cursor)
    const matching = [...this.items.values()]
      .filter((item) => (input.tag ? item.topicTags.includes(input.tag.toLowerCase()) : true))
      .filter((item) => (input.minScore == null ? true : item.score >= input.minScore))
      .filter((item) => (input.engagementStatus ? item.engagementStatus === input.engagementStatus : true))
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

  async nextEngagement(_input: NextEngagementInput): Promise<NextEngagementResult> {
    const mode = getEngagementMode()
    if (mode === 'off') {
      return { mode, action: null, item: null, reason: 'SYNTHESIS_ENGAGEMENT_MODE=off' }
    }

    const action = [...this.engagements.values()]
      .filter((candidate) => candidate.status === 'queued')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0]

    if (!action) return { mode, action: null, item: null, reason: 'no queued engagement action' }

    return {
      mode,
      action,
      item: this.items.get(action.itemId) ?? null,
      reason: null,
    }
  }

  async recordEngagementResult(input: RecordEngagementResultInput): Promise<EngagementAction> {
    const action = this.engagements.get(input.id)
    if (!action) throw new Error(`Unknown engagement action: ${input.id}`)

    const updated: EngagementAction = {
      ...action,
      status: input.status,
      resultUrl: input.resultUrl ?? action.resultUrl,
      error: input.error ?? null,
      performedAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.engagements.set(action.id, updated)

    const item = this.items.get(action.itemId)
    if (item) {
      this.items.set(item.id, { ...item, engagementStatus: input.status, updatedAt: updated.updatedAt })
    }

    return updated
  }

  private async maybeQueueEngagement(item: SynthesisItem, input: SubmitItemInput) {
    const existing = [...this.engagements.values()].find(
      (action) => action.itemId === item.id && action.status === 'queued',
    )
    if (existing) return existing

    const decision = await planEngagement(input, async (action) => {
      const cutoff = Date.now() - oneDayMs
      return [...this.engagements.values()].filter(
        (candidate) => candidate.action === action && Date.parse(candidate.createdAt) >= cutoff,
      ).length
    })

    if (decision.status !== 'queued') {
      this.items.set(item.id, { ...item, engagementStatus: decision.status })
      return null
    }

    const timestamp = nowIso()
    const engagementAction: EngagementAction = {
      id: randomUUID(),
      itemId: item.id,
      action: decision.action,
      status: 'queued',
      replyText: decision.replyText,
      reason: decision.reason,
      resultUrl: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      performedAt: null,
    }
    this.engagements.set(engagementAction.id, engagementAction)
    this.items.set(item.id, { ...item, engagementStatus: 'queued', replyText: decision.replyText })
    return engagementAction
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
  topic_tags: unknown
  score: number | string
  confidence: number | string
  engagement_recommendation: 'none' | 'like' | 'reply'
  engagement_status: EngagementStatus
  reply_text: string | null
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

type EngagementRow = {
  id: string
  item_id: string
  action: EngagementActionKind
  status: EngagementStatus
  reply_text: string | null
  reason: string | null
  result_url: string | null
  error: string | null
  created_at: Date | string
  updated_at: Date | string
  performed_at: Date | string | null
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

  return {
    id: row.id,
    runId: row.run_id,
    title: row.title ?? row.summary,
    synthesis: row.synthesis ?? row.summary,
    takeaways: parseJsonValue<string[]>(row.takeaways, []),
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
    evidence: parseJsonArray(row.evidence),
    sourcePosts: resolvedSourcePosts,
    sourceCount: resolvedSourcePosts.length,
    factChecks: parseJsonValue<SynthesisFactCheck[]>(row.fact_checks, []),
    attachments,
    generatedAttachments: parseJsonValue<SynthesisAttachment[]>(
      row.generated_attachments,
      attachments.filter((attachment) => attachment.generated),
    ),
    topicTags: parseJsonArray(row.topic_tags),
    score: Number(row.score),
    confidence: Number(row.confidence),
    engagementRecommendation: row.engagement_recommendation,
    engagementStatus: row.engagement_status,
    replyText: row.reply_text,
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

const mapEngagementRow = (row: EngagementRow): EngagementAction => ({
  id: row.id,
  itemId: row.item_id,
  action: row.action,
  status: row.status,
  replyText: row.reply_text,
  reason: row.reason,
  resultUrl: row.result_url,
  error: row.error,
  createdAt: toIso(row.created_at) ?? nowIso(),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
  performedAt: toIso(row.performed_at),
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
        `SELECT ${this.itemSelectSql('i')} FROM synthesis_items i JOIN x_posts p ON p.id = i.x_post_key
         WHERE i.dedupe_key = $1 LIMIT 1`,
        [normalized.dedupeKey],
      )
      const existing = existingResult.rows[0] ? mapItemRow(existingResult.rows[0]) : null
      const sourcePosts = mergeSourcePosts(existing?.sourcePosts ?? [], normalized.sourcePosts)
      const attachments = mergeAttachments(existing?.attachments ?? [], normalized.attachments)
      const generatedAttachments = attachments.filter((attachment) => attachment.generated)

      const result = await client.query<{ id: string }>(
        `INSERT INTO synthesis_items (
          id, run_id, x_post_key, dedupe_key, title, synthesis, takeaways, source_posts, fact_checks, attachments,
          generated_attachments, media_urls, summary, why_valuable, evidence, topic_tags, score, confidence,
          engagement_recommendation, engagement_status, reply_text
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
          $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19, 'none', $20
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
          topic_tags = EXCLUDED.topic_tags,
          score = EXCLUDED.score,
          confidence = EXCLUDED.confidence,
          engagement_recommendation = EXCLUDED.engagement_recommendation,
          reply_text = EXCLUDED.reply_text,
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
          JSON.stringify(normalized.topicTags),
          normalized.score,
          normalized.confidence,
          normalized.engagementRecommendation,
          normalized.replyText ? normalizeReplyText(normalized.replyText) : null,
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

      const itemResult = await client.query<ItemRow>(
        `SELECT ${this.itemSelectSql('i')} FROM synthesis_items i JOIN x_posts p ON p.id = i.x_post_key WHERE i.id = $1`,
        [result.rows[0].id],
      )
      let item = mapItemRow(itemResult.rows[0])
      const engagementAction = await this.maybeQueueEngagement(client, item, input)
      if (engagementAction) {
        item = { ...item, engagementStatus: 'queued', replyText: engagementAction.replyText }
      } else {
        const refreshed = await client.query<ItemRow>(
          `SELECT ${this.itemSelectSql('i')} FROM synthesis_items i JOIN x_posts p ON p.id = i.x_post_key WHERE i.id = $1`,
          [item.id],
        )
        item = mapItemRow(refreshed.rows[0])
      }
      await client.query('COMMIT')
      return { item, engagementAction }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const items: SynthesisItem[] = []
    const engagementActions: EngagementAction[] = []
    for (const item of input.items) {
      const result = await this.submitItem({ ...item, runId: item.runId ?? input.runId })
      items.push(result.item)
      if (result.engagementAction) engagementActions.push(result.engagementAction)
    }
    return { items, engagementActions }
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
    if (input.engagementStatus) {
      values.push(input.engagementStatus)
      where.push(`i.engagement_status = $${values.length}`)
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id)
      where.push(`(i.created_at, i.id) < ($${values.length - 1}::timestamptz, $${values.length})`)
    }
    values.push(input.limit + 1)
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')}
       FROM synthesis_items i
       JOIN x_posts p ON p.id = i.x_post_key
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
      `SELECT ${this.itemSelectSql('i')} FROM synthesis_items i JOIN x_posts p ON p.id = i.x_post_key WHERE i.id = $1`,
      [id],
    )
    return result.rows[0] ? mapItemRow(result.rows[0]) : null
  }

  async getAttachment(id: string): Promise<SynthesisAttachment | null> {
    await this.ensureSchema()
    const result = await this.pool.query<AttachmentRow>(`SELECT * FROM synthesis_attachments WHERE id = $1`, [id])
    return result.rows[0] ? mapAttachmentRow(result.rows[0]) : null
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

  async nextEngagement(_input: NextEngagementInput): Promise<NextEngagementResult> {
    await this.ensureSchema()
    const mode = getEngagementMode()
    if (mode === 'off') {
      return { mode, action: null, item: null, reason: 'SYNTHESIS_ENGAGEMENT_MODE=off' }
    }

    const result = await this.pool.query<EngagementRow>(
      `SELECT * FROM engagement_actions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    )
    const row = result.rows[0]
    if (!row) return { mode, action: null, item: null, reason: 'no queued engagement action' }

    const action = mapEngagementRow(row)
    return {
      mode,
      action,
      item: await this.getItem(action.itemId),
      reason: null,
    }
  }

  async recordEngagementResult(input: RecordEngagementResultInput): Promise<EngagementAction> {
    await this.ensureSchema()
    const result = await this.pool.query<EngagementRow>(
      `UPDATE engagement_actions
       SET status = $2, result_url = COALESCE($3, result_url), error = $4, performed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.status, input.resultUrl ?? null, input.error ?? null],
    )
    const row = result.rows[0]
    if (!row) throw new Error(`Unknown engagement action: ${input.id}`)

    await this.pool.query(`UPDATE synthesis_items SET engagement_status = $2, updated_at = now() WHERE id = $1`, [
      row.item_id,
      input.status,
    ])
    return mapEngagementRow(row)
  }

  private async maybeQueueEngagement(client: PoolClient, item: SynthesisItem, input: SubmitItemInput) {
    const existing = await client.query<EngagementRow>(
      `SELECT * FROM engagement_actions WHERE item_id = $1 AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      [item.id],
    )
    if (existing.rows[0]) return mapEngagementRow(existing.rows[0])

    const decision = await planEngagement(input, async (action) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM engagement_actions
         WHERE action = $1 AND created_at >= now() - interval '1 day'`,
        [action],
      )
      return Number(result.rows[0]?.count ?? 0)
    })

    if (decision.status !== 'queued') {
      await client.query(`UPDATE synthesis_items SET engagement_status = $2, updated_at = now() WHERE id = $1`, [
        item.id,
        decision.status,
      ])
      return null
    }

    const result = await client.query<EngagementRow>(
      `INSERT INTO engagement_actions (id, item_id, action, status, reply_text, reason)
       VALUES ($1, $2, $3, 'queued', $4, $5)
       RETURNING *`,
      [randomUUID(), item.id, decision.action, decision.replyText, decision.reason],
    )
    await client.query(
      `UPDATE synthesis_items SET engagement_status = 'queued', reply_text = $2, updated_at = now() WHERE id = $1`,
      [item.id, decision.replyText],
    )
    return mapEngagementRow(result.rows[0])
  }

  private itemSelectSql(alias: string) {
    return `${alias}.id, ${alias}.run_id, ${alias}.x_post_key, ${alias}.dedupe_key, ${alias}.title, ${alias}.synthesis,
      ${alias}.takeaways, ${alias}.source_posts, ${alias}.fact_checks, ${alias}.attachments,
      ${alias}.generated_attachments, p.canonical_url, p.x_post_id, p.author_handle, p.author_name, p.posted_at,
      p.last_observed_at, p.observed_text, ${alias}.media_urls, ${alias}.summary, ${alias}.why_valuable,
      ${alias}.evidence, ${alias}.topic_tags, ${alias}.score, ${alias}.confidence, ${alias}.engagement_recommendation,
      ${alias}.engagement_status, ${alias}.reply_text, ${alias}.created_at, ${alias}.updated_at`
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
        topic_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
        confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        engagement_recommendation text NOT NULL CHECK (engagement_recommendation IN ('none', 'like', 'reply')),
        engagement_status text NOT NULL CHECK (
          engagement_status IN ('none', 'queued', 'sent', 'failed', 'skipped', 'suppressed')
        ),
        reply_text text,
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

      CREATE TABLE IF NOT EXISTS engagement_actions (
        id text PRIMARY KEY,
        item_id text NOT NULL REFERENCES synthesis_items(id) ON DELETE CASCADE,
        action text NOT NULL CHECK (action IN ('like', 'reply')),
        status text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'suppressed')),
        reply_text text,
        reason text,
        result_url text,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        performed_at timestamptz
      );

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
      CREATE INDEX IF NOT EXISTS engagement_actions_status_created_idx ON engagement_actions (status, created_at);
    `)
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
