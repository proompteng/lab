#!/usr/bin/env bun
import { existsSync } from 'node:fs'

const ensureCommand = (name: string) => {
  if (!Bun.which(name)) {
    throw new Error(`missing required command: ${name}`)
  }
}

const resolveRepoSlug = () => {
  const slug = process.env.CODEX_REPO_SLUG
  if (slug && slug.trim().length > 0) {
    return slug.trim()
  }

  const url = process.env.CODEX_REPO_URL?.trim()
  if (!url) return ''

  let normalized = url
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4)
  }
  if (normalized.startsWith('https://github.com/')) {
    normalized = normalized.slice('https://github.com/'.length)
  }
  if (normalized.startsWith('git@github.com:')) {
    normalized = normalized.slice('git@github.com:'.length)
  }
  return normalized
}

const run = async (command: string[], opts: { cwd?: string; stdin?: string } = {}) => {
  const proc = Bun.spawn(command, {
    cwd: opts.cwd,
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`command failed (${exitCode}): ${command.join(' ')}`)
  }
}

const ensureGhAuth = async () => {
  const status = Bun.spawn(['gh', 'auth', 'status', '-h', 'github.com'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const statusCode = await status.exited
  if (statusCode === 0) return

  const token = process.env.GH_TOKEN
  if (!token) {
    throw new Error('gh is not authenticated. Set GH_TOKEN or run gh auth login.')
  }

  await run(['gh', 'auth', 'login', '--with-token'], { stdin: token })
}

const guardPath = (path: string) => {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/' || trimmed === '/workspace' || trimmed === '/workspace/' || trimmed === '.') {
    throw new Error(`refusing to operate on unsafe path: ${path}`)
  }
}

const main = async () => {
  ensureCommand('gh')
  ensureCommand('git')

  const repoSlug = resolveRepoSlug()
  if (!repoSlug) {
    throw new Error('missing repo slug. Set CODEX_REPO_SLUG or CODEX_REPO_URL.')
  }

  const repoDir = (process.env.CODEX_CWD?.trim() || '/workspace/lab').replace(/\/+$/, '')
  const repoRef = process.env.CODEX_REPO_REF?.trim() || 'main'
  const repoUrl = `https://github.com/${repoSlug}.git`

  await ensureGhAuth()
  await run(['gh', 'auth', 'setup-git'])

  if (existsSync(`${repoDir}/.git`)) {
    await run(['git', '-C', repoDir, 'remote', 'set-url', 'origin', repoUrl])
    await run(['git', '-C', repoDir, 'fetch', '--prune', 'origin'])

    const hasBranch = Bun.spawn(['git', '-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${repoRef}`])
    const hasBranchCode = await hasBranch.exited
    if (hasBranchCode === 0) {
      await run(['git', '-C', repoDir, 'checkout', repoRef])
    } else {
      await run(['git', '-C', repoDir, 'checkout', '-B', repoRef, `origin/${repoRef}`])
    }
    await run(['git', '-C', repoDir, 'reset', '--hard', `origin/${repoRef}`])
  } else {
    guardPath(repoDir)
    await run(['rm', '-rf', repoDir])
    await run(['gh', 'repo', 'clone', repoSlug, repoDir])
    await run(['git', '-C', repoDir, 'checkout', repoRef])
  }

  console.log(`seeded ${repoSlug} into ${repoDir} at ${repoRef}`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
