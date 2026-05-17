#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { runCodexAppServerAdapter } from '../../src/runner/codex-app-server'
import {
  buildTemplateContext,
  type AgentProviderInputFile,
  type AgentProviderOutputArtifact,
  type AgentProviderSpec,
  type AgentRunnerSpec,
  normalizeRunnerSpec,
  renderInputFiles,
  renderOutputArtifacts,
  renderTemplateArray,
  renderTemplateRecord,
  resolveAdapter,
} from '../../src/runner/spec'

import { runCli } from './lib/cli'
import { ensureFileDirectory } from './lib/fs'

type ExecAgentRunnerStatus = {
  provider: string
  adapter: 'exec'
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

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const timestampUtc = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

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

const writeStatus = async (statusPath: string | undefined, status: ExecAgentRunnerStatus) => {
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
      // best-effort terminal forwarding
    }
    try {
      logStream.write(chunk)
    } catch {
      // best-effort persistent logging
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

const runExecAdapter = async (spec: AgentRunnerSpec, provider: AgentProviderSpec & { binary: string }) => {
  const startedAt = timestampUtc()
  let finishedAt = startedAt
  let exitCode = 1
  let signal: string | null | undefined = null
  let errorMessage: string | undefined

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
    await writeStatus(statusPath, {
      provider: spec.provider,
      adapter: 'exec',
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
    })
  }

  if (errorMessage) {
    throw new Error(errorMessage)
  }

  return exitCode
}

export const runAgentRunner = async (rawSpec: AgentRunnerSpec): Promise<number> => {
  const spec = normalizeRunnerSpec(rawSpec)
  const adapter = resolveAdapter(spec)
  if (adapter.type === 'codex-app-server') {
    return runCodexAppServerAdapter(spec, adapter.codex)
  }
  return runExecAdapter(spec, adapter.provider)
}

const main = async () => {
  const spec = await loadAgentRunnerSpec(process.argv.slice(2))
  return runAgentRunner(spec)
}

await runCli(import.meta, main)
