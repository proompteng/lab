import { z } from 'zod'

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

export const SourcePostInputSchema = z
  .object({
    originalUrl: z.string().trim().min(1).max(1_000),
    authorHandle: z.string().trim().min(1).max(80).optional(),
    authorName: z.string().trim().min(1).max(120).optional(),
    postedAt: z.string().trim().min(1).max(80).optional(),
    observedAt: z.string().trim().min(1).max(80).optional(),
    observedText: z.string().trim().min(1).max(12_000),
  })
  .strict()

export const FactCheckStatusSchema = z.enum(['verified', 'unclear', 'refuted', 'rumor'])

export const FactCheckSourceSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    url: z.string().trim().min(1).max(1_000),
    publisher: z.string().trim().min(1).max(160).optional(),
    checkedAt: z.string().trim().min(1).max(80).optional(),
  })
  .strict()

export const FactCheckInputSchema = z
  .object({
    claim: z.string().trim().min(1).max(500),
    status: FactCheckStatusSchema,
    explanation: z.string().trim().min(1).max(800),
    sources: z.array(FactCheckSourceSchema).max(8).default([]),
  })
  .strict()

export const AttachmentKindSchema = z.enum(['source_image', 'source_screenshot', 'generated_infographic'])

export const AttachmentInputSchema = z
  .object({
    kind: AttachmentKindSchema,
    url: z.string().trim().min(1).max(1_000_000).optional(),
    data: z.string().trim().min(1).max(12_000_000).optional(),
    sourceUrl: z.string().trim().min(1).max(1_000).optional(),
    mimeType: z.string().trim().min(1).max(120).optional(),
    alt: z.string().trim().max(300).optional(),
    label: z.string().trim().max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.url && !value.data) {
      context.addIssue({
        code: 'custom',
        message: 'attachment requires url or data',
        path: ['url'],
      })
    }
    if ((value.kind === 'source_image' || value.kind === 'source_screenshot') && !value.alt?.trim()) {
      context.addIssue({
        code: 'custom',
        message: 'source media attachments require alt text with extracted visual information',
        path: ['alt'],
      })
    }
  })

export const SubmitItemInputSchema = z
  .object({
    runId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(180),
    synthesis: z.string().trim().min(1).max(3_000),
    takeaways: z.array(z.string().trim().min(1).max(220)).min(1).max(8),
    whyValuable: z.string().trim().min(1).max(1_200),
    sourcePosts: z.array(SourcePostInputSchema).min(1).max(12),
    factChecks: z.array(FactCheckInputSchema).max(12).default([]),
    attachments: z.array(AttachmentInputSchema).max(16).default([]),
    generatedAttachments: z.array(AttachmentInputSchema).max(8).default([]),
    dedupeKey: z.string().trim().min(1).max(240),
    companySymbols: z.array(z.string().trim().min(1).max(20)).max(16).default([]),
    topicTags: z.array(TopicTagSchema).max(16).default([]),
    score: z.coerce.number().min(0).max(1),
    confidence: z.coerce.number().min(0).max(1),
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
    query: z.string().trim().min(1).max(240).optional(),
  })
  .strict()

export const RecordFeedbackInputSchema = z
  .object({
    id: z.string().trim().min(1),
    value: FeedbackValueSchema,
    reason: z.string().trim().max(1_000).optional(),
  })
  .strict()

export type StartRunInput = z.infer<typeof StartRunInputSchema>
export type SourcePostInput = z.infer<typeof SourcePostInputSchema>
export type FactCheckInput = z.infer<typeof FactCheckInputSchema>
export type FactCheckSource = z.infer<typeof FactCheckSourceSchema>
export type FactCheckStatus = z.infer<typeof FactCheckStatusSchema>
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>
export type SubmitItemInput = z.infer<typeof SubmitItemInputSchema>
export type SubmitBatchInput = z.infer<typeof SubmitBatchInputSchema>
export type ListFeedInput = z.infer<typeof ListFeedInputSchema>
export type RecordFeedbackInput = z.infer<typeof RecordFeedbackInputSchema>
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
  title: string
  synthesis: string
  takeaways: string[]
  dedupeKey: string
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
  sourcePosts: SynthesisSourcePost[]
  sourceCount: number
  factChecks: SynthesisFactCheck[]
  attachments: SynthesisAttachment[]
  generatedAttachments: SynthesisAttachment[]
  embedding: SynthesisEmbedding | null
  companySymbols: string[]
  topicTags: string[]
  score: number
  confidence: number
  createdAt: string
  updatedAt: string
}

export type SynthesisEmbedding = {
  model: string
  dimension: number
  inputHash: string
  createdAt: string
}

export type SynthesisSourcePost = {
  originalUrl: string
  canonicalUrl: string
  xPostId: string | null
  postKey: string
  authorHandle: string | null
  authorName: string | null
  postedAt: string | null
  observedAt: string
  observedText: string
  mediaUrls: string[]
}

export type SynthesisFactCheck = {
  claim: string
  status: FactCheckStatus
  explanation: string
  sources: FactCheckSource[]
}

export type SynthesisAttachment = {
  id: string
  kind: AttachmentKind
  sourceUrl: string | null
  assetUrl: string
  objectKey: string | null
  mimeType: string | null
  sizeBytes: number | null
  alt: string | null
  label: string | null
  generated: boolean
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
}

export type SubmitBatchResult = {
  items: SynthesisItem[]
}

export type FeedResponse = {
  items: SynthesisItem[]
  nextCursor: string | null
  fetchedAt: string
}
