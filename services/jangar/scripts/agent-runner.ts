#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

type AgentSpec = {
  provider?: string
  inputs?: Record<string, unknown>
  payloads?: Record<string, unknown>
  env?: Record<string, unknown>
  observability?: Record<string, unknown>
  artifacts?: {
    statusPath?: string
    logPath?: string
  }
  providerSpec?: ProviderSpec
}

type ProviderSpec = {
  name?: string
  binary: string
  argsTemplate?: string[]
  envTemplate?: Record<string, string>
  inputFiles?: Array<{ path: string; content: string }>
  outputArtifacts?: Array<{ name: string; path: string }>
}

type RunSpec = {
  agentRun?: Record<string, unknown>
  implementation?: Record<string, unknown>
  parameters?: Record<string, unknown>
  memory?: Record<string, unknown>
  artifacts?: Array<{ name?: string; path?: string; key?: string; url?: string }>
}

const AGENT_STATUS_DEFAULT = '/workspace/.agent/status.json'
const AGENT_LOG_DEFAULT = '/workspace/.agent/runner.log'

const fileExists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const ensureDir = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
}

const resolveVcsProvider = (env: Record<string, string | undefined>) =>
  env.VCS_PROVIDER ? env.VCS_PROVIDER.trim().toLowerCase() : ''

const resolveVcsToken = (env: Record<string, string | undefined>) =>
  (env.VCS_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || '').trim()

const resolveVcsUsername = (env: Record<string, string | undefined>) => {
  if (env.VCS_USERNAME?.trim()) return env.VCS_USERNAME.trim()
  const provider = resolveVcsProvider(env)
  if (provider === 'gitlab') return 'oauth2'
  if (provider === 'bitbucket') return 'x-token-auth'
  if (provider === 'github') return 'x-access-token'
  return 'git'
}

const configureGitAskpass = async (env: Record<string, string | undefined>) => {
  const token = resolveVcsToken(env)
  if (!token) return

  if (!env.VCS_TOKEN) env.VCS_TOKEN = token
  if (resolveVcsProvider(env) === 'github') {
    if (!env.GITHUB_TOKEN) env.GITHUB_TOKEN = token
    if (!env.GH_TOKEN) env.GH_TOKEN = token
  }

  if (!env.GIT_ASKPASS) {
    const askpassPath = '/tmp/git-askpass.sh'
    const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GIT_ASKPASS_USERNAME" ;;
  *Password*) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
  *) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
esac
`
    await writeFile(askpassPath, script, { mode: 0o700 })
    await chmod(askpassPath, 0o700)
    env.GIT_ASKPASS = askpassPath
  }

  env.GIT_ASKPASS_TOKEN = token
  if (!env.GIT_ASKPASS_USERNAME) env.GIT_ASKPASS_USERNAME = resolveVcsUsername(env)
  if (!env.GIT_TERMINAL_PROMPT) {
    env.GIT_TERMINAL_PROMPT = '0'
  }
}

const decodeMaybeBase64 = (raw: string) => {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return raw
  }
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return decoded || raw
  } catch {
    return raw
  }
}

const getValue = (value: unknown, path: string) => {
  const parts = path.split('.').filter((part) => part.length > 0)
  let current: unknown = value
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    if (!(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const renderTemplate = (template: string, context: Record<string, unknown>) =>
  template.replace(/{{\s*([^}]+)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey).trim()
    const value = getValue(context, key)
    if (value === null || value === undefined) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

const parseArgs = () => {
  const args = process.argv.slice(2)
  const result: { specPath?: string; specEnv?: string } = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--spec' && args[i + 1]) {
      result.specPath = args[i + 1]
      i += 1
      continue
    }
    if (arg === '--spec-env' && args[i + 1]) {
      result.specEnv = args[i + 1]
      i += 1
    }
  }
  return result
}

const isRunSpec = (value: unknown): value is RunSpec => {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Boolean(record.agentRun || record.implementation || record.parameters)
}

const buildSpecFromRunSpec = (runSpec: RunSpec): AgentSpec => {
  const provider = process.env.AGENT_PROVIDER?.trim() || process.env.AGENT_PROVIDER_NAME?.trim()
  if (!provider) {
    throw new Error('Missing AGENT_PROVIDER for agent-run spec execution')
  }

  const implementation = (runSpec.implementation ?? {}) as Record<string, unknown>
  const text = typeof implementation.text === 'string' ? implementation.text : ''
  const summary = typeof implementation.summary === 'string' ? implementation.summary : ''
  const acceptanceCriteria = Array.isArray(implementation.acceptanceCriteria) ? implementation.acceptanceCriteria : []

  const payloadJson = JSON.stringify(runSpec, null, 2)
  const metadataJson = JSON.stringify(
    {
      summary,
      acceptanceCriteria,
      source: implementation.source ?? null,
      labels: implementation.labels ?? [],
    },
    null,
    2,
  )

  const providerSpec = (() => {
    const raw = process.env.AGENT_PROVIDER_SPEC
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as ProviderSpec
    } catch (error) {
      throw new Error(`Invalid AGENT_PROVIDER_SPEC JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  return {
    provider,
    inputs: typeof runSpec.parameters === 'object' && runSpec.parameters ? runSpec.parameters : {},
    payloads: {
      eventBodyB64: Buffer.from(payloadJson, 'utf8').toString('base64'),
      promptB64: Buffer.from(text || summary, 'utf8').toString('base64'),
      metadataB64: Buffer.from(metadataJson, 'utf8').toString('base64'),
    },
    providerSpec,
  }
}

const loadSpec = async () => {
  const { specPath, specEnv } = parseArgs()
  const resolvedPath = specPath || process.env.AGENT_RUN_SPEC || process.env.AGENT_SPEC_PATH || undefined
  if (resolvedPath) {
    const raw = await readFile(resolvedPath, 'utf8')
    const parsed = JSON.parse(raw) as AgentSpec | RunSpec
    if (isRunSpec(parsed)) {
      return buildSpecFromRunSpec(parsed)
    }
    return parsed as AgentSpec
  }
  const envKey = specEnv || process.env.AGENT_SPEC_ENV || 'AGENT_SPEC'
  const raw = process.env[envKey]
  if (!raw) {
    throw new Error('Missing agent spec. Provide --spec <path> or set AGENT_SPEC.')
  }
  const parsed = JSON.parse(raw) as AgentSpec | RunSpec
  if (isRunSpec(parsed)) {
    return buildSpecFromRunSpec(parsed)
  }
  return parsed as AgentSpec
}

const loadProviderSpec = async (provider: string, override?: ProviderSpec) => {
  if (override) {
    return override
  }
  const providerPath = process.env.AGENT_PROVIDER_PATH?.trim()
  const providerDir = (process.env.AGENT_PROVIDER_DIR ?? '/etc/agent-providers').trim()
  const resolvedPath = providerPath || join(providerDir, `${provider}.json`)
  if (await fileExists(resolvedPath)) {
    const raw = await readFile(resolvedPath, 'utf8')
    return JSON.parse(raw) as ProviderSpec
  }
  if (provider === 'codex') {
    return {
      name: 'codex',
      binary: '/usr/local/bin/codex-implement',
      argsTemplate: ['{{payloads.eventBodyPath}}'],
      envTemplate: {
        WORKFLOW_STAGE: '{{inputs.stage}}',
        CODEX_STAGE: '{{inputs.stage}}',
      },
    }
  }
  if (provider === 'codex-research') {
    return {
      name: 'codex-research',
      binary: '/usr/local/bin/codex-research',
      argsTemplate: ['{{payloads.promptPath}}', '{{payloads.metadataPath}}'],
      envTemplate: {
        WORKFLOW_STAGE: '{{inputs.stage}}',
      },
    }
  }
  throw new Error(`Agent provider "${provider}" not found at ${resolvedPath}`)
}

const ensurePayloadFile = async ({
  payloads,
  pathKey,
  rawKey,
  defaultName,
}: {
  payloads: Record<string, unknown>
  pathKey: string
  rawKey: string
  defaultName: string
}) => {
  if (typeof payloads[pathKey] === 'string' && payloads[pathKey]) {
    const existing = payloads[pathKey] as string
    if (!(await fileExists(existing))) {
      throw new Error(`Payload file missing at ${existing}`)
    }
    return
  }
  const rawValue = payloads[rawKey]
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return
  }
  const resolved = decodeMaybeBase64(rawValue)
  const dir = process.env.AGENT_TMP_DIR?.trim() || '/tmp'
  const path = join(dir, defaultName)
  await ensureDir(path)
  await writeFile(path, resolved)
  payloads[pathKey] = path
}

const buildEnvironment = (base: Record<string, string | undefined>, updates: Record<string, string>) => {
  const env = { ...base }
  for (const [key, value] of Object.entries(updates)) {
    env[key] = value
  }
  return env
}

const runCommand = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    const pathname = url.pathname.replace(/\/?$/, '/')
    return {
      origin: `${url.protocol}//${url.host}${pathname}`,
      protocol: url.protocol,
      host: url.host,
      pathname,
    }
  } catch {
    return null
  }
}

const configureGitAuth = async (env: Record<string, string | undefined>) => {
  const token = resolveVcsToken(env)
  if (!token) return
  const cloneProtocol = env.VCS_CLONE_PROTOCOL?.trim().toLowerCase()
  if (cloneProtocol === 'ssh' || env.VCS_SSH_KEY_PATH) return

  const rawBase = env.VCS_CLONE_BASE_URL || env.VCS_WEB_BASE_URL || ''
  let base = normalizeBaseUrl(rawBase)
  if (!base) {
    const provider = resolveVcsProvider(env)
    if (provider === 'github' || env.GH_TOKEN || env.GITHUB_TOKEN) {
      base = normalizeBaseUrl('https://github.com')
    }
  }
  if (!base) return

  const username = resolveVcsUsername(env)
  const authUrl = `${base.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(token)}@${base.host}${base.pathname}`
  const patterns = [base.origin]
  const sshUser = env.VCS_SSH_USER?.trim() || 'git'
  patterns.push(`ssh://${sshUser}@${base.host}/`)
  patterns.push(`${sshUser}@${base.host}:`)
  if (sshUser !== 'git') {
    patterns.push(`ssh://git@${base.host}/`)
    patterns.push(`git@${base.host}:`)
  }

  try {
    for (const pattern of patterns) {
      await runCommand('git', ['config', '--global', `url.${authUrl}.insteadOf`, pattern])
    }
  } catch (error) {
    console.warn('[agent-runner] failed to configure git auth', error)
  }
}

const configureGitSsh = (env: Record<string, string | undefined>) => {
  if (!env.VCS_SSH_KEY_PATH || env.GIT_SSH_COMMAND) return
  const keyPath = env.VCS_SSH_KEY_PATH
  const args = ['ssh', '-i', keyPath, '-o', 'IdentitiesOnly=yes']
  if (env.VCS_SSH_KNOWN_HOSTS_PATH) {
    args.push('-o', `UserKnownHostsFile=${env.VCS_SSH_KNOWN_HOSTS_PATH}`, '-o', 'StrictHostKeyChecking=yes')
  } else {
    args.push('-o', 'StrictHostKeyChecking=accept-new')
  }
  env.GIT_SSH_COMMAND = args.join(' ')
}

const run = async () => {
  const spec = await loadSpec()
  const providerName = spec.provider?.trim()
  if (!providerName) {
    throw new Error('Agent spec missing provider name')
  }

  const providerSpec = await loadProviderSpec(providerName, spec.providerSpec)

  const inputs = spec.inputs ?? {}
  const payloads = { ...spec.payloads }
  const observability = spec.observability ?? {}
  const artifacts = spec.artifacts ?? {}
  const envOverrides = spec.env ?? {}

  await ensurePayloadFile({
    payloads,
    pathKey: 'eventBodyPath',
    rawKey: 'eventBodyB64',
    defaultName: `agent-event-${Date.now()}.json`,
  })
  await ensurePayloadFile({
    payloads,
    pathKey: 'promptPath',
    rawKey: 'promptB64',
    defaultName: `agent-prompt-${Date.now()}.txt`,
  })
  await ensurePayloadFile({
    payloads,
    pathKey: 'metadataPath',
    rawKey: 'metadataB64',
    defaultName: `agent-metadata-${Date.now()}.json`,
  })

  const context = {
    inputs,
    payloads,
    observability,
    artifacts,
    env: envOverrides,
  }

  if (providerSpec.inputFiles) {
    for (const entry of providerSpec.inputFiles) {
      const resolvedPath = renderTemplate(entry.path, context)
      const resolvedContent = renderTemplate(entry.content, context)
      await ensureDir(resolvedPath)
      await writeFile(resolvedPath, resolvedContent)
    }
  }

  const renderedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(envOverrides)) {
    renderedEnv[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (providerSpec.envTemplate) {
    for (const [key, value] of Object.entries(providerSpec.envTemplate)) {
      renderedEnv[key] = renderTemplate(value, context)
    }
  }
  if (typeof observability.natsUrl === 'string' && !renderedEnv.NATS_URL) {
    renderedEnv.NATS_URL = observability.natsUrl
  }
  if (typeof observability.grafBaseUrl === 'string' && !renderedEnv.CODEX_GRAF_BASE_URL) {
    renderedEnv.CODEX_GRAF_BASE_URL = observability.grafBaseUrl
  }

  const args = (providerSpec.argsTemplate ?? []).map((arg) => renderTemplate(arg, context)).filter((arg) => arg !== '')
  const command = providerSpec.binary

  const statusPath = artifacts.statusPath ?? AGENT_STATUS_DEFAULT
  const logPath = artifacts.logPath ?? AGENT_LOG_DEFAULT
  await ensureDir(statusPath)
  await ensureDir(logPath)

  const startTime = new Date()
  const logStream = createWriteStream(logPath, { flags: 'a' })

  const env = buildEnvironment(process.env, renderedEnv)
  configureGitSsh(env)
  await configureGitAskpass(env)
  await configureGitAuth(env)

  const child = spawn(command, args, {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk)
    logStream.write(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk)
    logStream.write(chunk)
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (error) => reject(error))
    child.on('close', (code) => resolve(code ?? 1))
  }).catch(async (error) => {
    const failure = error instanceof Error ? error.message : String(error)
    await writeFile(
      statusPath,
      JSON.stringify(
        {
          provider: providerName,
          status: 'failed',
          error: failure,
          startedAt: startTime.toISOString(),
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    throw error
  })

  logStream.end()

  const finishedAt = new Date()
  const outputArtifacts =
    providerSpec.outputArtifacts?.map((artifact) => {
      const resolvedPath = renderTemplate(artifact.path, context)
      return { name: artifact.name, path: resolvedPath }
    }) ?? []

  await writeFile(
    statusPath,
    JSON.stringify(
      {
        provider: providerName,
        status: exitCode === 0 ? 'succeeded' : 'failed',
        exitCode,
        command: [command, ...args],
        cwd: process.cwd(),
        startedAt: startTime.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startTime.getTime(),
        artifacts: outputArtifacts,
      },
      null,
      2,
    ),
  )

  process.exit(exitCode)
}

run().catch((error) => {
  console.error('agent-runner failed', error)
  process.exit(1)
})
