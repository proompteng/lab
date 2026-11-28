import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'

import { readBoundedText } from '../auto-ontology-mcp/body'
import { ColabError } from './errors'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const adcSchema = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().trim().min(1),
  client_secret: z.string().trim().min(1),
  refresh_token: z.string().trim().min(1),
})
const tokenSchema = z.object({ access_token: z.string().max(16_384).regex(/^\S+$/), expires_in: z.int().positive() })

const unavailable = () =>
  new ColabError('colab_credentials_unavailable', 'Colab gateway credentials are missing or invalid.', true)

export const createColabTokenProvider = (
  path: string,
  options: { fetch?: FetchLike; read?: (path: string) => Promise<string>; now?: () => number } = {},
) => {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? fetch
  const read = options.read ?? ((file) => readFile(file, 'utf8'))
  let cached: { fingerprint: string; accessToken: string; refreshAt: number } | undefined
  let pending: Promise<string> | undefined

  const load = async () => {
    try {
      const raw = await read(path)
      return { adc: adcSchema.parse(JSON.parse(raw)), fingerprint: createHash('sha256').update(raw).digest('hex') }
    } catch {
      throw unavailable()
    }
  }

  const refresh = async () => {
    const { adc, fingerprint } = await load()
    if (cached?.fingerprint === fingerprint && cached.refreshAt > now()) return cached.accessToken
    const startedAt = now()
    const signal = AbortSignal.timeout(10_000)
    try {
      const { type: _type, ...credentials } = adc
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', ...credentials }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw unavailable()
      }
      const token = tokenSchema.parse(JSON.parse(await readBoundedText(response, 32_768, signal)))
      cached = {
        fingerprint,
        accessToken: token.access_token,
        refreshAt: startedAt + (token.expires_in - 60) * 1000,
      }
      return cached.accessToken
    } catch {
      throw unavailable()
    }
  }

  return {
    credentialsReady: async () =>
      load().then(
        () => true,
        () => false,
      ),
    getToken: () =>
      (pending ??= refresh().finally(() => {
        pending = undefined
      })),
    invalidate: (accessToken: string) => {
      if (cached?.accessToken === accessToken) cached = undefined
    },
  }
}
