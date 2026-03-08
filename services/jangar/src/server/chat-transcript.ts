import { createHash } from 'node:crypto'

export type ChatMessage = {
  role: string
  content: unknown
  name?: string
}

export type TranscriptEntry = {
  role: string
  name: string | null
  contentHash: string
}

export type PromptFitResult = {
  prompt: string
  messages: ChatMessage[]
  trimmed: boolean
  fits: boolean
  totalChars: number
  keptChars: number
}

const summarizeNonTextPart = (part: Record<string, unknown>) => {
  const type = typeof part.type === 'string' && part.type.length > 0 ? part.type : 'part'
  if (type === 'image_url') {
    const imageUrl = part.image_url
    if (imageUrl && typeof imageUrl === 'object') {
      const url = (imageUrl as Record<string, unknown>).url
      if (typeof url === 'string' && url.length > 0) return ` [image_url] ${url}`
    }
    return ' [image_url]'
  }
  if (type === 'input_audio') return ' [input_audio]'
  if (type === 'file') return ' [file]'
  return ` [${type}]`
}

export const normalizeMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
          if (typeof obj.content === 'string') return obj.content
          return summarizeNonTextPart(obj)
        }
        return part == null ? '' : String(part)
      })
      .filter((value) => value.length > 0)
    return parts.join('')
  }

  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    return summarizeNonTextPart(obj)
  }

  return content == null ? '' : String(content)
}

const toPromptLine = (message: Readonly<ChatMessage>) => {
  const prefix = message.name && message.name.length > 0 ? `${message.role}(${message.name})` : message.role
  return `${prefix}: ${normalizeMessageContent(message.content)}`
}

const measurePromptLength = (lines: ReadonlyArray<string>) =>
  lines.reduce((total, line, index) => total + line.length + (index > 0 ? 1 : 0), 0)

export const buildPrompt = (messages: ReadonlyArray<ChatMessage>) => messages.map((msg) => toPromptLine(msg)).join('\n')

export const fitPromptMessages = (messages: ReadonlyArray<ChatMessage>, maxChars: number): PromptFitResult => {
  const promptLines = messages.map((message) => ({ message, line: toPromptLine(message) }))
  const totalChars = measurePromptLength(promptLines.map((entry) => entry.line))
  if (totalChars <= maxChars) {
    return {
      prompt: promptLines.map((entry) => entry.line).join('\n'),
      messages: [...messages],
      trimmed: false,
      fits: true,
      totalChars,
      keptChars: totalChars,
    }
  }

  const selectedIndices = new Set<number>()
  let keptChars = 0

  for (let index = promptLines.length - 1; index >= 0; index -= 1) {
    const line = promptLines[index]?.line ?? ''
    const nextLength = keptChars + line.length + (selectedIndices.size > 0 ? 1 : 0)
    if (nextLength > maxChars) {
      break
    }
    selectedIndices.add(index)
    keptChars = nextLength
  }

  const leadingSystemIndices: number[] = []
  for (let index = 0; index < promptLines.length; index += 1) {
    if (promptLines[index]?.message.role !== 'system') break
    leadingSystemIndices.push(index)
  }

  for (const index of leadingSystemIndices) {
    if (selectedIndices.has(index)) continue
    const line = promptLines[index]?.line ?? ''
    const nextLength = keptChars + line.length + (selectedIndices.size > 0 ? 1 : 0)
    if (nextLength > maxChars) break
    selectedIndices.add(index)
    keptChars = nextLength
  }

  if (selectedIndices.size === 0 || !selectedIndices.has(promptLines.length - 1)) {
    return {
      prompt: '',
      messages: [],
      trimmed: true,
      fits: false,
      totalChars,
      keptChars: 0,
    }
  }

  const fittedMessages = promptLines
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => selectedIndices.has(entry.index))
    .sort((a, b) => a.index - b.index)

  const prompt = fittedMessages.map((entry) => entry.line).join('\n')
  return {
    prompt,
    messages: fittedMessages.map((entry) => entry.message),
    trimmed: fittedMessages.length !== messages.length,
    fits: prompt.length <= maxChars,
    totalChars,
    keptChars: prompt.length,
  }
}

const hashContent = (content: string) => createHash('sha256').update(content).digest('hex')

export const buildTranscriptSignature = (messages: ReadonlyArray<ChatMessage>): TranscriptEntry[] =>
  messages.map((message) => ({
    role: message.role,
    name: message.name && message.name.length > 0 ? message.name : null,
    contentHash: hashContent(normalizeMessageContent(message.content)),
  }))

export type TranscriptComparison = {
  prefixMatch: boolean
  prefixLength: number
  resetRequired: boolean
  resetReason: 'none' | 'stored_longer_than_incoming' | 'prefix_mismatch'
  resetMismatchIndex: number | null
  deltaMessages: ChatMessage[]
  signature: TranscriptEntry[]
}

const entriesEqual = (a: TranscriptEntry, b: TranscriptEntry) =>
  a.role === b.role && a.name === b.name && a.contentHash === b.contentHash

export const compareTranscript = (
  stored: TranscriptEntry[] | null,
  messages: ReadonlyArray<ChatMessage>,
): TranscriptComparison => {
  const signature = buildTranscriptSignature(messages)
  if (!stored || stored.length === 0) {
    return {
      prefixMatch: true,
      prefixLength: 0,
      resetRequired: false,
      resetReason: 'none',
      resetMismatchIndex: null,
      deltaMessages: [...messages],
      signature,
    }
  }

  if (stored.length > signature.length) {
    return {
      prefixMatch: false,
      prefixLength: 0,
      resetRequired: true,
      resetReason: 'stored_longer_than_incoming',
      resetMismatchIndex: null,
      deltaMessages: [...messages],
      signature,
    }
  }

  for (let i = 0; i < stored.length; i += 1) {
    if (!entriesEqual(stored[i], signature[i])) {
      return {
        prefixMatch: false,
        prefixLength: 0,
        resetRequired: true,
        resetReason: 'prefix_mismatch',
        resetMismatchIndex: i,
        deltaMessages: [...messages],
        signature,
      }
    }
  }

  return {
    prefixMatch: true,
    prefixLength: stored.length,
    resetRequired: false,
    resetReason: 'none',
    resetMismatchIndex: null,
    deltaMessages: messages.slice(stored.length),
    signature,
  }
}

export const parseTranscriptSignature = (raw: unknown): TranscriptEntry[] | null => {
  if (!Array.isArray(raw)) return null
  const entries: TranscriptEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>
    const role = record.role
    const name = record.name
    const contentHash = record.contentHash
    if (typeof role !== 'string' || role.length === 0) return null
    if (name !== null && name !== undefined && typeof name !== 'string') return null
    if (typeof contentHash !== 'string' || contentHash.length === 0) return null
    entries.push({ role, name: typeof name === 'string' ? name : null, contentHash })
  }
  return entries
}
