import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CodexAppServerClient } from '@proompteng/codex'

export type SandboxType = 'dangerFullAccess' | 'workspaceWrite' | 'readOnly'
export type ApprovalType = 'unlessTrusted' | 'onFailure' | 'onRequest' | 'never'

export interface AppServerHandle {
  ready: Promise<void>
  runTurn: (options: { prompt: string; model?: string; cwd?: string | null }) => Promise<{ text: string }>
  runTurnStream: (options: {
    prompt: string
    model?: string
    cwd?: string | null
  }) => Promise<{ stream: AsyncGenerator<string, unknown, void> }>
  stop: () => void
}

const DEFAULT_MODEL = 'gpt-5.1-codex-max'
const DEFAULT_SANDBOX: SandboxType = 'dangerFullAccess'
const DEFAULT_APPROVAL: ApprovalType = 'never'
const DEFAULT_REPO_SLUG = process.env.CODEX_REPO_SLUG ?? 'proompteng/lab'
const DEFAULT_REPO_URL = process.env.CODEX_REPO_URL ?? `https://github.com/${DEFAULT_REPO_SLUG}.git`
const DEFAULT_CWD = process.env.CODEX_CWD ?? join('/app', 'github.com', 'lab')
const SHOULD_BOOTSTRAP_REPO = process.env.CODEX_BOOTSTRAP_REPO !== '0'

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
      console.warn('[jangar][codex] gh repo clone failed, falling back to git clone', error)
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

  const client = new CodexAppServerClient({
    binaryPath,
    ...(workingDirectory ? { cwd: workingDirectory } : { cwd: DEFAULT_CWD }),
    sandbox,
    approval,
    defaultModel: model,
    clientInfo: { name: 'jangar', title: 'Jangar UI', version: '0.0.0' },
    logger: (level, message, meta) => {
      const payload = meta ? `${message} ${JSON.stringify(meta)}` : message
      if (level === 'info') console.info('[jangar][codex]', payload)
      else if (level === 'warn') console.warn('[jangar][codex]', payload)
      else console.error('[jangar][codex]', payload)
    },
  })

  return {
    ready: client.ensureReady(),
    runTurn: async ({ prompt, model: modelOverride, cwd }) => {
      const runOptions: { model?: string; cwd?: string | null } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      const { text } = await client.runTurn(prompt, runOptions)
      return { text }
    },
    runTurnStream: async ({ prompt, model: modelOverride, cwd }) => {
      const runOptions: { model?: string; cwd?: string | null } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      const { stream } = await client.runTurnStream(prompt, runOptions)
      return { stream }
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
