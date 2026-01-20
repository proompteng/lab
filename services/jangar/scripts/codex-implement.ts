#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

type EventPayload = Record<string, unknown>

const DEFAULT_WORKDIR = '/workspace/repo'
const DEFAULT_TOKEN_PATHS = [
  process.env.GITHUB_TOKEN_PATH,
  process.env.GH_TOKEN_PATH,
  '/var/run/secrets/github/token',
  '/var/run/secrets/agents/github/token',
].filter(Boolean) as string[]

const readToken = () => {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim()
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim()
  for (const path of DEFAULT_TOKEN_PATHS) {
    if (!path) continue
    if (!existsSync(path)) continue
    const raw = readFileSync(path, 'utf8').trim()
    if (raw) return raw
  }
  return ''
}

const runSync = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`)
  }
}

const runCapture = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} ${args.join(' ')} failed: ${err || `exit ${result.status ?? 'unknown'}`}`)
  }
  return (result.stdout ?? '').trim()
}

const sanitizeBranch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 62) || 'codex/agent-run'

const getString = (payload: EventPayload, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const main = async () => {
  const eventPath = process.argv[2]
  if (!eventPath) {
    throw new Error('Usage: codex-implement <event.json>')
  }

  const raw = readFileSync(eventPath, 'utf8')
  const payload = JSON.parse(raw) as EventPayload

  const prompt = getString(payload, ['prompt', 'text', 'summary'])
  if (!prompt) throw new Error('Event payload is missing prompt or text')

  const repository = getString(payload, ['repository', 'repo', 'issueRepository'])
  if (!repository) throw new Error('Event payload is missing repository')

  const issueNumber = getString(payload, ['issueNumber', 'issue_number', 'issue', 'issueId'])
  const issueTitle = getString(payload, ['issueTitle', 'title'])
  const issueUrl = getString(payload, ['issueUrl', 'url'])

  const workdir = process.env.CODEX_WORKDIR?.trim() || DEFAULT_WORKDIR
  mkdirSync(workdir, { recursive: true })

  const token = readToken()
  if (token) {
    process.env.GH_TOKEN = token
    process.env.GITHUB_TOKEN = token
  }

  const env = { ...process.env }

  let defaultBranch = 'main'
  try {
    defaultBranch = runCapture(
      'gh',
      ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      {
        env,
      },
    )
  } catch {
    // fall back to main if gh isn't authenticated
  }

  const gitDir = join(workdir, '.git')
  if (!existsSync(gitDir)) {
    let cloned = false
    try {
      runSync('gh', ['repo', 'clone', repository, workdir], { env })
      cloned = true
    } catch {
      // fall back to anonymous clone if gh is not configured
    }
    if (!cloned) {
      runSync('git', ['clone', `https://github.com/${repository}.git`, workdir], { env })
    }
  }

  try {
    runSync('gh', ['auth', 'setup-git'], { env })
  } catch {
    // ignore if gh isn't authenticated
  }

  runSync('git', ['-C', workdir, 'fetch', 'origin', defaultBranch], { env })
  runSync('git', ['-C', workdir, 'checkout', defaultBranch], { env })
  runSync('git', ['-C', workdir, 'pull', '--ff-only', 'origin', defaultBranch], { env })

  const branchName = sanitizeBranch(`codex/agents/${issueNumber || Date.now()}`)
  runSync('git', ['-C', workdir, 'checkout', '-B', branchName], { env })

  const codexArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--cd',
    workdir,
  ]

  const codexResult = spawnSync('codex', codexArgs, {
    env,
    input: `${prompt}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (codexResult.status !== 0) {
    throw new Error(`codex exec failed with exit ${codexResult.status ?? 'unknown'}`)
  }

  const changed = runCapture('git', ['-C', workdir, 'status', '--porcelain'], { env })
  if (!changed) {
    throw new Error('codex produced no changes; aborting')
  }

  runSync('git', ['-C', workdir, 'add', '-A'], { env })
  const commitTitle = issueTitle || `codex: update ${repository}`
  const commitMessage = issueNumber ? `${commitTitle} (#${issueNumber})` : commitTitle
  runSync('git', ['-C', workdir, 'commit', '-m', commitMessage], { env })

  runSync('git', ['-C', workdir, 'push', '--set-upstream', 'origin', branchName], { env })

  const prTitle = issueTitle || `Codex: ${repository}`
  const prBodyLines = [issueNumber ? `Closes #${issueNumber}` : '', issueUrl ? `Source: ${issueUrl}` : ''].filter(
    Boolean,
  )
  const prBody = prBodyLines.length > 0 ? prBodyLines.join('\n') : 'Generated by codex-implement.'

  const prArgs = ['pr', 'create', '--repo', repository, '--title', prTitle, '--body', prBody, '--head', branchName]
  runSync('gh', prArgs, { env })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
