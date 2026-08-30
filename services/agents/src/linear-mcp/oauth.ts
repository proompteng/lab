import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

export type LinearOAuthConfig = {
  clientId: string
  clientSecret: string
  tokenUrl: URL
  scopes: readonly string[]
}

export type LinearOAuthMetrics = {
  recordRefresh?: (outcome: 'success' | 'error' | 'unauthorized') => void
}

type CachedToken = {
  accessToken: string
  expiresAt: number
}

const combineSignal = (signal: AbortSignal | null | undefined, timeoutMs: number) => {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export class LinearOAuthTokenProvider {
  private cached: CachedToken | null = null
  private pending: Promise<CachedToken> | null = null

  constructor(
    private readonly config: LinearOAuthConfig,
    private readonly options: {
      fetch?: FetchLike
      now?: () => number
      timeoutMs?: number
      metrics?: LinearOAuthMetrics
    } = {},
  ) {}

  invalidate() {
    this.cached = null
  }

  async getToken() {
    const now = (this.options.now ?? Date.now)()
    if (this.cached && this.cached.expiresAt - now > 5 * 60 * 1000) return this.cached.accessToken
    if (!this.pending) {
      this.pending = this.fetchToken().finally(() => {
        this.pending = null
      })
    }
    const token = await this.pending
    return token.accessToken
  }

  private async fetchToken(): Promise<CachedToken> {
    const fetchImpl = this.options.fetch ?? fetch
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: this.config.scopes.join(','),
    })
    const authorization = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')
    let response: Response
    try {
      response = await fetchImpl(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${authorization}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: combineSignal(undefined, this.options.timeoutMs ?? 10_000),
      })
    } catch (error) {
      this.options.metrics?.recordRefresh?.('error')
      throw new Error(`Linear OAuth token request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      this.options.metrics?.recordRefresh?.(response.status === 401 ? 'unauthorized' : 'error')
      throw new Error(`Linear OAuth token request failed with HTTP ${response.status}`)
    }
    let payload: Record<string, unknown>
    try {
      const parsed = await response.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid response')
      payload = parsed as Record<string, unknown>
    } catch {
      this.options.metrics?.recordRefresh?.('error')
      throw new Error('Linear OAuth token response is invalid')
    }
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in)
    const scope =
      typeof payload.scope === 'string'
        ? payload.scope.split(/[ ,]+/).filter(Boolean)
        : Array.isArray(payload.scope)
          ? payload.scope.filter((entry): entry is string => typeof entry === 'string')
          : []
    if (!accessToken || accessToken.length > 16_384 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      this.options.metrics?.recordRefresh?.('error')
      throw new Error('Linear OAuth token response is invalid')
    }
    const missingScopes = this.config.scopes.filter((required) => !scope.includes(required))
    if (missingScopes.length > 0) {
      this.options.metrics?.recordRefresh?.('error')
      throw new Error(`Linear OAuth token is missing required scopes: ${missingScopes.join(', ')}`)
    }
    const token = {
      accessToken,
      expiresAt: (this.options.now ?? Date.now)() + expiresIn * 1000,
    }
    this.cached = token
    this.options.metrics?.recordRefresh?.('success')
    return token
  }
}

export const createLinearOAuthFetch =
  (tokenProvider: LinearOAuthTokenProvider, options: { fetch?: FetchLike } = {}): FetchLike =>
  async (input, init) => {
    const fetchImpl = options.fetch ?? fetch
    const send = async () => {
      const token = await tokenProvider.getToken()
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${token}`)
      return fetchImpl(input, { ...init, headers })
    }

    const response = await send()
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => undefined)
    tokenProvider.invalidate()
    return send()
  }
