import type { Snowflake } from 'discord.js'

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant in Discord. Keep replies concise, be direct, and avoid unnecessary pings.'
export const DEFAULT_HISTORY_LIMIT = 24
export const DEFAULT_THREAD_PREFIX = 'Jangar'
export const DEFAULT_THREAD_ARCHIVE_MINUTES = 1440
export const ALLOWED_THREAD_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080])

export type Config = {
  discordToken: string
  jangarBaseUrl: string
  jangarModel?: string
  jangarApiKey?: string
  systemPrompt: string
  allowedGuildIds: Set<Snowflake> | null
  allowedChannelIds: Set<Snowflake> | null
  historyLimit: number
  threadNamePrefix: string
  threadAutoArchiveMinutes: number
}

export const requiredEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

export const parseList = (value?: string): Set<Snowflake> | null => {
  if (!value) return null
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return items.length > 0 ? new Set(items as Snowflake[]) : null
}

export const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const parseArchiveMinutes = (value: string | undefined, fallback: number): number => {
  const parsed = parseNumber(value, fallback)
  return ALLOWED_THREAD_ARCHIVE_MINUTES.has(parsed) ? parsed : fallback
}

export const loadConfig = (): Config => ({
  discordToken: requiredEnv('DISCORD_BOT_TOKEN'),
  jangarBaseUrl: requiredEnv('JANGAR_BASE_URL').replace(/\/$/, ''),
  jangarModel: process.env.JANGAR_MODEL,
  jangarApiKey: process.env.JANGAR_API_KEY,
  systemPrompt: process.env.JANGAR_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
  allowedGuildIds: parseList(process.env.DISCORD_ALLOWED_GUILD_IDS),
  allowedChannelIds: parseList(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
  historyLimit: parseNumber(process.env.DISCORD_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT),
  threadNamePrefix: process.env.DISCORD_THREAD_NAME_PREFIX ?? DEFAULT_THREAD_PREFIX,
  threadAutoArchiveMinutes: parseArchiveMinutes(
    process.env.DISCORD_THREAD_AUTO_ARCHIVE_MINUTES,
    DEFAULT_THREAD_ARCHIVE_MINUTES,
  ),
})
