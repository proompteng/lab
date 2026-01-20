#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { runCli } from './lib/cli'
import { ensureFileDirectory } from './lib/fs'

export type AgentRunnerArtifacts = {
  statusPath?: string
  logPath?: string
}

export type AgentRunnerSpec = {
  provider: string
  inputs?: Record<string, unknown>
  payloads?: Record<string, unknown>
  observability?: Record<string, unknown>
  artifacts?: AgentRunnerArtifacts
  providerSpec?: AgentProviderSpec
}

export type AgentProviderInputFile = {
  path: string
  content: string
}

export type AgentProviderOutputArtifact = {
  name: string
  path: string
}

export type AgentProviderSpec = {
  binary: string
  argsTemplate?: string[]
  envTemplate?: Record<string, string>
  inputFiles?: AgentProviderInputFile[]
  outputArtifacts?: AgentProviderOutputArtifact[]
}

export type TemplateContext = {
  inputs: Record<string, unknown>
  payloads: Record<string, unknown>
  observability: Record<string, unknown>
  artifacts: Record<string, unknown>
}

const DEFAULT_PROVIDER_SPECS: Record<string, AgentProviderSpec> = {
  codex: {
    binary: '/usr/local/bin/codex-implement',
    argsTemplate: ['{{payloads.eventFilePath}}'],
    envTemplate: {
      WORKFLOW_STAGE: '{{inputs.stage}}',
    },
  },
}

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ensureRecord = (value: Record<string, unknown> | undefined) => value ?? {}

const timestampUtc = (): string => {
  const iso = new Date().toISOString()
  return iso.replace(/\.\d+Z$/, 'Z')
}

export const buildTemplateContext = (spec: AgentRunnerSpec): TemplateContext => ({
  inputs: ensureRecord(spec.inputs),
  payloads: ensureRecord(spec.payloads),
  observability: ensureRecord(spec.observability),
  artifacts: ensureRecord(spec.artifacts as Record<string, unknown> | undefined),
})

const resolveTemplateValue = (context: TemplateContext, path: string): string => {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  let current: unknown = context
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return ''
    }
    current = (current as Record<string, unknown>)[segment]
  }

  if (current === null || current === undefined) {
    return ''
  }
  if (typeof current === 'string') {
    return current
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current)
  }

  try {
    return JSON.stringify(current)
  } catch {
    return ''
  }
}

export const renderTemplate = (template: string, context: TemplateContext): string =>
  template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path) => resolveTemplateValue(context, path))

const renderTemplateArray = (templates: string[] | undefined, context: TemplateContext): string[] =>
  (templates ?? []).map((template) => renderTemplate(template, context))

const renderTemplateRecord = (
  templates: Record<string, string> | undefined,
  context: TemplateContext,
): Record<string, string> => {
  if (!templates) {
    return {}
  }
  const entries = Object.entries(templates).map(([key, template]) => [key, renderTemplate(template, context)])
  return Object.fromEntries(entries)
}

const renderInputFiles = (inputFiles: AgentProviderInputFile[] | undefined, context: TemplateContext) =>
  (inputFiles ?? []).map((file) => ({
    path: renderTemplate(file.path, context),
    content: renderTemplate(file.content, context),
  }))

const renderOutputArtifacts = (artifacts: AgentProviderOutputArtifact[] | undefined, context: TemplateContext) =>
  (artifacts ?? []).map((artifact) => ({
    name: artifact.name,
    path: renderTemplate(artifact.path, context),
  }))

const mergeProviderSpec = (base: AgentProviderSpec | undefined, override: AgentProviderSpec | undefined) => ({
  binary: override?.binary ?? base?.binary ?? '',
  argsTemplate: override?.argsTemplate ?? base?.argsTemplate,
  envTemplate: override?.envTemplate ?? base?.envTemplate,
  inputFiles: override?.inputFiles ?? base?.inputFiles,
  outputArtifacts: override?.outputArtifacts ?? base?.outputArtifacts,
})

export const resolveProviderSpec = (spec: AgentRunnerSpec): AgentProviderSpec => {
  const base = DEFAULT_PROVIDER_SPECS[spec.provider]
  const merged = mergeProviderSpec(base, spec.providerSpec)
  if (!merged.binary) {
    throw new Error(`Missing AgentProvider spec for provider "${spec.provider}"`)
  }
  return merged
}

const loadSpecFromPath = async (path: string): Promise<AgentRunnerSpec> => {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as AgentRunnerSpec
  } catch (error) {
    throw new Error(`Failed to parse agent-runner spec at ${path}: ${toErrorMessage(error)}`)
  }
}

const loadSpecFromEnv = async (): Promise<AgentRunnerSpec | null> => {
  const specJson = process.env.AGENT_RUNNER_SPEC
  if (!specJson) {
    return null
  }
  try {
    return JSON.parse(specJson) as AgentRunnerSpec
  } catch (error) {
    throw new Error(`Failed to parse AGENT_RUNNER_SPEC: ${toErrorMessage(error)}`)
  }
}

export const loadAgentRunnerSpec = async (argv: string[]): Promise<AgentRunnerSpec> => {
  const [specPath] = argv
  if (specPath) {
    return loadSpecFromPath(specPath)
  }

  const specFromPath = process.env.AGENT_RUNNER_SPEC_PATH
  if (specFromPath) {
    return loadSpecFromPath(specFromPath)
  }

  const specFromEnv = await loadSpecFromEnv()
  if (specFromEnv) {
    return specFromEnv
  }

  throw new Error('agent-runner requires a JSON spec via file argument, AGENT_RUNNER_SPEC_PATH, or AGENT_RUNNER_SPEC')
}

const writeInputFiles = async (files: AgentProviderInputFile[]) => {
  for (const file of files) {
    if (!file.path) {
      throw new Error('agent-runner inputFiles entry missing path')
    }
    await ensureFileDirectory(file.path)
    await writeFile(file.path, file.content ?? '', 'utf8')
  }
}

const configureGitAskpass = async (env: Record<string, string>) => {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (!token) {
    return
  }

  if (!env.GITHUB_TOKEN) env.GITHUB_TOKEN = token
  if (!env.GH_TOKEN) env.GH_TOKEN = token

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
  if (!env.GIT_ASKPASS_USERNAME) {
    env.GIT_ASKPASS_USERNAME = 'x-access-token'
  }
  if (!env.GIT_TERMINAL_PROMPT) {
    env.GIT_TERMINAL_PROMPT = '0'
  }
}

type AgentRunnerStatus = {
  provider: string
  binary: string
  args: string[]
  exitCode: number
  signal?: string | null
  startedAt: string
  finishedAt: string
  status: 'succeeded' | 'failed'
  artifacts: {
    statusPath?: string
    logPath?: string
    outputArtifacts: AgentProviderOutputArtifact[]
  }
  error?: string
}

const writeStatus = async (statusPath: string | undefined, status: AgentRunnerStatus) => {
  if (!statusPath) {
    return
  }
  await ensureFileDirectory(statusPath)
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

const spawnWithLogs = async (
  command: string,
  args: string[],
  env: Record<string, string>,
  logPath: string | undefined,
): Promise<{ exitCode: number; signal?: string | null }> => {
  if (!logPath) {
    const child = spawn(command, args, { stdio: 'inherit', env })
    return new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code, signal) => {
        resolve({ exitCode: code ?? 1, signal })
      })
    })
  }

  await ensureFileDirectory(logPath)
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env })

  const forward = (chunk: Buffer, target: NodeJS.WriteStream) => {
    try {
      target.write(chunk)
    } catch {
      // ignore best-effort write failures
    }
    try {
      logStream.write(chunk)
    } catch {
      // ignore log write failures
    }
  }

  child.stdout?.on('data', (chunk) => forward(chunk as Buffer, process.stdout))
  child.stderr?.on('data', (chunk) => forward(chunk as Buffer, process.stderr))

  return new Promise((resolve, reject) => {
    child.on('error', (error) => {
      logStream.end()
      reject(error)
    })
    child.on('exit', (code, signal) => {
      logStream.end()
      resolve({ exitCode: code ?? 1, signal })
    })
  })
}

export const runAgentRunner = async (spec: AgentRunnerSpec): Promise<number> => {
  const startedAt = timestampUtc()
  let finishedAt = startedAt
  let exitCode = 1
  let signal: string | null | undefined = null
  let errorMessage: string | undefined

  const provider = resolveProviderSpec(spec)
  const context = buildTemplateContext(spec)
  const renderedArgs = renderTemplateArray(provider.argsTemplate, context)
  const renderedEnv = renderTemplateRecord(provider.envTemplate, context)
  const inputFiles = renderInputFiles(provider.inputFiles, context)
  const outputArtifacts = renderOutputArtifacts(provider.outputArtifacts, context)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath

  try {
    await writeInputFiles(inputFiles)
    const env = {
      ...process.env,
      ...renderedEnv,
    } as Record<string, string>
    await configureGitAskpass(env)

    const result = await spawnWithLogs(provider.binary, renderedArgs, env, logPath)
    exitCode = result.exitCode
    signal = result.signal
  } catch (error) {
    errorMessage = toErrorMessage(error)
    exitCode = 1
  } finally {
    finishedAt = timestampUtc()
    const status: AgentRunnerStatus = {
      provider: spec.provider,
      binary: provider.binary,
      args: renderedArgs,
      exitCode,
      signal,
      startedAt,
      finishedAt,
      status: exitCode === 0 ? 'succeeded' : 'failed',
      artifacts: {
        statusPath,
        logPath,
        outputArtifacts,
      },
      ...(errorMessage ? { error: errorMessage } : {}),
    }
    await writeStatus(statusPath, status)
  }

  if (errorMessage) {
    throw new Error(errorMessage)
  }

  return exitCode
}

const main = async () => {
  const spec = await loadAgentRunnerSpec(process.argv.slice(2))
  return runAgentRunner(spec)
}

await runCli(import.meta, main)
