type ThreadNameOptions = {
  content: string
  botId: string | null
  prefix: string
}

type MessageContentOptions = {
  content: string
  cleanContent?: string | null
  attachmentUrls?: string[]
  botId: string | null
}

const MAX_THREAD_NAME_LENGTH = 90

export const stripBotMention = (content: string, botId: string | null): string => {
  if (!botId) return content.trim()
  const pattern = new RegExp(`<@!?${botId}>`, 'g')
  return content.replace(pattern, '').trim()
}

export const buildThreadName = ({ content, botId, prefix }: ThreadNameOptions): string => {
  const snippet = stripBotMention(content, botId).replace(/\s+/g, ' ').trim()
  const trimmed = snippet.length > 0 ? snippet : 'conversation'
  const base = `${prefix} - ${trimmed}`
  return base.length > MAX_THREAD_NAME_LENGTH ? base.slice(0, MAX_THREAD_NAME_LENGTH).trimEnd() : base
}

export const buildMessageContent = ({
  content,
  cleanContent,
  attachmentUrls = [],
  botId,
}: MessageContentOptions): string => {
  let resolved = stripBotMention(content, botId)
  if (!resolved) {
    resolved = stripBotMention(cleanContent?.trim() ?? '', botId)
  }

  const lines = attachmentUrls.filter(Boolean)
  if (lines.length > 0) {
    const suffix = `\n\nAttachments:\n${lines.join('\n')}`
    resolved = `${resolved}${suffix}`.trim()
  }

  return resolved
}
