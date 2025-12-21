import type { PlainMessage } from '@bufbuild/protobuf'
import { verifyKey } from 'discord-interactions'

import { logger } from '@/logger'
import type {
  CommandEvent as FacteurCommandEventMessage,
  DiscordMember as FacteurDiscordMemberMessage,
  DiscordUser as FacteurDiscordUserMessage,
  Response as FacteurResponseMessage,
} from '@/proto/proompteng/facteur/v1/contract_pb'

export type FacteurCommandEvent = PlainMessage<FacteurCommandEventMessage>
export type FacteurDiscordMember = PlainMessage<FacteurDiscordMemberMessage>
export type FacteurDiscordUser = PlainMessage<FacteurDiscordUserMessage>
export type FacteurResponse = PlainMessage<FacteurResponseMessage>
export type DiscordCommandEvent = FacteurCommandEvent

const SIGNATURE_HEADER = 'x-signature-ed25519'
const TIMESTAMP_HEADER = 'x-signature-timestamp'

export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const

export type InteractionType = (typeof INTERACTION_TYPE)[keyof typeof INTERACTION_TYPE]

export interface DiscordInteraction<TData = unknown> {
  type: InteractionType
  id: string
  token: string
  version: number
  application_id: string
  data?: TData
  guild_id?: string
  channel_id?: string
  member?: DiscordGuildMember
  user?: DiscordUser
  locale?: string
  guild_locale?: string
}

export type DiscordApplicationCommandInteraction = DiscordInteraction<DiscordApplicationCommandData>

export interface DiscordApplicationCommandData {
  id: string
  name: string
  type: number
  options?: DiscordApplicationCommandOption[]
}

export interface DiscordApplicationCommandOption {
  name: string
  type: number
  value?: unknown
  options?: DiscordApplicationCommandOption[]
}

export interface DiscordModalSubmitData {
  custom_id: string
  components: DiscordModalActionRow[]
}

export interface DiscordModalActionRow {
  type: number
  components: DiscordModalComponent[]
}

export interface DiscordModalComponent {
  type: number
  custom_id: string
  value?: unknown
}

export type DiscordModalSubmitInteraction = DiscordInteraction<DiscordModalSubmitData>

export interface DiscordGuildMember {
  user?: DiscordUser
  roles?: string[]
  permissions?: string
}

export interface DiscordUser {
  id: string
  username?: string
  global_name?: string | null
  discriminator?: string
}

export interface DiscordResponseConfig {
  deferType: 'channel-message'
  ephemeral: boolean
}

export const verifyDiscordRequest = async (
  rawBody: Uint8Array,
  headers: Headers,
  publicKey: string,
): Promise<boolean> => {
  const signature = headers.get(SIGNATURE_HEADER)
  const timestamp = headers.get(TIMESTAMP_HEADER)

  if (!signature || !timestamp) {
    return false
  }

  try {
    return await verifyKey(rawBody, signature, timestamp, publicKey)
  } catch (error) {
    logger.error({ err: error }, 'discord signature verification error')
    return false
  }
}

export const buildDeferredResponsePayload = (config: DiscordResponseConfig) => {
  const flags = config.ephemeral ? 1 << 6 : undefined
  return {
    type: config.deferType === 'channel-message' ? 5 : 5,
    data: flags ? { flags } : undefined,
  }
}

const PLAN_MODAL_PREFIX = 'plan'
const PLAN_MODAL_CONTENT_FIELD = 'content'
const ACTION_ROW_TYPE = 1
const TEXT_INPUT_TYPE = 4

export interface DiscordModalResponse {
  type: 9
  data: {
    custom_id: string
    title: string
    components: Array<{
      type: number
      components: Array<{
        type: number
        custom_id: string
        label: string
        style: number
        placeholder?: string
        min_length?: number
        max_length?: number
        required?: boolean
      }>
    }>
  }
}

export const buildPlanModalResponse = (interaction: DiscordApplicationCommandInteraction): DiscordModalResponse => {
  const commandId = interaction.data?.id
  if (!commandId) {
    throw new Error('Cannot build implementation modal without command identifier')
  }

  return {
    type: 9,
    data: {
      custom_id: `${PLAN_MODAL_PREFIX}:${commandId}`,
      title: 'Request Implementation Run',
      components: [
        {
          type: ACTION_ROW_TYPE,
          components: [
            {
              type: TEXT_INPUT_TYPE,
              custom_id: PLAN_MODAL_CONTENT_FIELD,
              label: 'Content',
              style: 2,
              placeholder: 'Describe the work Codex should implement...',
              min_length: 10,
              max_length: 4000,
              required: true,
            },
          ],
        },
      ],
    },
  }
}

export const toPlanModalEvent = (
  interaction: DiscordModalSubmitInteraction,
  responseConfig: DiscordResponseConfig,
): DiscordCommandEvent => {
  if (interaction.type !== INTERACTION_TYPE.MODAL_SUBMIT) {
    throw new Error(`Unsupported interaction type for implementation modal: ${interaction.type}`)
  }

  const data = interaction.data
  if (!data) {
    throw new Error('Missing modal submission payload')
  }

  const { custom_id: customId } = data
  if (!customId) {
    throw new Error('Modal submission missing custom identifier')
  }

  const commandId = parsePlanModalCommandId(customId)
  const optionValues = extractModalValues(data.components)
  const content = optionValues[PLAN_MODAL_CONTENT_FIELD]?.trim()

  if (!content) {
    throw new Error('Modal submission missing required content field')
  }

  const user = resolveUser(interaction)

  return {
    provider: 'discord',
    interactionId: interaction.id,
    applicationId: interaction.application_id,
    command: PLAN_MODAL_PREFIX,
    commandId,
    version: interaction.version,
    token: interaction.token,
    options: {
      [PLAN_MODAL_CONTENT_FIELD]: content,
    },
    guildId: interaction.guild_id ?? '',
    channelId: interaction.channel_id ?? '',
    user: {
      id: user?.id ?? '',
      username: user?.username ?? '',
      globalName: user?.global_name ?? '',
      discriminator: user?.discriminator ?? '',
    },
    member: interaction.member
      ? {
          id: interaction.member.user?.id ?? '',
          roles: interaction.member.roles ?? [],
        }
      : undefined,
    locale: interaction.locale ?? '',
    guildLocale: interaction.guild_locale ?? '',
    response: {
      type: 4,
      ...(responseConfig.ephemeral ? { flags: 1 << 6 } : {}),
    },
    timestamp: new Date().toISOString(),
  }
}

export const toCommandEvent = (
  interaction: DiscordApplicationCommandInteraction,
  responseConfig: DiscordResponseConfig,
): FacteurCommandEvent => {
  if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) {
    throw new Error(`Unsupported interaction type: ${interaction.type}`)
  }

  if (!interaction.data) {
    throw new Error('Missing interaction data for command')
  }

  if (!interaction.id || !interaction.token) {
    throw new Error('Interaction missing id or token')
  }

  const commandName = interaction.data.name
  const commandId = interaction.data.id

  if (!commandName || !commandId) {
    throw new Error('Interaction missing command metadata')
  }

  const options = flattenOptions(interaction.data.options)
  const user = resolveUser(interaction)
  const protoUser: FacteurDiscordUser | undefined = user
    ? {
        id: user.id ?? '',
        username: user.username ?? '',
        globalName: user.global_name ?? '',
        discriminator: user.discriminator ?? '',
      }
    : undefined

  const protoMember: FacteurDiscordMember | undefined = interaction.member
    ? {
        id: interaction.member.user?.id ?? '',
        roles: interaction.member.roles ?? [],
      }
    : undefined

  const response: FacteurResponse = {
    type: 4,
    ...(responseConfig.ephemeral ? { flags: 1 << 6 } : {}),
  }

  return {
    provider: 'discord',
    interactionId: interaction.id,
    applicationId: interaction.application_id,
    command: commandName,
    commandId,
    version: interaction.version,
    token: interaction.token,
    options,
    guildId: interaction.guild_id ?? '',
    channelId: interaction.channel_id ?? '',
    user: protoUser,
    member: protoMember,
    locale: interaction.locale ?? '',
    guildLocale: interaction.guild_locale ?? '',
    response,
    timestamp: new Date().toISOString(),
    correlationId: '',
    traceId: '',
  }
}

const flattenOptions = (options?: DiscordApplicationCommandOption[]): Record<string, string> => {
  const result: Record<string, string> = {}

  if (!options || options.length === 0) {
    return result
  }

  const visit = (opts: DiscordApplicationCommandOption[], path: string[] = []) => {
    for (const option of opts) {
      const nextPath = [...path, option.name]
      if (option.options && option.options.length > 0) {
        visit(option.options, nextPath)
      }

      if (option.value !== undefined) {
        const key = nextPath.join('.')
        result[key] = toStringValue(option.value)
      }
    }
  }

  visit(options)

  return result
}

const parsePlanModalCommandId = (customId: string): string => {
  const [prefix, commandId] = customId.split(':', 2)
  if (prefix !== PLAN_MODAL_PREFIX || !commandId) {
    throw new Error(`Unsupported implementation modal identifier: ${customId}`)
  }
  return commandId
}

const extractModalValues = (rows: DiscordModalActionRow[] = []): Record<string, string> => {
  const values: Record<string, string> = {}

  for (const row of rows) {
    if (!row?.components) {
      continue
    }
    for (const component of row.components) {
      if (!component?.custom_id) {
        continue
      }
      if (component.value === undefined || component.value === null) {
        values[component.custom_id] = ''
      } else {
        values[component.custom_id] = toStringValue(component.value)
      }
    }
  }

  return values
}

const toStringValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  return JSON.stringify(value)
}

const resolveUser = (interaction: DiscordInteraction): DiscordUser | undefined => {
  return interaction.member?.user ?? interaction.user
}
