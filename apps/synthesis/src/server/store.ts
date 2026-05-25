import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

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
  StartRunInput,
  SubmitBatchInput,
  SubmitBatchResult,
  SubmitItemInput,
  SubmitItemResult,
  SynthesisItem,
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

class InMemorySynthesisStore implements SynthesisStore {
  private runs = new Map<string, SynthesisRun>()
  private posts = new Map<string, CanonicalXPost & { observedText: string }>()
  private itemByPostKey = new Map<string, string>()
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
    const canonical = canonicalizeXPostUrl(input.originalUrl)
    this.posts.set(canonical.postKey, { ...canonical, observedText: input.observedText })

    const runId = input.runId ?? (await this.startRun({ source: 'x.com/home', interests: [] })).id
    const existingId = this.itemByPostKey.get(canonical.postKey)
    const existing = existingId ? this.items.get(existingId) : null
    const timestamp = nowIso()
    const item: SynthesisItem = {
      id: existing?.id ?? randomUUID(),
      runId,
      originalUrl: canonical.canonicalUrl,
      xPostId: canonical.xPostId,
      authorHandle: input.authorHandle ?? existing?.authorHandle ?? null,
      authorName: input.authorName ?? existing?.authorName ?? null,
      postedAt: toIso(input.postedAt) ?? existing?.postedAt ?? null,
      observedAt: toIso(input.observedAt) ?? timestamp,
      observedText: input.observedText,
      summary: input.summary,
      whyValuable: input.whyValuable ?? null,
      evidence: input.evidence,
      topicTags: input.topicTags,
      score: input.score,
      confidence: input.confidence,
      engagementRecommendation: input.engagementRecommendation,
      engagementStatus: existing?.engagementStatus ?? 'none',
      replyText: input.replyText ? normalizeReplyText(input.replyText) : null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }

    this.itemByPostKey.set(canonical.postKey, item.id)
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
    const items = [...this.items.values()]
      .filter((item) => (input.tag ? item.topicTags.includes(input.tag.toLowerCase()) : true))
      .filter((item) => (input.minScore == null ? true : item.score >= input.minScore))
      .filter((item) => (input.engagementStatus ? item.engagementStatus === input.engagementStatus : true))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, input.limit)

    return { items, fetchedAt: nowIso() }
  }

  async getItem(id: string): Promise<SynthesisItem | null> {
    return this.items.get(id) ?? null
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
  canonical_url: string
  x_post_id: string | null
  author_handle: string | null
  author_name: string | null
  posted_at: Date | string | null
  last_observed_at: Date | string
  observed_text: string
  summary: string
  why_valuable: string | null
  evidence: unknown
  topic_tags: unknown
  score: number | string
  confidence: number | string
  engagement_recommendation: 'none' | 'like' | 'reply'
  engagement_status: EngagementStatus
  reply_text: string | null
  created_at: Date | string
  updated_at: Date | string
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

const mapItemRow = (row: ItemRow): SynthesisItem => ({
  id: row.id,
  runId: row.run_id,
  originalUrl: row.canonical_url,
  xPostId: row.x_post_id,
  authorHandle: row.author_handle,
  authorName: row.author_name,
  postedAt: toIso(row.posted_at),
  observedAt: toIso(row.last_observed_at) ?? nowIso(),
  observedText: row.observed_text,
  summary: row.summary,
  whyValuable: row.why_valuable,
  evidence: parseJsonArray(row.evidence),
  topicTags: parseJsonArray(row.topic_tags),
  score: Number(row.score),
  confidence: Number(row.confidence),
  engagementRecommendation: row.engagement_recommendation,
  engagementStatus: row.engagement_status,
  replyText: row.reply_text,
  createdAt: toIso(row.created_at) ?? nowIso(),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
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
    const runId = input.runId ?? (await this.startRun({ source: 'x.com/home', interests: [] })).id
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const canonical = canonicalizeXPostUrl(input.originalUrl)
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
          canonical.postKey,
          canonical.canonicalUrl,
          canonical.xPostId,
          input.authorHandle ?? null,
          input.authorName ?? null,
          toIso(input.postedAt),
          toIso(input.observedAt),
          input.observedText,
        ],
      )

      const result = await client.query<{ id: string }>(
        `INSERT INTO synthesis_items (
          id, run_id, x_post_key, summary, why_valuable, evidence, topic_tags, score, confidence,
          engagement_recommendation, engagement_status, reply_text
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, 'none', $11)
        ON CONFLICT (x_post_key) DO UPDATE SET
          run_id = EXCLUDED.run_id,
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
          canonical.postKey,
          input.summary,
          input.whyValuable ?? null,
          JSON.stringify(input.evidence),
          JSON.stringify(input.topicTags),
          input.score,
          input.confidence,
          input.engagementRecommendation,
          input.replyText ? normalizeReplyText(input.replyText) : null,
        ],
      )
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
    values.push(input.limit)
    const result = await this.pool.query<ItemRow>(
      `SELECT ${this.itemSelectSql('i')}
       FROM synthesis_items i
       JOIN x_posts p ON p.id = i.x_post_key
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.created_at DESC
       LIMIT $${values.length}`,
      values,
    )
    return {
      items: result.rows.map(mapItemRow),
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
    return `${alias}.id, ${alias}.run_id, p.canonical_url, p.x_post_id, p.author_handle, p.author_name, p.posted_at,
      p.last_observed_at, p.observed_text, ${alias}.summary, ${alias}.why_valuable, ${alias}.evidence,
      ${alias}.topic_tags, ${alias}.score, ${alias}.confidence, ${alias}.engagement_recommendation,
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
      CREATE INDEX IF NOT EXISTS synthesis_items_score_idx ON synthesis_items (score DESC);
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
