import { chunkContent, DISCORD_MESSAGE_LIMIT } from '@proompteng/discord'

export interface DiscordSentMessageLike {
  edit: (content: string) => Promise<unknown>
}

export interface DiscordIncomingMessageLike {
  reply: (content: string) => Promise<DiscordSentMessageLike>
  channel: {
    send: (content: string) => Promise<DiscordSentMessageLike>
  }
}

export interface StreamingReply {
  pushDelta: (delta: string) => Promise<void>
  finalize: () => Promise<void>
}

interface CreateStreamingReplyParams {
  message: DiscordIncomingMessageLike
  limit?: number
}

const EDIT_THROTTLE_MS = 1_000

export const createStreamingReply = async ({ message, limit = DISCORD_MESSAGE_LIMIT }: CreateStreamingReplyParams) => {
  const sentMessages: DiscordSentMessageLike[] = []
  let buffer = ''
  let lastEditAt = -EDIT_THROTTLE_MS
  let _pendingEditTimer: ReturnType<typeof setTimeout> | undefined
  let pendingEditPromise: Promise<void> | undefined
  let pendingEditContent = ''
  let lastEditedContent = ''
  let finalized = false

  const base = await message.reply('Working…')
  sentMessages.push(base)

  const editLatest = async (content: string) => {
    const latest = sentMessages[sentMessages.length - 1]
    if (!latest) {
      return
    }
    await latest.edit(content)
    lastEditAt = Date.now()
    lastEditedContent = content
  }

  const flush = async () => {
    if (finalized) {
      return
    }

    const chunks = chunkContent(buffer, limit)
    const normalized = chunks.length > 0 ? chunks : ['']

    while (normalized.length > sentMessages.length) {
      const previousIndex = sentMessages.length - 1
      const previousChunk = normalized[previousIndex]
      if (previousChunk !== undefined) {
        await sentMessages[previousIndex]?.edit(previousChunk)
        lastEditedContent = previousChunk
      }

      const nextChunk = normalized[sentMessages.length]
      if (nextChunk === undefined) {
        break
      }
      const followup = await message.channel.send(nextChunk)
      sentMessages.push(followup)
      lastEditedContent = nextChunk
    }

    const latestChunk = normalized[normalized.length - 1] ?? ''
    const now = Date.now()
    const remaining = Math.max(0, EDIT_THROTTLE_MS - (now - lastEditAt))

    if (remaining === 0) {
      await editLatest(latestChunk)
      return
    }

    pendingEditContent = latestChunk

    if (!pendingEditPromise) {
      pendingEditPromise = new Promise((resolve) => {
        _pendingEditTimer = setTimeout(() => {
          _pendingEditTimer = undefined
          pendingEditPromise = undefined
          void editLatest(pendingEditContent).then(resolve)
        }, remaining)
      })
    }
  }

  const reply: StreamingReply = {
    pushDelta: async (delta: string) => {
      buffer += delta
      await flush()
    },
    finalize: async () => {
      finalized = true
      const chunks = chunkContent(buffer, limit)
      const normalized = chunks.length > 0 ? chunks : ['']

      while (normalized.length > sentMessages.length) {
        const previousIndex = sentMessages.length - 1
        const previousChunk = normalized[previousIndex]
        if (previousChunk !== undefined) {
          await sentMessages[previousIndex]?.edit(previousChunk)
          lastEditedContent = previousChunk
        }

        const nextChunk = normalized[sentMessages.length]
        if (nextChunk === undefined) {
          break
        }

        const followup = await message.channel.send(nextChunk)
        sentMessages.push(followup)
        lastEditedContent = nextChunk
      }

      const latest = sentMessages[sentMessages.length - 1]
      const latestChunk = normalized[normalized.length - 1] ?? ''
      if (latest) {
        pendingEditContent = latestChunk

        if (pendingEditPromise) {
          await pendingEditPromise
        }

        if (latestChunk !== lastEditedContent) {
          await latest.edit(latestChunk)
          lastEditedContent = latestChunk
        }
      }
    },
  }

  return reply
}
