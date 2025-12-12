import { Client, GatewayIntentBits } from 'discord.js'

import { createStreamingReply } from './discord-output'
import { streamChatCompletionsFromJangar } from './jangar'

const parseAllowlist = (value: string | undefined): Set<string> | undefined => {
  if (!value) {
    return undefined
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0) {
    return undefined
  }
  return new Set(items)
}

const requiredEnv = (key: string) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

const DISCORD_BOT_TOKEN = requiredEnv('DISCORD_BOT_TOKEN')
const JANGAR_BASE_URL = requiredEnv('JANGAR_BASE_URL')

const allowedGuildIds = parseAllowlist(process.env.DISCORD_ALLOWED_GUILD_IDS)
const allowedChannelIds = parseAllowlist(process.env.DISCORD_ALLOWED_CHANNEL_IDS)

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.on('ready', () => {
  if (!client.user) {
    console.log('Logged in (missing user)')
    return
  }
  console.log(`Logged in as ${client.user.tag}`)
})

client.on('messageCreate', async (message) => {
  if (!client.user) {
    return
  }

  if (message.author.bot) {
    return
  }

  if (!message.guildId || !message.channelId) {
    return
  }

  if (allowedGuildIds && !allowedGuildIds.has(message.guildId)) {
    return
  }

  if (allowedChannelIds && !allowedChannelIds.has(message.channelId)) {
    return
  }

  const mentionRegex = new RegExp(`^<@!?${client.user.id}>(\\s+|$)`, 'i')
  const trimmed = message.content.trim()
  if (!mentionRegex.test(trimmed)) {
    return
  }

  const prompt = trimmed.replace(mentionRegex, '').trim()
  if (!prompt) {
    await message.reply('Send a prompt after mentioning me, e.g. `<@BOT_ID> hello`.')
    return
  }

  const chatId = `discord:${message.guildId}:${message.channelId}:${message.author.id}`
  const streaming = await createStreamingReply({ message })
  let usage: unknown

  try {
    for await (const delta of streamChatCompletionsFromJangar({
      baseUrl: JANGAR_BASE_URL,
      chatId,
      prompt,
      onUsage: (value) => {
        usage = value
      },
    })) {
      await streaming.pushDelta(delta)
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    await streaming.pushDelta(`\n\nError: ${messageText}`)
  } finally {
    await streaming.finalize()
    if (usage !== undefined) {
      console.log('Usage', usage)
    }
  }
})

await client.login(DISCORD_BOT_TOKEN)
