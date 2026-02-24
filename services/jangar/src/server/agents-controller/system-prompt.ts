import { asRecord, asString, readNested } from '~/server/primitives-http'

import { isNonBlankString, sha256Hex } from './template-hash'

export const SYSTEM_PROMPT_INLINE_MAX_LENGTH = 16_384

export type SystemPromptRef = {
  kind: 'Secret' | 'ConfigMap'
  name: string
  key: string
}

type KubeClient = {
  get: (kind: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
}

const normalizeSystemPromptKind = (value: string): SystemPromptRef['kind'] | null => {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'secret') return 'Secret'
  if (normalized === 'configmap' || normalized === 'config-map') return 'ConfigMap'
  return null
}

export const parseSystemPromptRef = (raw: unknown) => {
  const record = asRecord(raw)
  if (!record) {
    return {
      ok: false as const,
      reason: 'InvalidSystemPromptRef',
      message: 'systemPromptRef must be an object',
    }
  }
  const kindRaw = asString(record.kind) ?? ''
  const kind = kindRaw ? normalizeSystemPromptKind(kindRaw) : null
  const name = asString(record.name)
  const key = asString(record.key)
  if (!kind || !name || !key) {
    return {
      ok: false as const,
      reason: 'InvalidSystemPromptRef',
      message: 'systemPromptRef.kind (Secret|ConfigMap), systemPromptRef.name, and systemPromptRef.key are required',
    }
  }
  return { ok: true as const, ref: { kind, name, key } satisfies SystemPromptRef }
}

export const resolveSystemPrompt = async (options: {
  kube: KubeClient
  namespace: string
  agentRun: Record<string, unknown>
  agent: Record<string, unknown> | null
  runSecrets: string[]
  allowedSecrets: string[]
  maxInlineLength?: number
}) => {
  const spec = asRecord(options.agentRun.spec) ?? {}
  const defaults = asRecord(readNested(options.agent, ['spec', 'defaults'])) ?? {}
  const maxInlineLength = options.maxInlineLength ?? SYSTEM_PROMPT_INLINE_MAX_LENGTH

  const candidates: Array<{ type: 'ref'; raw: unknown } | { type: 'inline'; raw: unknown }> = [
    { type: 'ref', raw: spec.systemPromptRef },
    { type: 'inline', raw: spec.systemPrompt },
    { type: 'ref', raw: defaults.systemPromptRef },
    { type: 'inline', raw: defaults.systemPrompt },
  ]

  for (const candidate of candidates) {
    if (candidate.raw == null) continue

    if (candidate.type === 'inline') {
      if (typeof candidate.raw !== 'string') {
        return {
          ok: false as const,
          reason: 'InvalidSystemPrompt',
          message: 'systemPrompt must be a string',
        }
      }
      const value = candidate.raw
      if (!isNonBlankString(value)) continue
      if (value.length > maxInlineLength) {
        return {
          ok: false as const,
          reason: 'SystemPromptTooLong',
          message: `systemPrompt exceeds ${maxInlineLength} characters`,
        }
      }
      return {
        ok: true as const,
        systemPrompt: value,
        systemPromptRef: null,
        systemPromptHash: sha256Hex(value),
      }
    }

    const parsed = parseSystemPromptRef(candidate.raw)
    if (!parsed.ok) return parsed
    const ref = parsed.ref

    if (ref.kind === 'Secret') {
      if (!options.runSecrets.includes(ref.name)) {
        return {
          ok: false as const,
          reason: 'SecretNotAllowed',
          message: `system prompt secret ${ref.name} is not included in spec.secrets`,
        }
      }
      if (options.allowedSecrets.length > 0 && !options.allowedSecrets.includes(ref.name)) {
        return {
          ok: false as const,
          reason: 'SecretNotAllowed',
          message: `system prompt secret ${ref.name} is not allowlisted by the Agent`,
        }
      }
    }

    const resource = await options.kube.get(ref.kind === 'Secret' ? 'secret' : 'configmap', ref.name, options.namespace)
    if (!resource) {
      return {
        ok: false as const,
        reason: 'MissingSystemPromptRef',
        message: `${ref.kind} ${ref.name} not found`,
      }
    }

    const contents = (() => {
      if (ref.kind === 'ConfigMap') {
        const data = asRecord(resource.data) ?? {}
        const value = data[ref.key]
        return typeof value === 'string' ? value : null
      }

      const stringData = asRecord(resource.stringData) ?? null
      const fromStringData = stringData ? stringData[ref.key] : null
      if (typeof fromStringData === 'string') {
        return fromStringData
      }
      const data = asRecord(resource.data) ?? {}
      const encoded = data[ref.key]
      if (typeof encoded !== 'string' || encoded.length === 0) return null
      return Buffer.from(encoded, 'base64').toString('utf8')
    })()

    if (!isNonBlankString(contents)) {
      return {
        ok: false as const,
        reason: 'MissingSystemPromptRef',
        message: `${ref.kind} ${ref.name} is missing key ${ref.key}`,
      }
    }

    return {
      ok: true as const,
      systemPrompt: null,
      systemPromptRef: ref,
      systemPromptHash: sha256Hex(contents),
    }
  }

  return {
    ok: true as const,
    systemPrompt: null,
    systemPromptRef: null,
    systemPromptHash: null,
  }
}
