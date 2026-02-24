import { asString, readNested } from '~/server/primitives-http'
import { parseEnvRecord } from './env-config'

export type VcsMode = 'read-write' | 'read-only' | 'none'
export type VcsAuthMethod = 'token' | 'app' | 'ssh' | 'none'
export type VcsTokenType = 'pat' | 'fine_grained' | 'api_token' | 'access_token'

type VcsAuthAdapter = {
  provider: string
  allowedMethods: VcsAuthMethod[]
  tokenTypes?: VcsTokenType[]
  deprecatedTokenTypes?: VcsTokenType[]
  defaultUsername?: string
  defaultTokenType?: VcsTokenType
}

export type VcsAuthValidation =
  | { ok: false; reason: string; message: string }
  | {
      ok: true
      method: VcsAuthMethod
      warnings: Array<{ reason: string; message: string }>
      defaultUsername: string | null
      tokenType: VcsTokenType | null
    }

const VCS_TOKEN_TYPE_ALIASES: Record<string, VcsTokenType> = {
  'personal-access-token': 'pat',
  personal_access_token: 'pat',
  'fine-grained': 'fine_grained',
  finegrained: 'fine_grained',
  api: 'api_token',
  access: 'access_token',
}

const DEFAULT_VCS_AUTH_ADAPTERS: Record<string, VcsAuthAdapter> = {
  github: {
    provider: 'github',
    allowedMethods: ['token', 'app', 'ssh', 'none'],
    tokenTypes: ['pat', 'fine_grained', 'access_token'],
    deprecatedTokenTypes: ['pat'],
    defaultUsername: 'x-access-token',
    defaultTokenType: 'fine_grained',
  },
  gitlab: {
    provider: 'gitlab',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['pat', 'access_token'],
    defaultUsername: 'oauth2',
    defaultTokenType: 'access_token',
  },
  bitbucket: {
    provider: 'bitbucket',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['access_token'],
    defaultUsername: 'x-token-auth',
    defaultTokenType: 'access_token',
  },
  gitea: {
    provider: 'gitea',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['api_token', 'access_token'],
    defaultUsername: 'git',
    defaultTokenType: 'api_token',
  },
  generic: {
    provider: 'generic',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['pat', 'fine_grained', 'api_token', 'access_token'],
    defaultUsername: 'git',
  },
}

export const normalizeVcsMode = (value: unknown): VcsMode => {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'read-only' || raw === 'read-write' || raw === 'none') return raw
  return 'read-write'
}

export const resolveVcsAuthMethod = (auth: Record<string, unknown>): VcsAuthMethod => {
  const explicit = asString(auth.method)?.toLowerCase()
  if (explicit === 'token' || explicit === 'app' || explicit === 'ssh' || explicit === 'none') {
    return explicit
  }
  const tokenSecret = asString(readNested(auth, ['token', 'secretRef', 'name']))
  if (tokenSecret) return 'token'
  const appSecret = asString(readNested(auth, ['app', 'privateKeySecretRef', 'name']))
  if (appSecret) return 'app'
  const sshSecret = asString(readNested(auth, ['ssh', 'privateKeySecretRef', 'name']))
  if (sshSecret) return 'ssh'
  return 'none'
}

const normalizeTokenType = (value: unknown): VcsTokenType | null => {
  const raw = asString(value)?.trim().toLowerCase()
  if (!raw) return null
  const normalized = raw.replace(/-/g, '_')
  return VCS_TOKEN_TYPE_ALIASES[normalized] ?? (normalized as VcsTokenType)
}

const normalizeTokenTypeOverrides = (value: unknown) => {
  if (!Array.isArray(value)) return null
  const tokens = value.map((entry) => normalizeTokenType(entry)).filter((entry): entry is VcsTokenType => !!entry)
  return tokens.length > 0 ? tokens : []
}

const resolveDeprecatedTokenTypeOverrides = () => {
  const overrides = parseEnvRecord('JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES')
  if (!overrides) return null
  const output: Record<string, VcsTokenType[]> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = normalizeTokenTypeOverrides(value)
    if (normalized) output[key] = normalized
  }
  return Object.keys(output).length > 0 ? output : null
}

const resolveVcsAuthAdapter = (providerType: string | null) => {
  const key = providerType ?? 'generic'
  const base = DEFAULT_VCS_AUTH_ADAPTERS[key] ?? DEFAULT_VCS_AUTH_ADAPTERS.generic
  const overrides = resolveDeprecatedTokenTypeOverrides()
  const deprecatedTokenTypes = overrides?.[key] ?? base.deprecatedTokenTypes ?? []
  return {
    ...base,
    deprecatedTokenTypes,
  }
}

export const validateVcsAuthConfig = (
  providerType: string | null,
  auth: Record<string, unknown>,
): VcsAuthValidation => {
  const adapter = resolveVcsAuthAdapter(providerType)
  const method = resolveVcsAuthMethod(auth)
  if (!adapter.allowedMethods.includes(method)) {
    return {
      ok: false as const,
      reason: 'UnsupportedAuth',
      message: `auth.method=${method} is not supported for ${adapter.provider} providers`,
    }
  }

  const warnings: Array<{ reason: string; message: string }> = []
  let resolvedTokenType: VcsTokenType | null = null
  if (method === 'token') {
    resolvedTokenType = normalizeTokenType(readNested(auth, ['token', 'type'])) ?? adapter.defaultTokenType ?? null
    if (resolvedTokenType && adapter.tokenTypes && !adapter.tokenTypes.includes(resolvedTokenType)) {
      return {
        ok: false as const,
        reason: 'UnsupportedAuth',
        message: `auth.token.type=${resolvedTokenType} is not supported for ${adapter.provider} providers`,
      }
    }
    if (resolvedTokenType && (adapter.deprecatedTokenTypes ?? []).includes(resolvedTokenType)) {
      warnings.push({
        reason: 'DeprecatedAuth',
        message: `auth.token.type=${resolvedTokenType} is deprecated for ${adapter.provider} providers`,
      })
    }
  }

  return {
    ok: true as const,
    method,
    warnings,
    defaultUsername: adapter.defaultUsername ?? null,
    tokenType: resolvedTokenType,
  }
}
