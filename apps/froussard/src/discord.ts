import { Effect } from 'effect'
import * as Duration from 'effect/Duration'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
export const DISCORD_MESSAGE_LIMIT = 1900
const CHANNEL_NAME_MAX_LENGTH = 95
const DEFAULT_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5_000
const CATEGORY_CHANNEL_LIMIT = 50
const CATEGORY_NAME_PREFIX = 'Codex Relay - '

const CATEGORY_ADJECTIVES = [
  'Lumineuse',
  'Sereine',
  'Radieuse',
  'Eclatante',
  'Petillante',
  'Enchantee',
  'Celeste',
  'Azur',
  'Verdoyante',
  'Charmante',
]

const CATEGORY_NOUNS = [
  'Atelier',
  'Salon',
  'Promenade',
  'Jardin',
  'Galerie',
  'Rivage',
  'Bastide',
  'Reverie',
  'Chateau',
  'Balcon',
]

export interface DiscordConfig {
  botToken: string
  guildId: string
  categoryId?: string
}

export interface RelayMetadata {
  repository?: string
  issueNumber?: string | number
  issueUrl?: string
  stage?: string
  runId?: string
  title?: string
  createdAt?: Date
  summary?: string
}

export interface RelayBootstrapResult {
  channelId: string
  channelName: string
  guildId: string
  url?: string
  categoryId?: string
  categoryName?: string
  createdCategory?: boolean
}

interface DiscordErrorPayload {
  message?: string
  code?: number
  retry_after?: number
}

interface DiscordGuildChannel {
  id: string
  type: number
  name?: string
  parent_id?: string | null
}

interface CategoryResolution {
  categoryId?: string
  categoryName?: string
  createdCategory?: boolean
}

export class DiscordRelayError extends Error {
  constructor(
    message: string,
    readonly response?: Response,
    readonly payload?: DiscordErrorPayload,
  ) {
    super(message)
    this.name = 'DiscordRelayError'
  }
}

class DiscordRetryableError extends DiscordRelayError {
  constructor(
    message: string,
    response: Response | undefined,
    payload: DiscordErrorPayload | undefined,
    readonly retryAfterMs: number | undefined,
    readonly rateLimited: boolean,
  ) {
    super(message, response, payload)
    this.name = 'DiscordRetryableError'
  }
}

const safeLimit = (limit: number) => Math.max(1, Math.min(limit, DISCORD_MESSAGE_LIMIT))

const nextSliceIndex = (text: string, limit: number) => {
  const boundary = text.lastIndexOf('\n', limit)
  if (boundary >= 0 && boundary >= limit - 400) {
    return boundary
  }
  return limit
}

export const consumeChunks = (
  content: string,
  limit = DISCORD_MESSAGE_LIMIT,
): { chunks: string[]; remainder: string } => {
  if (!content) {
    return { chunks: [], remainder: '' }
  }

  const max = safeLimit(limit)
  const chunks: string[] = []
  let buffer = content

  while (buffer.length > max) {
    const sliceIndex = nextSliceIndex(buffer, max)
    const chunk = buffer.slice(0, sliceIndex).trimEnd()
    chunks.push(chunk)
    buffer = buffer.slice(sliceIndex).replace(/^\n+/, '')
  }

  return { chunks, remainder: buffer }
}

export const chunkContent = (content: string, limit = DISCORD_MESSAGE_LIMIT): string[] => {
  const { chunks, remainder } = consumeChunks(content, limit)
  if (remainder.length > 0) {
    return [...chunks, remainder]
  }
  return chunks
}

const sanitizeSegment = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

export const buildChannelName = (metadata: RelayMetadata): string => {
  const createdAt = metadata.createdAt ?? new Date()
  const parts: string[] = []

  if (metadata.repository) {
    const repoSegment = metadata.repository.includes('/')
      ? (metadata.repository.split('/')[1] ?? metadata.repository)
      : metadata.repository
    parts.push(repoSegment)
  }

  if (metadata.issueNumber !== undefined) {
    parts.push(`issue-${metadata.issueNumber}`)
  }

  if (metadata.stage) {
    parts.push(metadata.stage)
  }

  const timestamp = createdAt.toISOString().replace(/[-:]/g, '').slice(0, 13)
  parts.push(timestamp)

  if (metadata.runId) {
    parts.push(metadata.runId)
  } else {
    const randomSuffix = Math.random().toString(36).slice(2, 6)
    parts.push(randomSuffix)
  }

  const segments = parts.map((segment) => sanitizeSegment(segment)).filter((segment) => segment.length > 0)

  if (segments.length === 0) {
    segments.push('codex-run')
  }

  let channelName = segments.join('-')

  if (channelName.length > CHANNEL_NAME_MAX_LENGTH) {
    channelName = channelName.slice(0, CHANNEL_NAME_MAX_LENGTH)
    channelName = channelName.replace(/-+$/g, '')
  }

  if (channelName.length === 0) {
    channelName = 'codex-run'
  }

  return channelName
}

const buildInitialMessage = (metadata: RelayMetadata, relay: RelayBootstrapResult) => {
  const lines: string[] = [`**Codex Relay Started**`]

  if (metadata.title) {
    lines.push(`**Title:** ${metadata.title}`)
  }

  let repositoryInfo: { display: string; url: string } | undefined
  const repoValue = metadata.repository?.trim()
  if (repoValue) {
    const hasProtocol = /^https?:\/\//i.test(repoValue)
    const normalizedUrl = (hasProtocol ? repoValue : `https://github.com/${repoValue}`).replace(/\/$/, '')
    const display = normalizedUrl.replace(/^https?:\/\/github\.com\//i, '') || repoValue
    repositoryInfo = { display, url: normalizedUrl }
    lines.push(`**Repository:** [${display}](${normalizedUrl})`)
  }

  const stageLabel = metadata.stage?.trim() ?? ''
  const isReviewStage = stageLabel.toLowerCase() === 'review'
  const itemLabel = isReviewStage ? 'Pull Request' : 'Issue'

  const normalizedIssueNumber =
    metadata.issueNumber !== undefined ? String(metadata.issueNumber).replace(/^#/, '').trim() : undefined
  let issueUrl = metadata.issueUrl?.trim()
  if (!issueUrl && normalizedIssueNumber && repositoryInfo) {
    const path = isReviewStage ? 'pull' : 'issues'
    issueUrl = `${repositoryInfo.url}/${path}/${normalizedIssueNumber}`
  }
  if (normalizedIssueNumber) {
    const issueLabel = `#${normalizedIssueNumber}`
    if (issueUrl) {
      lines.push(`**${itemLabel}:** [${issueLabel}](${issueUrl})`)
    } else {
      lines.push(`**${itemLabel}:** ${issueLabel}`)
    }
  } else if (issueUrl) {
    lines.push(`**${itemLabel}:** ${issueUrl}`)
  }

  if (stageLabel) {
    lines.push(`**Stage:** ${stageLabel}`)
  }

  const channelLine = relay.url
    ? `**Channel:** [#${relay.channelName}](${relay.url})`
    : `**Channel:** #${relay.channelName}`
  lines.push(channelLine)

  const startedAtSource =
    metadata.createdAt instanceof Date
      ? metadata.createdAt
      : metadata.createdAt
        ? new Date(metadata.createdAt)
        : new Date()
  lines.push(`**Started:** ${startedAtSource.toISOString()}`)

  const summary = metadata.summary?.replace(/\s+/g, ' ').trim()
  if (summary) {
    const available = Math.max(0, DISCORD_MESSAGE_LIMIT - lines.join('\n').length - '**Summary:** '.length - 1)
    const trimmedSummary = available > 0 && summary.length > available ? `${summary.slice(0, available - 1)}…` : summary
    if (trimmedSummary) {
      lines.push(`**Summary:** ${trimmedSummary}`)
    }
  }

  return lines.join('\n')
}

const buildHeaders = (config: DiscordConfig) => ({
  Authorization: `Bot ${config.botToken}`,
  'Content-Type': 'application/json',
})

const parseError = async (response: Response): Promise<DiscordErrorPayload | undefined> => {
  try {
    return (await response.json()) as DiscordErrorPayload
  } catch {
    return undefined
  }
}

const nextBackoff = (attempt: number) => Math.min(MAX_BACKOFF_MS, DEFAULT_BACKOFF_MS * 2 ** Math.max(0, attempt - 1))

const discordFetch = async (config: DiscordConfig, path: string, init: RequestInit): Promise<Response> => {
  const url = `${DISCORD_API_BASE}${path}`

  const request = (attempt: number): Effect.Effect<Response, DiscordRelayError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() =>
        fetch(url, { ...init, headers: { ...buildHeaders(config), ...(init.headers ?? {}) } }),
      )

      if (response.status === 429) {
        const payload = yield* Effect.tryPromise(() => parseError(response))
        const retryAfterMs = payload?.retry_after ? payload.retry_after * 1000 : undefined
        yield* Effect.fail(
          new DiscordRetryableError('Discord rate limit encountered', response, payload, retryAfterMs, true),
        )
      }

      if (response.status >= 500 && response.status < 600) {
        const payload = yield* Effect.tryPromise(() => parseError(response))
        yield* Effect.fail(
          new DiscordRetryableError(
            `Discord request failed with status ${response.status}`,
            response,
            payload,
            undefined,
            false,
          ),
        )
      }

      if (!response.ok) {
        const payload = yield* Effect.tryPromise(() => parseError(response))
        yield* Effect.fail(
          new DiscordRelayError(`Discord request failed with status ${response.status}`, response, payload),
        )
      }

      return response
    }).pipe(
      Effect.catchAll((error) => {
        if (error instanceof DiscordRetryableError) {
          const hasRetryBudget = error.rateLimited || attempt < 5
          if (!hasRetryBudget) {
            return Effect.fail(new DiscordRelayError(error.message, error.response, error.payload))
          }
          const delayMs = error.retryAfterMs ?? nextBackoff(attempt)
          return Effect.sleep(Duration.millis(delayMs)).pipe(Effect.flatMap(() => request(attempt + 1)))
        }

        return Effect.fail(error)
      }),
    )

  return Effect.runPromise(request(1))
}

const requestJson = async <T>(response: Response): Promise<T> => {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return {} as T
  }
  return (await response.json()) as T
}

const chooseWord = (words: readonly string[], offset = 0) => {
  const randomIndex = Math.floor(Math.random() * words.length)
  return words[(randomIndex + offset) % words.length] ?? words[0]
}

const toTitleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

const generateCategoryName = (takenNames: Set<string>): string => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const adjective = toTitleCase(chooseWord(CATEGORY_ADJECTIVES, attempt))
    const noun = toTitleCase(chooseWord(CATEGORY_NOUNS, attempt))
    const candidate = `${CATEGORY_NAME_PREFIX}${adjective} ${noun}`
    const key = candidate.toLowerCase()
    if (!takenNames.has(key)) {
      takenNames.add(key)
      return candidate
    }
  }
  const fallback = `${CATEGORY_NAME_PREFIX}Orbit ${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  return fallback
}

const fetchGuildChannels = async (config: DiscordConfig): Promise<DiscordGuildChannel[]> => {
  const response = await discordFetch(config, `/guilds/${config.guildId}/channels`, { method: 'GET' })
  const channels = await requestJson<DiscordGuildChannel[]>(response)
  if (!Array.isArray(channels)) {
    return []
  }
  return channels
}

const createCategory = async (config: DiscordConfig, takenNames: Set<string>): Promise<CategoryResolution> => {
  const categoryName = generateCategoryName(takenNames)
  const response = await discordFetch(config, `/guilds/${config.guildId}/channels`, {
    method: 'POST',
    body: JSON.stringify({ name: categoryName, type: 4 }),
  })
  const payload = await requestJson<{ id?: string }>(response)
  if (!payload.id) {
    throw new DiscordRelayError(
      'Discord category creation response missing id',
      response,
      payload as DiscordErrorPayload,
    )
  }
  return { categoryId: payload.id, categoryName, createdCategory: true }
}

const resolveCategory = async (config: DiscordConfig): Promise<CategoryResolution> => {
  const channels = await fetchGuildChannels(config)
  if (channels.length === 0) {
    return config.categoryId ? await createCategory(config, new Set()) : {}
  }

  const categories = channels.filter((channel) => channel.type === 4)
  const categoryMap = new Map(categories.map((category) => [category.id, category]))
  const occupancy = new Map<string, number>()

  for (const channel of channels) {
    const parentId = channel.parent_id
    if (typeof parentId === 'string' && parentId.length > 0) {
      occupancy.set(parentId, (occupancy.get(parentId) ?? 0) + 1)
    }
  }

  const candidateIds: string[] = []
  if (config.categoryId) {
    candidateIds.push(config.categoryId)
  }
  for (const category of categories) {
    if (category.name?.startsWith(CATEGORY_NAME_PREFIX)) {
      candidateIds.push(category.id)
    }
  }

  const seenCandidates = new Set<string>()
  for (const candidate of candidateIds) {
    if (seenCandidates.has(candidate)) {
      continue
    }
    seenCandidates.add(candidate)
    const category = categoryMap.get(candidate)
    if (!category) {
      continue
    }
    const used = occupancy.get(candidate) ?? 0
    if (used < CATEGORY_CHANNEL_LIMIT) {
      return { categoryId: candidate, categoryName: category.name }
    }
  }

  if (candidateIds.length === 0) {
    return {}
  }

  const takenNames = new Set(
    categories.map((category) => category.name?.toLowerCase()).filter((name): name is string => Boolean(name)),
  )
  return createCategory(config, takenNames)
}

export const createRelayChannel = async (
  config: DiscordConfig,
  metadata: RelayMetadata,
): Promise<RelayBootstrapResult> => {
  const channelName = buildChannelName(metadata)
  const categoryResolution = await resolveCategory(config)
  const parentId = categoryResolution.categoryId ?? config.categoryId ?? undefined
  const body = {
    name: channelName,
    type: 0,
    parent_id: parentId,
  }

  const response = await discordFetch(config, `/guilds/${config.guildId}/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  const json = await requestJson<{ id?: string }>(response)
  if (!json.id) {
    throw new DiscordRelayError('Discord channel creation response missing id', response, json as DiscordErrorPayload)
  }

  return {
    channelId: json.id,
    channelName,
    guildId: config.guildId,
    url: `https://discord.com/channels/${config.guildId}/${json.id}`,
    categoryId: parentId,
    categoryName: categoryResolution.categoryName,
    createdCategory: categoryResolution.createdCategory,
  }
}

export const postMessage = async (config: DiscordConfig, channelId: string, content: string) => {
  if (!content) {
    return
  }

  await discordFetch(config, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export interface RelayOptions {
  dryRun?: boolean
  echo?: (line: string) => void
}

export const bootstrapRelay = async (
  config: DiscordConfig,
  metadata: RelayMetadata,
  options: RelayOptions = {},
): Promise<RelayBootstrapResult> => {
  if (options.dryRun) {
    const relayResult: RelayBootstrapResult = {
      channelId: 'dry-run',
      channelName: buildChannelName(metadata),
      guildId: config.guildId,
      url: `https://discord.com/channels/${config.guildId}/dry-run`,
    }
    options.echo?.(`[dry-run] Would create channel ${relayResult.channelName} in guild ${relayResult.guildId}`)
    options.echo?.(buildInitialMessage(metadata, relayResult))
    return relayResult
  }

  const relayResult = await createRelayChannel(config, metadata)
  if (options.echo && relayResult.createdCategory && relayResult.categoryName) {
    options.echo?.(`Created Discord category '${relayResult.categoryName}' for Codex relay channels.`)
  }
  await postMessage(config, relayResult.channelId, buildInitialMessage(metadata, relayResult))
  return relayResult
}

export const relayStream = async (
  config: DiscordConfig,
  relay: RelayBootstrapResult,
  stream: AsyncIterable<string>,
  options: RelayOptions = {},
) => {
  if (options.dryRun) {
    for await (const chunk of stream) {
      options.echo?.(`[dry-run] ${chunk}`)
    }
    return
  }

  let pending = ''
  for await (const chunk of stream) {
    pending += chunk
    const { chunks, remainder } = consumeChunks(pending)
    for (const part of chunks) {
      if (part) {
        await postMessage(config, relay.channelId, part)
      }
    }
    pending = remainder
  }

  if (pending.length > 0) {
    const parts = chunkContent(pending)
    for (const part of parts) {
      await postMessage(config, relay.channelId, part)
    }
  }
}

export const iterableFromStream = (input: NodeJS.ReadableStream): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    input.setEncoding('utf8')
    for await (const chunk of input as AsyncIterable<string | Buffer>) {
      if (typeof chunk === 'string') {
        yield chunk
      } else {
        yield chunk.toString('utf8')
      }
    }
  },
})
