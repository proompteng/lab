import { createPrivateKey, createSign } from 'node:crypto'

import { asRecord, asString, readNested } from '~/server/primitives-http'
import { RESOURCE_MAP } from '~/server/primitives-kube'
import { parseBooleanEnv, parseEnvStringList, parseJsonEnv, parseStringList } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import { matchesAnyPattern } from './policy'
import { appendBranchSuffix, hasBranchConflict, resolveParam, setMetadataIfMissing } from './run-utils'
import { renderTemplate } from './template-hash'
import { normalizeVcsMode, resolveVcsAuthMethod, type VcsMode, validateVcsAuthConfig } from './vcs-auth'

const DEFAULT_AUTH_SECRET_KEY = 'auth.json'
const DEFAULT_AUTH_SECRET_MOUNT_PATH = '/root/.codex'
const DEFAULT_GITHUB_APP_TOKEN_TTL_SECONDS = 3600
const DEFAULT_GITHUB_APP_TOKEN_REFRESH_WINDOW_SECONDS = 300
const MIN_GITHUB_APP_TOKEN_REFRESH_WINDOW_SECONDS = 30

const githubAppTokenCache = new Map<string, { token: string; expiresAt: number; refreshAfter: number }>()

const isVcsProvidersEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true)

const makeName = (base: string, suffix: string) => {
  const raw = `${base}-${suffix}`
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
}

export type EnvVar = {
  name: string
  value?: string
  valueFrom?: Record<string, unknown>
}

export type VcsRuntimeConfig = {
  env: EnvVar[]
  volumes: Array<{ name: string; spec: Record<string, unknown> }>
  volumeMounts: Array<Record<string, unknown>>
}

export type VcsResolution = {
  ok: boolean
  skip: boolean
  reason?: string
  message?: string
  mode: VcsMode
  status?: Record<string, unknown> | null
  context?: Record<string, unknown> | null
  runtime?: VcsRuntimeConfig | null
  warnings?: Array<{ reason: string; message: string }>
  requiredSecrets: string[]
}

export type AuthSecretConfig = {
  name: string
  key: string
  mountPath: string
}

type KubeClient = {
  get: (kind: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
}
export const resolveAuthSecretConfig = (): AuthSecretConfig | null => {
  const name = asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME)?.trim()
  if (!name) return null
  const key = asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY)?.trim() || DEFAULT_AUTH_SECRET_KEY
  const mountPath =
    asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH)?.trim() || DEFAULT_AUTH_SECRET_MOUNT_PATH
  return { name, key, mountPath }
}

export const buildAuthSecretPath = (config: AuthSecretConfig) => {
  const normalizedMountPath = config.mountPath.endsWith('/') ? config.mountPath.slice(0, -1) : config.mountPath
  return `${normalizedMountPath}/${config.key}`
}

export const collectBlockedSecrets = (secrets: string[]) => {
  const blocked = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS')
  if (blocked.length === 0) return []
  const blockedSet = new Set(blocked)
  return Array.from(new Set(secrets.filter((secret) => blockedSet.has(secret))))
}

const encodeBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')

export const parseIntOrString = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

export const resolveSecretValue = (secret: Record<string, unknown>, key: string) => {
  const stringData = asRecord(secret.stringData) ?? {}
  const stringValue = stringData[key]
  if (typeof stringValue === 'string') return stringValue
  const data = asRecord(secret.data) ?? {}
  const raw = data[key]
  if (typeof raw !== 'string') return null
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return raw
  }
}

export const secretHasKey = (secret: Record<string, unknown>, key: string) => {
  const data = asRecord(secret.data) ?? {}
  const stringData = asRecord(secret.stringData) ?? {}
  return key in data || key in stringData
}

export const fetchGithubAppToken = async (input: {
  apiBaseUrl: string
  appId: string
  installationId: string
  privateKey: string
  ttlSeconds?: number
}) => {
  const cacheKey = `${input.apiBaseUrl}|${input.installationId}`
  const cached = githubAppTokenCache.get(cacheKey)
  const now = Date.now()
  if (cached && now < cached.refreshAfter) {
    return cached.token
  }

  const nowSeconds = Math.floor(now / 1000)
  const payload = {
    iat: nowSeconds - 30,
    exp: nowSeconds + 540,
    iss: input.appId,
  }
  const header = { alg: 'RS256', typ: 'JWT' }
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(createPrivateKey(input.privateKey))
  const jwt = `${signingInput}.${encodeBase64Url(signature)}`

  const response = await fetch(
    `${input.apiBaseUrl.replace(/\/+$/, '')}/app/installations/${input.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
      },
    },
  )

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`GitHub App token request failed: ${response.status} ${response.statusText} ${details}`.trim())
  }

  const payloadResponse = (await response.json()) as Record<string, unknown>
  const token = asString(payloadResponse.token)
  if (!token) {
    throw new Error('GitHub App token response missing token')
  }

  const expiresAtRaw = asString(payloadResponse.expires_at)
  const ttlSeconds = typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0 ? input.ttlSeconds : undefined
  const fallbackExpiresAt = now + (ttlSeconds ?? DEFAULT_GITHUB_APP_TOKEN_TTL_SECONDS) * 1000
  const parsedExpiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : NaN
  const expiresAtMs = Number.isNaN(parsedExpiresAt) ? fallbackExpiresAt : parsedExpiresAt
  const ttlMs = Math.max(0, expiresAtMs - now)
  const refreshWindowMs = Math.min(
    DEFAULT_GITHUB_APP_TOKEN_REFRESH_WINDOW_SECONDS * 1000,
    Math.max(MIN_GITHUB_APP_TOKEN_REFRESH_WINDOW_SECONDS * 1000, Math.floor(ttlMs * 0.1)),
  )
  const refreshAfter = Math.max(now, expiresAtMs - refreshWindowMs)
  githubAppTokenCache.set(cacheKey, {
    token,
    expiresAt: expiresAtMs,
    refreshAfter,
  })
  return token
}

export const clearGithubAppTokenCache = () => {
  githubAppTokenCache.clear()
}

export const resolveVcsPrRateLimits = () => {
  const parsed = parseJsonEnv('JANGAR_AGENTS_CONTROLLER_VCS_PR_RATE_LIMITS')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length === 0) return null
  return record
}

const { buildEventContext } = createImplementationContractTools(resolveParam)

export const resolveVcsContext = async ({
  kube,
  namespace,
  agentRun,
  agent,
  implementation,
  parameters,
  allowedSecrets,
  existingRuns,
}: {
  kube: KubeClient
  namespace: string
  agentRun: Record<string, unknown>
  agent: Record<string, unknown>
  implementation: Record<string, unknown>
  parameters: Record<string, string>
  allowedSecrets: string[]
  existingRuns?: Record<string, unknown>[]
}): Promise<VcsResolution> => {
  if (!isVcsProvidersEnabled()) {
    return {
      ok: true,
      skip: true,
      reason: 'VcsProvidersDisabled',
      message: 'vcs providers are disabled by configuration',
      mode: 'none',
      requiredSecrets: [],
    }
  }

  const spec = asRecord(agentRun.spec) ?? {}
  const policy = asRecord(spec.vcsPolicy) ?? {}
  const required = policy.required === true
  const desiredMode = normalizeVcsMode(policy.mode)

  const runMetadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(runMetadata.name) ?? 'agentrun'

  const eventContext = buildEventContext(implementation, parameters)
  const metadata = eventContext.metadata
  const repository = asString(metadata.repository) ?? ''

  const runVcsRef = asString(readNested(spec, ['vcsRef', 'name']))
  const implVcsRef = asString(readNested(implementation, ['vcsRef', 'name']))
  const agentVcsRef = asString(readNested(agent, ['spec', 'vcsRef', 'name']))
  const vcsRefName = runVcsRef || implVcsRef || agentVcsRef

  if (!vcsRefName) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingVcsProvider',
        message: 'vcsRef is required when vcsPolicy.required is true',
        mode: 'none',
        requiredSecrets: [],
      }
    }
    return { ok: true, skip: true, mode: 'none', requiredSecrets: [] }
  }

  const provider = await kube.get(RESOURCE_MAP.VersionControlProvider, vcsRefName, namespace)
  if (!provider) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingVcsProvider',
        message: `version control provider ${vcsRefName} not found`,
        mode: 'none',
        status: { provider: vcsRefName, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'MissingVcsProvider',
      message: `version control provider ${vcsRefName} not found`,
      status: { provider: vcsRefName, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const providerType = asString(providerSpec.provider) ?? 'generic'
  const apiBaseUrl = asString(providerSpec.apiBaseUrl) ?? (providerType === 'github' ? 'https://api.github.com' : null)
  const cloneBaseUrl = asString(providerSpec.cloneBaseUrl)
  const webBaseUrl = asString(providerSpec.webBaseUrl)
  const cloneProtocol = asString(providerSpec.cloneProtocol)
  const sshHost = asString(providerSpec.sshHost)
  const sshUser = asString(providerSpec.sshUser)

  if (!repository) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingRepository',
        message: 'repository is required for version control operations',
        mode: 'none',
        status: { provider: vcsRefName, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'MissingRepository',
      message: 'repository is required for version control operations',
      status: { provider: vcsRefName, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const repositoryPolicy = asRecord(providerSpec.repositoryPolicy) ?? {}
  const allowList = parseStringList(repositoryPolicy.allow)
  const denyList = parseStringList(repositoryPolicy.deny)
  if (matchesAnyPattern(repository, denyList)) {
    if (desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'VcsPolicyDenied',
        message: `repository ${repository} is denied by policy`,
        mode: 'none',
        status: { provider: vcsRefName, repository, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsPolicyDenied',
      message: `repository ${repository} is denied by policy`,
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }
  if (allowList.length > 0 && !matchesAnyPattern(repository, allowList)) {
    if (desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'VcsPolicyDenied',
        message: `repository ${repository} is not in the allow list`,
        mode: 'none',
        status: { provider: vcsRefName, repository, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsPolicyDenied',
      message: `repository ${repository} is not in the allow list`,
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }

  if (desiredMode === 'none') {
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsDisabled',
      message: 'vcsPolicy.mode is none',
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const capabilities = asRecord(providerSpec.capabilities) ?? {}
  const canRead = readNested(capabilities, ['read']) !== false
  const canWrite = readNested(capabilities, ['write']) !== false
  const canPr = readNested(capabilities, ['pullRequests']) !== false

  let effectiveMode: VcsMode = desiredMode
  if (effectiveMode === 'read-write' && !canWrite) {
    effectiveMode = 'read-only'
  }
  if (effectiveMode === 'read-only' && !canRead) {
    effectiveMode = 'none'
  }

  if (required && desiredMode !== effectiveMode) {
    return {
      ok: false,
      skip: false,
      reason: 'VcsCapabilityDenied',
      message: `provider ${vcsRefName} cannot satisfy ${desiredMode}`,
      mode: effectiveMode,
      status: { provider: vcsRefName, repository, mode: effectiveMode },
      requiredSecrets: [],
    }
  }

  const defaults = asRecord(providerSpec.defaults) ?? {}
  const pullRequestDefaults = asRecord(defaults.pullRequest) ?? {}
  const baseBranch = asString(metadata.base) ?? asString(defaults.baseBranch) ?? ''
  let headBranch = asString(metadata.head) ?? ''
  const branchTemplate = asString(defaults.branchTemplate)
  const conflictSuffixTemplate = asString(defaults.branchConflictSuffixTemplate)
  const templateContext = {
    ...metadata,
    ...parameters,
    agentRun: {
      name: runName,
      namespace: asString(runMetadata.namespace) ?? namespace,
    },
    parameters,
    metadata,
    event: eventContext.payload,
  }
  if (!headBranch && branchTemplate) {
    headBranch = renderTemplate(branchTemplate, templateContext)
  }
  if (headBranch && conflictSuffixTemplate) {
    const conflictRuns = existingRuns ?? []
    if (hasBranchConflict(conflictRuns, runName, repository, headBranch)) {
      const conflictSuffix = renderTemplate(conflictSuffixTemplate, {
        ...templateContext,
        branch: headBranch,
        headBranch,
      })
      headBranch = appendBranchSuffix(headBranch, conflictSuffix)
    }
  }

  const auth = asRecord(providerSpec.auth) ?? {}
  const method = resolveVcsAuthMethod(auth)
  const username = asString(auth.username)
  const requiredSecrets: string[] = []
  const runtime: VcsRuntimeConfig = { env: [], volumes: [], volumeMounts: [] }

  const pushEnv = (name: string, value?: string | null) => {
    if (!value) return
    runtime.env.push({ name, value })
  }
  const pushEnvBool = (name: string, value: boolean) => {
    runtime.env.push({ name, value: value ? 'true' : 'false' })
  }
  const pushSecretEnv = (name: string, secretName: string, secretKey: string) => {
    runtime.env.push({
      name,
      valueFrom: { secretKeyRef: { name: secretName, key: secretKey } },
    })
  }

  let authAvailable = false
  let tokenValue: string | null = null

  const authValidation = validateVcsAuthConfig(providerType, auth)
  if (!authValidation.ok) {
    if (required) {
      return {
        ok: false,
        skip: false,
        reason: 'UnsupportedVcsAuth',
        message: authValidation.message,
        mode: effectiveMode,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: effectiveMode,
      reason: 'UnsupportedVcsAuth',
      message: authValidation.message,
      status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
      requiredSecrets: [],
    }
  }

  setMetadataIfMissing(metadata, 'vcsAuthMethod', authValidation.method)
  if (authValidation.tokenType) {
    setMetadataIfMissing(metadata, 'vcsTokenType', authValidation.tokenType)
  }

  const resolvedUsername =
    (method === 'token' || method === 'app') && !username ? authValidation.defaultUsername : username

  if (method === 'token') {
    const secretRef = asRecord(readNested(auth, ['token', 'secretRef'])) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'token'
    if (!secretName) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.token.secretRef.name is required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.token.secretRef.name is required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    pushSecretEnv('VCS_TOKEN', secretName, secretKey)
    if (providerType === 'github') {
      pushSecretEnv('GITHUB_TOKEN', secretName, secretKey)
      pushSecretEnv('GH_TOKEN', secretName, secretKey)
    }
    authAvailable = true
  }

  if (method === 'app') {
    const appSpec = asRecord(readNested(auth, ['app'])) ?? {}
    const appId = parseIntOrString(appSpec.appId)
    const installationId = parseIntOrString(appSpec.installationId)
    const secretRef = asRecord(appSpec.privateKeySecretRef) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'privateKey'
    const tokenTtlSeconds = Number(appSpec.tokenTtlSeconds)
    if (!appId || !installationId || !secretName) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const privateKey = resolveSecretValue(secret, secretKey)
    if (!privateKey) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    tokenValue = await fetchGithubAppToken({
      apiBaseUrl: apiBaseUrl ?? 'https://api.github.com',
      appId,
      installationId,
      privateKey,
      ttlSeconds: Number.isFinite(tokenTtlSeconds) ? tokenTtlSeconds : undefined,
    })
    pushEnv('VCS_TOKEN', tokenValue)
    pushEnv('GITHUB_TOKEN', tokenValue)
    pushEnv('GH_TOKEN', tokenValue)
    authAvailable = true
  }

  if (method === 'ssh') {
    const sshSpec = asRecord(readNested(auth, ['ssh'])) ?? {}
    const secretRef = asRecord(sshSpec.privateKeySecretRef) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'privateKey'
    const knownHostsRef = asRecord(sshSpec.knownHostsConfigMapRef) ?? {}
    const knownHostsName = asString(knownHostsRef.name)
    const knownHostsKey = asString(knownHostsRef.key) ?? 'known_hosts'
    if (!secretName) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.ssh.privateKeySecretRef.name is required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.ssh.privateKeySecretRef.name is required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required) {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    const sshDir = '/var/run/secrets/agents/vcs/ssh'
    const sshKeyPath = `${sshDir}/${secretKey}`
    runtime.volumes.push({
      name: makeName(runName, 'vcs-ssh'),
      spec: { secret: { secretName, items: [{ key: secretKey, path: secretKey }] } },
    })
    runtime.volumeMounts.push({ name: makeName(runName, 'vcs-ssh'), mountPath: sshDir, readOnly: true })
    pushEnv('VCS_SSH_KEY_PATH', sshKeyPath)

    if (knownHostsName) {
      const knownHostsDir = '/var/run/secrets/agents/vcs/known-hosts'
      const knownHostsPath = `${knownHostsDir}/${knownHostsKey}`
      runtime.volumes.push({
        name: makeName(runName, 'vcs-known-hosts'),
        spec: {
          configMap: {
            name: knownHostsName,
            items: [{ key: knownHostsKey, path: knownHostsKey }],
          },
        },
      })
      runtime.volumeMounts.push({
        name: makeName(runName, 'vcs-known-hosts'),
        mountPath: knownHostsDir,
        readOnly: true,
      })
      pushEnv('VCS_SSH_KNOWN_HOSTS_PATH', knownHostsPath)
    }
    authAvailable = true
  }

  let writeEnabled = effectiveMode === 'read-write' && canWrite
  if (writeEnabled && !authAvailable) {
    writeEnabled = false
  }

  if (desiredMode === 'read-write' && !writeEnabled) {
    if (required) {
      return {
        ok: false,
        skip: false,
        reason: 'VcsAuthUnavailable',
        message: 'vcs write access is unavailable',
        mode: effectiveMode,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets,
      }
    }
    effectiveMode = 'read-only'
  }

  if (effectiveMode === 'none') {
    return {
      ok: true,
      skip: true,
      mode: effectiveMode,
      reason: 'VcsDisabled',
      message: 'vcs mode resolved to none',
      status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
      requiredSecrets,
    }
  }

  const prEnabledDefault = readNested(pullRequestDefaults, ['enabled']) !== false
  const prDraft = readNested(pullRequestDefaults, ['draft']) === true
  const prTitleTemplate = asString(pullRequestDefaults.titleTemplate)
  const prBodyTemplate = asString(pullRequestDefaults.bodyTemplate)
  const pullRequestsEnabled = writeEnabled && canPr && prEnabledDefault

  pushEnv('VCS_PROVIDER', providerType)
  pushEnv('VCS_PROVIDER_NAME', vcsRefName)
  pushEnv('VCS_API_BASE_URL', apiBaseUrl)
  pushEnv('VCS_CLONE_BASE_URL', cloneBaseUrl)
  pushEnv('VCS_WEB_BASE_URL', webBaseUrl)
  pushEnv('VCS_REPOSITORY', repository)
  pushEnv('VCS_BASE_BRANCH', baseBranch)
  pushEnv('VCS_HEAD_BRANCH', headBranch)
  pushEnv('VCS_CLONE_PROTOCOL', cloneProtocol)
  pushEnv('VCS_SSH_HOST', sshHost)
  pushEnv('VCS_SSH_USER', sshUser)
  if (resolvedUsername) {
    pushEnv('VCS_USERNAME', resolvedUsername)
    pushEnv('GIT_ASKPASS_USERNAME', resolvedUsername)
  }
  pushEnv('VCS_BRANCH_TEMPLATE', branchTemplate)
  pushEnv('VCS_BRANCH_CONFLICT_SUFFIX_TEMPLATE', conflictSuffixTemplate)
  pushEnv('VCS_COMMIT_AUTHOR_NAME', asString(defaults.commitAuthorName))
  pushEnv('VCS_COMMIT_AUTHOR_EMAIL', asString(defaults.commitAuthorEmail))
  if (asString(defaults.commitAuthorName)) {
    pushEnv('GIT_AUTHOR_NAME', asString(defaults.commitAuthorName))
    pushEnv('GIT_COMMITTER_NAME', asString(defaults.commitAuthorName))
  }
  if (asString(defaults.commitAuthorEmail)) {
    pushEnv('GIT_AUTHOR_EMAIL', asString(defaults.commitAuthorEmail))
    pushEnv('GIT_COMMITTER_EMAIL', asString(defaults.commitAuthorEmail))
  }
  pushEnv('VCS_PR_TITLE_TEMPLATE', prTitleTemplate)
  pushEnv('VCS_PR_BODY_TEMPLATE', prBodyTemplate)
  const prRateLimits = resolveVcsPrRateLimits()
  if (prRateLimits) {
    pushEnv('VCS_PR_RATE_LIMITS', JSON.stringify(prRateLimits))
  }
  pushEnvBool('VCS_PR_DRAFT', prDraft)
  pushEnvBool('VCS_WRITE_ENABLED', writeEnabled)
  pushEnvBool('VCS_PULL_REQUESTS_ENABLED', pullRequestsEnabled)
  pushEnv('VCS_MODE', effectiveMode)

  const context = {
    provider: providerType,
    providerName: vcsRefName,
    repository,
    baseBranch,
    headBranch,
    mode: effectiveMode,
    writeEnabled,
    pullRequestsEnabled,
    apiBaseUrl,
    cloneBaseUrl,
    webBaseUrl,
    cloneProtocol,
    sshHost,
    sshUser,
    defaults: {
      baseBranch: asString(defaults.baseBranch),
      branchTemplate,
      branchConflictSuffixTemplate: conflictSuffixTemplate,
      commitAuthorName: asString(defaults.commitAuthorName),
      commitAuthorEmail: asString(defaults.commitAuthorEmail),
      pullRequest: {
        enabled: prEnabledDefault,
        draft: prDraft,
        titleTemplate: prTitleTemplate,
        bodyTemplate: prBodyTemplate,
      },
    },
  }

  const status = {
    provider: vcsRefName,
    repository,
    baseBranch,
    headBranch,
    mode: effectiveMode,
  }

  return {
    ok: true,
    skip: false,
    mode: effectiveMode,
    status,
    context,
    runtime,
    warnings: authValidation.warnings,
    requiredSecrets,
  }
}
