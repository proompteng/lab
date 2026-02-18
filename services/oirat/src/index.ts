import { randomUUID } from 'node:crypto'

import { chunkContent, consumeChunks, DISCORD_MESSAGE_LIMIT } from '@proompteng/discord'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  Partials,
  type Snowflake,
  type ThreadChannel,
} from 'discord.js'
import { type Config, loadConfig } from './config'
import { buildMessageContent, buildThreadName } from './utils'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

type ThreadQueue = Map<string, Promise<void>>
type GuildMessage = Message<true>

type InflightState = {
  threadId: string
  requestId: string
  abortController: AbortController
  startedAt: number
  initiatorId?: string
  messageId?: string
  stoppedById?: string
}

type BotState = {
  client: Client
  config: Config
  threadQueues: ThreadQueue
  inflightByThread: Map<string, InflightState>
}

const STOP_COMMANDS = new Set(['stop', '!stop'])
const STOP_CUSTOM_ID_PREFIX = 'oirat-stop'
const JANGAR_CLIENT_KIND_HEADER = 'x-jangar-client-kind'

const logContext = (message: GuildMessage) => ({
  messageId: message.id,
  channelId: message.channelId,
  guildId: message.guild?.id,
  authorId: message.author.id,
  threadId: message.channel.isThread() ? message.channel.id : null,
})

const createClient = () =>
  new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
  })

const enqueueThread = (threadQueues: ThreadQueue, threadId: string, task: () => Promise<void>) => {
  const previous = threadQueues.get(threadId) ?? Promise.resolve()
  if (threadQueues.has(threadId)) {
    console.log(`[thread:${threadId}] queueing response behind previous task`)
  }
  const next = previous
    .then(async () => {
      console.log(`[thread:${threadId}] processing queued response`)
      await task()
    })
    .catch((error) => {
      console.error(`[thread:${threadId}] task failed`, error)
    })
    .finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId)
      }
    })
  threadQueues.set(threadId, next)
}

const isAllowedGuild = (config: Config, message: GuildMessage): boolean => {
  if (!config.allowedGuildIds) return true
  const guildId = message.guild?.id
  return guildId ? config.allowedGuildIds.has(guildId as Snowflake) : false
}

const isAllowedChannel = (config: Config, message: GuildMessage): boolean => {
  if (!config.allowedChannelIds) return true
  const channelId = message.channelId
  if (config.allowedChannelIds.has(channelId as Snowflake)) return true
  if (message.channel.isThread() && message.channel.parentId) {
    return config.allowedChannelIds.has(message.channel.parentId as Snowflake)
  }
  return false
}

const buildChatMessages = (state: BotState, messages: GuildMessage[]): ChatMessage[] => {
  const output: ChatMessage[] = []

  if (state.config.systemPrompt.trim().length > 0) {
    output.push({ role: 'system', content: state.config.systemPrompt })
  }

  for (const message of messages) {
    if (message.author.bot && message.author.id !== state.client.user?.id) {
      continue
    }

    const content = buildMessageContent({
      content: message.content,
      cleanContent: message.cleanContent,
      attachmentUrls: Array.from(message.attachments.values()).map((attachment) => attachment.url),
      botId: state.client.user?.id ?? null,
    })

    if (!content) continue

    const role: ChatMessage['role'] = message.author.id === state.client.user?.id ? 'assistant' : 'user'
    output.push({
      role,
      content,
      name: message.author.username,
    })
  }

  return output
}

const collectThreadMessages = async (
  state: BotState,
  thread: ThreadChannel,
  seed?: GuildMessage,
): Promise<GuildMessage[]> => {
  const fetched = await thread.messages.fetch({ limit: state.config.historyLimit })
  const messages = Array.from(fetched.values())
  if (seed && !messages.some((msg) => msg.id === seed.id)) {
    messages.push(seed)
  }
  const ordered = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
  console.log(`[thread:${thread.id}] fetched ${ordered.length} messages`)
  return ordered
}

const buildOpenWebUiChatId = (thread: { id: string; guildId?: string | null }): string =>
  thread.guildId ? `discord:${thread.guildId}:${thread.id}` : `discord:${thread.id}`

const buildStopCustomId = (threadId: string, requestId: string) => `${STOP_CUSTOM_ID_PREFIX}:${threadId}:${requestId}`

const parseStopCustomId = (customId: string): { threadId: string; requestId: string } | null => {
  if (!customId.startsWith(`${STOP_CUSTOM_ID_PREFIX}:`)) return null
  const [, threadId, ...rest] = customId.split(':')
  if (!threadId || rest.length === 0) return null
  return { threadId, requestId: rest.join(':') }
}

const buildStopComponents = (threadId: string, requestId: string): MessageCreateOptions['components'] => [
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildStopCustomId(threadId, requestId))
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger),
  ),
]

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.message.includes('AbortError'))

const stopInflight = (state: BotState, threadId: string, requestedBy: string, requestId?: string): boolean => {
  const inflight = state.inflightByThread.get(threadId)
  if (!inflight) return false
  if (requestId && inflight.requestId !== requestId) return false
  inflight.stoppedById = requestedBy
  if (!inflight.abortController.signal.aborted) {
    inflight.abortController.abort()
  }
  return true
}

const fetchJangarCompletion = async (
  state: BotState,
  messages: ChatMessage[],
  options: { chatId?: string; onDelta?: (delta: string) => Promise<void> | void; signal?: AbortSignal } = {},
): Promise<string> => {
  const payload = {
    model: state.config.jangarModel,
    messages,
    stream: true,
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (state.config.jangarApiKey) {
    headers.authorization = `Bearer ${state.config.jangarApiKey}`
  }
  if (options.chatId) {
    headers['x-openwebui-chat-id'] = options.chatId
    headers[JANGAR_CLIENT_KIND_HEADER] = 'discord'
  }

  const response = await fetch(`${state.config.jangarBaseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Jangar error ${response.status}: ${errorText}`)
  }

  if (!response.body) {
    throw new Error('Jangar response missing body')
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let output = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) break

      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      const dataLines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())

      if (dataLines.length === 0) continue

      const data = dataLines.join('\n')
      if (data === '[DONE]') {
        return output.trim()
      }

      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch (error) {
        console.warn('Failed to parse Jangar chunk', error)
        continue
      }

      if (payload && typeof payload === 'object') {
        const errorMessage = (payload as { error?: { message?: string } }).error?.message
        if (errorMessage) {
          throw new Error(`Jangar error: ${errorMessage}`)
        }

        const delta = (payload as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content
        if (typeof delta === 'string') {
          output += delta
          await options.onDelta?.(delta)
        }
      }
    }
  }

  return output.trim()
}

type TypingChannel = Pick<ThreadChannel, 'id' | 'sendTyping'>

const runWithTypingIndicator = async <T>(
  thread: TypingChannel,
  task: () => Promise<T>,
  options: { intervalMs?: number } = {},
): Promise<T> => {
  const intervalMs = options.intervalMs ?? 8_000
  let typingTimer: ReturnType<typeof setInterval> | null = null
  let typingInFlight = false
  let typingStopped = false

  const stopTyping = () => {
    if (typingStopped) return
    typingStopped = true
    if (typingTimer) {
      clearInterval(typingTimer)
      typingTimer = null
    }
  }

  const sendTyping = async () => {
    if (typingStopped || typingInFlight) return
    typingInFlight = true
    try {
      await thread.sendTyping()
    } catch (error) {
      console.warn(`[thread:${thread.id}] sendTyping failed`, error)
    } finally {
      typingInFlight = false
    }
  }

  await sendTyping()
  typingTimer = setInterval(() => {
    void sendTyping()
  }, intervalMs)

  try {
    return await task()
  } finally {
    stopTyping()
  }
}

type StreamWriterOptions<TMessage> = {
  getComponents?: () => MessageCreateOptions['components']
  onMessage?: (message: TMessage) => void
}

type SendPayload = string | MessageCreateOptions
type EditPayload = string | MessageEditOptions

const createDiscordStreamWriter = <TMessage extends { id: string; edit: (content: EditPayload) => Promise<unknown> }>(
  thread: { send: (content: SendPayload) => Promise<TMessage> },
  options: StreamWriterOptions<TMessage> = {},
) => {
  const flushIntervalMs = 400
  const flushThresholdChars = 280

  let currentMessage: TMessage | null = null
  let currentContent = ''
  let pendingBuffer = ''
  let sentAny = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let flushChain: Promise<void> = Promise.resolve()
  let flushError: Error | null = null
  let activeComponentsMessage: TMessage | null = null
  let activeComponentsContent = ''

  const buildCreatePayload = (
    content: string,
    components?: MessageCreateOptions['components'],
  ): MessageCreateOptions => {
    const payload: MessageCreateOptions = { content }
    if (components !== undefined) {
      payload.components = components
    }
    return payload
  }

  const buildEditPayload = (content: string, components?: MessageCreateOptions['components']): MessageEditOptions => {
    const payload: MessageEditOptions = { content }
    if (components !== undefined) {
      payload.components = components
    }
    return payload
  }

  const editMessage = async (message: TMessage, content: string, components?: MessageCreateOptions['components']) => {
    await message.edit(buildEditPayload(content, components))
  }

  const updateActiveComponents = async (message: TMessage, content: string) => {
    if (!options.getComponents) return
    if (activeComponentsMessage && activeComponentsMessage !== message) {
      await editMessage(activeComponentsMessage, activeComponentsContent, [])
    }
    activeComponentsMessage = message
    activeComponentsContent = content
  }

  const sendMessage = async (content: string, includeComponents: boolean) => {
    const components = includeComponents ? options.getComponents?.() : options.getComponents ? [] : undefined
    const message = await thread.send(buildCreatePayload(content, components))
    sentAny = true
    options.onMessage?.(message)
    if (includeComponents) {
      await updateActiveComponents(message, content)
    }
    return message
  }

  const upsertCurrentMessage = async (content: string, includeComponents: boolean) => {
    if (!currentMessage) {
      currentMessage = await sendMessage(content, includeComponents)
      return
    }
    const components = includeComponents ? options.getComponents?.() : options.getComponents ? [] : undefined
    await editMessage(currentMessage, content, components)
    sentAny = true
    if (includeComponents) {
      await updateActiveComponents(currentMessage, content)
    } else if (activeComponentsMessage === currentMessage) {
      activeComponentsMessage = null
      activeComponentsContent = ''
    }
  }

  const enqueueFlush = (task: () => Promise<void>) => {
    flushChain = flushChain.then(task).catch((error) => {
      const resolved = error instanceof Error ? error : new Error(String(error))
      flushError = resolved
      console.error('[discord-stream] flush failed', resolved)
    })
    return flushChain
  }

  const findFlushBoundary = (text: string) => {
    const boundaryPattern = /(?:\n|[.!?…]\s)/g
    let match: RegExpExecArray | null = boundaryPattern.exec(text)
    let lastIndex = -1
    let lastLength = 0
    while (match) {
      lastIndex = match.index
      lastLength = match[0].length
      match = boundaryPattern.exec(text)
    }
    if (lastIndex === -1) return null
    return lastIndex + lastLength
  }

  const selectFlushText = (text: string, final: boolean) => {
    if (final) {
      return { flushText: text, remainder: '' }
    }
    const boundaryIndex = findFlushBoundary(text)
    if (boundaryIndex !== null && boundaryIndex > 0 && boundaryIndex < text.length) {
      return {
        flushText: text.slice(0, boundaryIndex),
        remainder: text.slice(boundaryIndex),
      }
    }
    return { flushText: text, remainder: '' }
  }

  const applyDelta = async (delta: string) => {
    if (!delta) return
    currentContent += delta

    if (currentContent.length <= DISCORD_MESSAGE_LIMIT) {
      await upsertCurrentMessage(currentContent, true)
      return
    }

    const { chunks, remainder } = consumeChunks(currentContent, DISCORD_MESSAGE_LIMIT)

    if (chunks.length > 0) {
      const trailingChunks = chunks.slice(1)
      const hasRemainder = remainder.length > 0
      const keepComponentsOnCurrent = trailingChunks.length === 0 && !hasRemainder
      await upsertCurrentMessage(chunks[0], keepComponentsOnCurrent)
      for (const [index, chunk] of trailingChunks.entries()) {
        if (!chunk) continue
        const isLastChunk = index === trailingChunks.length - 1
        const includeComponents = isLastChunk && !hasRemainder
        currentMessage = await sendMessage(chunk, includeComponents)
      }
    }

    currentContent = remainder

    if (currentContent.length > 0) {
      currentMessage = await sendMessage(currentContent, true)
      return
    }

    currentMessage = null
  }

  const flushPending = async ({ final }: { final: boolean }) => {
    if (pendingBuffer.length === 0) return
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }

    const { flushText, remainder } = selectFlushText(pendingBuffer, final)
    if (!flushText) return
    pendingBuffer = remainder

    await enqueueFlush(async () => {
      await applyDelta(flushText)
    })

    if (!final && pendingBuffer.length >= flushThresholdChars) {
      await flushPending({ final: false })
    }
  }

  const scheduleFlush = () => {
    if (flushTimer || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushPending({ final: false })
    }, flushIntervalMs)
  }

  const pushDelta = async (delta: string) => {
    if (!delta || closed) return
    pendingBuffer += delta

    if (pendingBuffer.length >= flushThresholdChars) {
      await flushPending({ final: false })
      return
    }

    scheduleFlush()
  }

  const finalize = async () => {
    closed = true
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    await flushPending({ final: true })
    await flushChain
    if (options.getComponents && activeComponentsMessage) {
      await editMessage(activeComponentsMessage, activeComponentsContent, [])
      activeComponentsMessage = null
      activeComponentsContent = ''
    }
    if (flushError) {
      throw flushError
    }
  }

  return {
    pushDelta,
    finalize,
    hasSent: () => sentAny,
  }
}

const respondInThread = async (state: BotState, thread: ThreadChannel, seed?: GuildMessage) => {
  const messages = await collectThreadMessages(state, thread, seed)
  const chatMessages = buildChatMessages(state, messages)

  if (chatMessages.length === 0) {
    console.log(`[thread:${thread.id}] no chat messages to send`)
    return
  }

  const requestId = randomUUID()
  const inflight: InflightState = {
    threadId: thread.id,
    requestId,
    abortController: new AbortController(),
    startedAt: Date.now(),
    initiatorId: seed?.author.id,
  }
  state.inflightByThread.set(thread.id, inflight)

  const streamWriter = createDiscordStreamWriter(thread, {
    getComponents: () => buildStopComponents(thread.id, requestId),
    onMessage: (message) => {
      if (!inflight.messageId) {
        inflight.messageId = message.id
      }
    },
  })
  let responseText = ''
  let aborted = false
  let hadError = false
  let stoppedById: string | undefined
  try {
    responseText = await runWithTypingIndicator(thread, async () => {
      console.log(`[thread:${thread.id}] requesting completion`, { messageCount: chatMessages.length })
      const chatId = buildOpenWebUiChatId(thread)
      return await fetchJangarCompletion(state, chatMessages, {
        chatId,
        signal: inflight.abortController.signal,
        onDelta: async (delta) => {
          await streamWriter.pushDelta(delta)
        },
      })
    })
  } catch (error) {
    if (isAbortError(error)) {
      aborted = true
      stoppedById = inflight.stoppedById
    } else {
      hadError = true
      console.error(`[thread:${thread.id}] Jangar request failed`, error)
      if (!streamWriter.hasSent()) {
        await thread.send('Sorry, something went wrong while generating a reply.')
      }
    }
  } finally {
    state.inflightByThread.delete(thread.id)
  }

  if (aborted) {
    await streamWriter.finalize()
    const notice = stoppedById ? `Stopped by <@${stoppedById}>.` : 'Stopped.'
    await thread.send(notice)
    return
  }

  if (hadError) {
    await streamWriter.finalize().catch((error) => {
      console.error(`[thread:${thread.id}] Jangar stream cleanup failed`, error)
    })
    return
  }

  try {
    await streamWriter.finalize()
  } catch (error) {
    console.error(`[thread:${thread.id}] Jangar request failed`, error)
    return
  }

  if (streamWriter.hasSent()) {
    return
  }

  const chunks = chunkContent(responseText || '...')
  console.log(`[thread:${thread.id}] sending ${chunks.length} chunk(s)`)
  for (const chunk of chunks) {
    await thread.send(chunk)
  }
}

const handleMention = async (state: BotState, message: GuildMessage) => {
  if (!message.channel.isTextBased()) return

  console.log('Mention detected', logContext(message))

  let thread: ThreadChannel | null = null
  if (message.hasThread) {
    thread = message.thread ?? null
    if (!thread) {
      const refreshed = await message.fetch().catch(() => null)
      thread = refreshed?.thread ?? null
    }
  }

  if (!thread) {
    console.log('Creating thread for mention', {
      ...logContext(message),
      threadNamePrefix: state.config.threadNamePrefix,
    })
    thread = await message.startThread({
      name: buildThreadName({
        content: message.content,
        botId: state.client.user?.id ?? null,
        prefix: state.config.threadNamePrefix,
      }),
      autoArchiveDuration: state.config.threadAutoArchiveMinutes,
    })
  } else {
    console.log(`[thread:${thread.id}] reusing existing thread`, logContext(message))
  }

  if (!thread) {
    console.warn('Unable to resolve thread for message', message.id)
    return
  }

  enqueueThread(state.threadQueues, thread.id, async () => {
    await respondInThread(state, thread, message)
  })
}

const handleThreadMessage = async (state: BotState, message: GuildMessage, thread: ThreadChannel) => {
  const isBotThread = thread.ownerId === state.client.user?.id
  const mentionedBot = message.mentions.users.has(state.client.user?.id ?? '')

  const normalized = message.content.trim().toLowerCase()
  if (STOP_COMMANDS.has(normalized)) {
    stopInflight(state, thread.id, message.author.id)
    return
  }

  if (!isBotThread && !mentionedBot) {
    return
  }

  console.log(`[thread:${thread.id}] inbound thread message`, {
    ...logContext(message),
    isBotThread,
    mentionedBot,
  })

  enqueueThread(state.threadQueues, thread.id, async () => {
    await respondInThread(state, thread)
  })
}

const attachClientHandlers = (state: BotState) => {
  state.client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return

    const stopTarget = parseStopCustomId(interaction.customId)
    if (!stopTarget) return

    stopInflight(state, stopTarget.threadId, interaction.user.id, stopTarget.requestId)
    await interaction.deferUpdate().catch((error) => {
      console.warn('Failed to acknowledge stop interaction', error)
    })
  })

  state.client.on('messageCreate', async (message) => {
    if (message.author.bot) return
    if (!message.inGuild()) return
    if (!isAllowedGuild(state.config, message) || !isAllowedChannel(state.config, message)) return

    const botId = state.client.user?.id
    if (!botId) return

    if (message.channel.isThread()) {
      await handleThreadMessage(state, message, message.channel)
      return
    }

    const mentionedBot = message.mentions.users.has(botId)
    if (!mentionedBot) return

    await handleMention(state, message)
  })

  state.client.once('clientReady', () => {
    console.log(`Discord mention bot ready as ${state.client.user?.tag}`)
    console.log('Oirat config', {
      historyLimit: state.config.historyLimit,
      allowedGuilds: state.config.allowedGuildIds?.size ?? 0,
      allowedChannels: state.config.allowedChannelIds?.size ?? 0,
      threadNamePrefix: state.config.threadNamePrefix,
      threadAutoArchiveMinutes: state.config.threadAutoArchiveMinutes,
      jangarBaseUrl: state.config.jangarBaseUrl,
      jangarModel: state.config.jangarModel,
    })
  })

  state.client.on('error', (error) => {
    console.error('Discord client error', error)
  })
}

const runBot = async () => {
  const config = loadConfig()
  const client = createClient()
  const state: BotState = {
    client,
    config,
    threadQueues: new Map(),
    inflightByThread: new Map(),
  }

  attachClientHandlers(state)

  const shutdown = () => {
    console.log('Shutting down...')
    client.destroy()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await client.login(config.discordToken)
}

if (import.meta.main) {
  runBot().catch((error) => {
    console.error('Discord mention bot failed to start', error)
    process.exit(1)
  })
}

export const __testing = { runWithTypingIndicator, buildOpenWebUiChatId, createDiscordStreamWriter }
