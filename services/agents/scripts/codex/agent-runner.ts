#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { finished } from 'node:stream/promises'

import { runAgyCliAdapter } from '../../src/runner/agy-cli'
import { uploadOutputArtifacts } from '../../src/runner/artifact-upload'
import { describeRunnerError, runCodexAppServerAdapter } from '../../src/runner/codex-app-server'
import { readRunnerInputFile } from '../../src/runner/preflight'
import { detachRunnerProcess, waitForRunnerProcess } from '../../src/runner/process-command'
import { installPstackSkills } from '../../src/runner/pstack'
import { stringifyRunnerOutput } from '../../src/runner/redact'
import { runnerSignalExitCode, withRunnerSignalHandlers } from '../../src/runner/shutdown'
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
  status: 'succeeded' | 'failed' | 'cancelled'
  artifacts: {
    statusPath?: string
    logPath?: string
    outputArtifacts: AgentProviderOutputArtifact[]
  }
  error?: string
}

const timestampUtc = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const parseRunnerSpec = (json: string, source: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    throw new Error(`Failed to parse agent-runner spec from ${source}: expected valid JSON`)
  }
}

const loadAgentRunnerSpec = async (argv: string[], signal: AbortSignal): Promise<AgentRunnerSpec> => {
  const path = argv[0] || process.env.AGENT_RUNNER_SPEC_PATH
  if (path) {
    const json = await readRunnerInputFile(path, signal).catch((cause: unknown) => {
      throw new Error(`Unable to read agent-runner spec at ${path}: ${describeRunnerError(cause)}`)
    })
    return normalizeRunnerSpec(parseRunnerSpec(json, path))
  }
  const json = process.env.AGENT_RUNNER_SPEC
  if (json) return normalizeRunnerSpec(parseRunnerSpec(json, 'AGENT_RUNNER_SPEC'))
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
  await writeFile(statusPath, `${stringifyRunnerOutput(status, 2)}\n`, 'utf8')
}

const spawnWithLogs = async (
  command: string,
  args: string[],
  env: Record<string, string>,
  logPath: string | undefined,
  signal: AbortSignal,
): Promise<{ exitCode: number; signal?: string | null }> => {
  signal.throwIfAborted()
  if (!logPath) {
    const child = spawn(command, args, { stdio: 'inherit', env, detached: detachRunnerProcess })
    return waitForRunnerProcess(child, { signal })
  }

  await ensureFileDirectory(logPath)
  signal.throwIfAborted()
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const logClosed = finished(logStream, { cleanup: true }).catch((error: unknown) => error)
  let result: Awaited<ReturnType<typeof waitForRunnerProcess>>
  let logError: unknown
  try {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env, detached: detachRunnerProcess })
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      logStream.write(chunk)
    })
    result = await waitForRunnerProcess(child, { signal })
  } finally {
    logStream.end()
    logError = await logClosed
  }
  if (logError) throw logError
  return result
}

const runExecAdapter = async (
  spec: AgentRunnerSpec,
  provider: AgentProviderSpec & { binary: string },
  abortSignal: AbortSignal,
) => {
  const startedAt = timestampUtc()
  let finishedAt = startedAt
  let exitCode = 1
  let signal: string | null | undefined = null
  let errorMessage: string | undefined

  const context = buildTemplateContext(spec)
  const renderedArgs = renderTemplateArray(provider.argsTemplate, context)
  const renderedEnv = renderTemplateRecord(provider.envTemplate, context)
  const inputFiles = renderInputFiles(provider.inputFiles, context)
  let outputArtifacts = renderOutputArtifacts(provider.outputArtifacts, context)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath

  try {
    await writeInputFiles(inputFiles)
    const env = {
      ...process.env,
      ...renderedEnv,
    } as Record<string, string>
    await configureGitAskpass(env)

    const result = await spawnWithLogs(provider.binary, renderedArgs, env, logPath, abortSignal)
    exitCode = result.exitCode
    signal = result.signal
    if (exitCode === 0) {
      outputArtifacts = await uploadOutputArtifacts(outputArtifacts, { env, signal: abortSignal })
    }
  } catch (error) {
    errorMessage = describeRunnerError(error)
    exitCode = 1
  } finally {
    if (abortSignal.aborted) {
      signal = String(abortSignal.reason)
      exitCode = runnerSignalExitCode(signal)
    }
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
      status: abortSignal.aborted ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
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

const runAgentRunner = async (spec: AgentRunnerSpec, signal: AbortSignal): Promise<number> => {
  const adapter = resolveAdapter(spec)
  if (adapter.type === 'agy-cli') {
    return runAgyCliAdapter(spec, adapter.agy, { abortSignal: signal })
  }
  if (adapter.type === 'codex-app-server') {
    installPstackSkills({
      codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
      enabled: process.env.AGENTS_RUNNER_PSTACK_ENABLED,
    })
    return runCodexAppServerAdapter(spec, adapter.codex, { abortSignal: signal })
  }
  return runExecAdapter(spec, adapter.provider, signal)
}

if (import.meta.main) {
  const exitCode = await withRunnerSignalHandlers(async (signal) => {
    let code = 1
    try {
      const spec = await loadAgentRunnerSpec(process.argv.slice(2), signal)
      code = await runAgentRunner(spec, signal)
    } catch (error) {
      process.stderr.write(`${describeRunnerError(error)}\n`)
    }
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    )
    return code
  })
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(exitCode)
}
