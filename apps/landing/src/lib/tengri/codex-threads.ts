import { z } from 'zod'

const nativeThreadPage = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        name: z.string().nullable().optional(),
        preview: z.string(),
        updatedAt: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER / 1000),
      }),
    )
    .max(50),
  nextCursor: z.string().min(1).max(4096).nullable().optional(),
})

export type TengriCodexThreadSummary = { id: string; title: string; updatedAt: number }
export type TengriCodexThreadPage = { threads: TengriCodexThreadSummary[]; nextCursor: string | null }

export function codexThreadTitle(value: string) {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title) return 'New chat'
  return title.length > 48 ? `${title.slice(0, 45).trimEnd()}…` : title
}

export function parseCodexThreadPage(raw: string): TengriCodexThreadPage {
  const page = nativeThreadPage.parse(JSON.parse(raw))
  if (new Set(page.data.map((thread) => thread.id)).size !== page.data.length)
    throw new Error('Native chat index contains duplicate sessions')
  return {
    threads: page.data.map((thread) => ({
      id: thread.id,
      title: codexThreadTitle(thread.name?.trim() || thread.preview),
      updatedAt: thread.updatedAt * 1000,
    })),
    nextCursor: page.nextCursor ?? null,
  }
}
