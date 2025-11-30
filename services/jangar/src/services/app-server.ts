import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CodexAppServerClient, type StreamDelta } from '@proompteng/codex'

export type SandboxType = 'dangerFullAccess' | 'workspaceWrite' | 'readOnly'
export type ApprovalType = 'unlessTrusted' | 'onFailure' | 'onRequest' | 'never'

export interface AppServerHandle {
  ready: Promise<void>
  runTurn: (options: {
    prompt: string
    model?: string
    cwd?: string | null
    threadId?: string
  }) => Promise<{ text: string; threadId: string }>
  runTurnStream: (options: {
    prompt: string
    model?: string
    cwd?: string | null
    threadId?: string
  }) => Promise<{ stream: AsyncGenerator<StreamDelta, unknown, void>; threadId: string; turnId: string }>
  stop: () => void
}

const DEFAULT_MODEL = 'gpt-5.1-codex-max'
const DEFAULT_SANDBOX: SandboxType = 'dangerFullAccess'
const DEFAULT_APPROVAL: ApprovalType = 'never'
const DEFAULT_REPO_SLUG = process.env.CODEX_REPO_SLUG ?? 'proompteng/lab'
const DEFAULT_REPO_URL = process.env.CODEX_REPO_URL ?? `https://github.com/${DEFAULT_REPO_SLUG}.git`
const DEFAULT_CWD = process.env.CODEX_CWD ?? join('/app', 'github.com', 'lab')
const SHOULD_BOOTSTRAP_REPO = process.env.CODEX_BOOTSTRAP_REPO !== '0'
const IS_DEV = process.env.NODE_ENV !== 'production'
const DEV_LOG_PATH = process.env.APP_SERVER_DEV_LOG_PATH ?? join(process.cwd(), '.logs', 'app-server-dev.log')

const hasCommand = (cmd: string) => {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const ensureRepoCheckout = (workingDirectory?: string) => {
  if (!workingDirectory || !SHOULD_BOOTSTRAP_REPO) return

  const gitDir = join(workingDirectory, '.git')
  if (existsSync(gitDir)) return

  if (existsSync(workingDirectory)) {
    const contents = readdirSync(workingDirectory).filter((entry) => entry !== '.' && entry !== '..')
    if (contents.length > 0) return
  }

  mkdirSync(dirname(workingDirectory), { recursive: true })

  const repoSlug = DEFAULT_REPO_SLUG
  const repoUrl = DEFAULT_REPO_URL

  if (hasCommand('gh')) {
    try {
      execSync(`gh repo clone ${repoSlug} ${workingDirectory}`, { stdio: 'inherit' })
      return
    } catch (error) {
      console.warn(
        JSON.stringify({ service: 'jangar', component: 'codex', event: 'gh_clone_fallback', error: `${error}` }),
      )
    }
  }

  execSync(`git clone ${repoUrl} ${workingDirectory}`, { stdio: 'inherit' })
}

const startAppServerInternal = (
  binaryPath = 'codex',
  workingDirectory?: string,
  {
    sandbox = DEFAULT_SANDBOX,
    approval = DEFAULT_APPROVAL,
    model = DEFAULT_MODEL,
  }: { sandbox?: SandboxType; approval?: ApprovalType; model?: string } = {},
): AppServerHandle => {
  ensureRepoCheckout(workingDirectory ?? DEFAULT_CWD)

  const logToFile = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => {
    if (!IS_DEV) return
    try {
      mkdirSync(dirname(DEV_LOG_PATH), { recursive: true })
      const line = `${new Date().toISOString()} [${level}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`
      appendFileSync(DEV_LOG_PATH, line)
    } catch (error) {
      // Swallow file logging errors to avoid breaking dev flow.
      console.warn(
        JSON.stringify({ service: 'jangar', component: 'codex', event: 'dev_log_write_failed', error: `${error}` }),
      )
    }
  }

  const client = new CodexAppServerClient({
    binaryPath,
    ...(workingDirectory ? { cwd: workingDirectory } : { cwd: DEFAULT_CWD }),
    sandbox,
    approval,
    defaultModel: model,
    clientInfo: { name: 'jangar', title: 'Jangar UI', version: '0.0.0' },
    logger: (level, message, meta) => {
      const entry = {
        service: 'jangar',
        component: 'codex',
        level,
        message,
        ...(meta ?? {}),
      }
      const line = JSON.stringify(entry)
      if (level === 'info') console.info(line)
      else if (level === 'warn') console.warn(line)
      else console.error(line)
      logToFile(level, message, meta as Record<string, unknown> | undefined)
    },
  })

  return {
    ready: client.ensureReady(),
    runTurn: async ({ prompt, model: modelOverride, cwd, threadId }) => {
      const runOptions: { model?: string; cwd?: string | null; threadId?: string } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      if (threadId !== undefined) runOptions.threadId = threadId
      const { text, threadId: activeThreadId } = await client.runTurn(prompt, runOptions)
      return { text, threadId: activeThreadId }
    },
    runTurnStream: async ({ prompt, model: modelOverride, cwd, threadId }) => {
      const runOptions: { model?: string; cwd?: string | null; threadId?: string } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      if (threadId !== undefined) runOptions.threadId = threadId
      const { stream, threadId: activeThreadId, turnId } = await client.runTurnStream(prompt, runOptions)
      return { stream, threadId: activeThreadId, turnId }
    },
    stop: () => client.stop(),
  }
}

export const stopAppServer = async (handle: AppServerHandle): Promise<void> => {
  handle.stop()
}

let cached: AppServerHandle | null = null
export const getAppServer = (
  binaryPath = 'codex',
  workingDirectory?: string,
  options?: { sandbox?: SandboxType; approval?: ApprovalType; model?: string },
): AppServerHandle => {
  if (!cached) {
    cached = startAppServerInternal(binaryPath, workingDirectory ?? DEFAULT_CWD, options)
  }
  return cached
}
