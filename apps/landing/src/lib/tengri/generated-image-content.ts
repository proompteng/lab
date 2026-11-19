import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { CODEX_IMAGE_MEDIA_TYPES, MAX_CODEX_IMAGE_BYTES, codexImageMatchesMediaType } from './codex-images'

const historySchema = z.object({ thread: z.object({ turns: z.array(z.object({ items: z.array(z.unknown()) })) }) })
const imageSchema = z.object({
  type: z.literal('imageGeneration'),
  status: z.literal('completed'),
  savedPath: z.string(),
  result: z.string(),
})

export function generatedImageContent(rawJson: string, path: string) {
  const raw: unknown = JSON.parse(rawJson)
  const history = historySchema.parse(raw)
  for (const turn of history.thread.turns) {
    for (const value of turn.items) {
      const image = imageSchema.safeParse(value)
      if (!image.success || image.data.savedPath !== path) continue
      const data = image.data.result
      if (
        !data.length ||
        data.length > Math.ceil(MAX_CODEX_IMAGE_BYTES / 3) * 4 ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ) {
        throw new Error('Invalid generated image data')
      }
      const content = Buffer.from(data, 'base64')
      const mediaType = CODEX_IMAGE_MEDIA_TYPES.find((type) => codexImageMatchesMediaType(type, content))
      if (!mediaType || content.length > MAX_CODEX_IMAGE_BYTES || content.toString('base64') !== data) {
        throw new Error('Invalid generated image data')
      }
      return { content, mediaType }
    }
  }
  return null
}
