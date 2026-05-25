import { z } from 'zod'

export const EngagementModeSchema = z.enum(['off', 'queue'])
export const EngagementRecommendationSchema = z.enum(['none', 'like', 'reply'])
export const EngagementActionSchema = z.enum(['like', 'reply'])
export const EngagementStatusSchema = z.enum(['none', 'queued', 'sent', 'failed', 'skipped', 'suppressed'])
export const FeedbackValueSchema = z.enum(['up', 'down', 'save', 'hide'])
export const RunStatusSchema = z.enum(['running', 'completed', 'failed'])

const TopicTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((value) => value.toLowerCase())

export const StartRunInputSchema = z
  .object({
    source: z.string().trim().min(1).max(80).default('x.com/home'),
    notes: z.string().trim().max(1_000).optional(),
    interests: z.array(TopicTagSchema).max(32).default([]),
  })
  .strict()

export const SubmitItemInputSchema = z
  .object({
    runId: z.string().trim().min(1).optional(),
    originalUrl: z.string().trim().min(1).max(1_000),
    authorHandle: z.string().trim().min(1).max(80).optional(),
    authorName: z.string().trim().min(1).max(120).optional(),
    postedAt: z.string().trim().min(1).max(80).optional(),
    observedAt: z.string().trim().min(1).max(80).optional(),
    observedText: z.string().trim().min(1).max(12_000),
    mediaUrls: z.array(z.string().trim().min(1).max(1_000_000)).max(8).default([]),
    summary: z.string().trim().min(1).max(2_000),
    whyValuable: z.string().trim().max(1_200).optional(),
    evidence: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
    topicTags: z.array(TopicTagSchema).max(16).default([]),
    score: z.coerce.number().min(0).max(1),
    confidence: z.coerce.number().min(0).max(1).default(0.7),
    engagementRecommendation: EngagementRecommendationSchema.default('none'),
    replyText: z.string().trim().max(180).optional(),
  })
  .strict()

export const SubmitBatchInputSchema = z
  .object({
    runId: z.string().trim().min(1).optional(),
    items: z.array(SubmitItemInputSchema).min(1).max(50),
  })
  .strict()

export const ListFeedInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(40),
    cursor: z.string().trim().min(1).max(240).optional(),
    tag: z.string().trim().min(1).max(60).optional(),
    minScore: z.coerce.number().min(0).max(1).optional(),
    engagementStatus: EngagementStatusSchema.optional(),
  })
  .strict()

export const RecordFeedbackInputSchema = z
  .object({
    id: z.string().trim().min(1),
    value: FeedbackValueSchema,
    reason: z.string().trim().max(1_000).optional(),
  })
  .strict()

export const NextEngagementInputSchema = z
  .object({
    dryRun: z.boolean().default(false),
  })
  .strict()

export const RecordEngagementResultInputSchema = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(['sent', 'failed', 'skipped']),
    resultUrl: z.string().trim().max(1_000).optional(),
    error: z.string().trim().max(1_000).optional(),
  })
  .strict()

export type StartRunInput = z.infer<typeof StartRunInputSchema>
export type SubmitItemInput = z.infer<typeof SubmitItemInputSchema>
export type SubmitBatchInput = z.infer<typeof SubmitBatchInputSchema>
export type ListFeedInput = z.infer<typeof ListFeedInputSchema>
export type RecordFeedbackInput = z.infer<typeof RecordFeedbackInputSchema>
export type NextEngagementInput = z.infer<typeof NextEngagementInputSchema>
export type RecordEngagementResultInput = z.infer<typeof RecordEngagementResultInputSchema>
export type EngagementMode = z.infer<typeof EngagementModeSchema>
export type EngagementActionKind = z.infer<typeof EngagementActionSchema>
export type EngagementStatus = z.infer<typeof EngagementStatusSchema>
export type FeedbackValue = z.infer<typeof FeedbackValueSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>

export type SynthesisRun = {
  id: string
  source: string
  status: RunStatus
  notes: string | null
  interests: string[]
  createdAt: string
  completedAt: string | null
}

export type SynthesisItem = {
  id: string
  runId: string
  originalUrl: string
  xPostId: string | null
  authorHandle: string | null
  authorName: string | null
  postedAt: string | null
  observedAt: string
  observedText: string
  mediaUrls: string[]
  summary: string
  whyValuable: string | null
  evidence: string[]
  topicTags: string[]
  score: number
  confidence: number
  engagementRecommendation: 'none' | 'like' | 'reply'
  engagementStatus: EngagementStatus
  replyText: string | null
  createdAt: string
  updatedAt: string
}

export type EngagementAction = {
  id: string
  itemId: string
  action: EngagementActionKind
  status: EngagementStatus
  replyText: string | null
  reason: string | null
  resultUrl: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  performedAt: string | null
}

export type FeedbackEvent = {
  id: string
  itemId: string
  value: FeedbackValue
  reason: string | null
  createdAt: string
}

export type SubmitItemResult = {
  item: SynthesisItem
  engagementAction: EngagementAction | null
}

export type SubmitBatchResult = {
  items: SynthesisItem[]
  engagementActions: EngagementAction[]
}

export type NextEngagementResult = {
  mode: EngagementMode
  action: EngagementAction | null
  item: SynthesisItem | null
  reason: string | null
}

export type FeedResponse = {
  items: SynthesisItem[]
  nextCursor: string | null
  fetchedAt: string
}
