#!/usr/bin/env bun
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { $, spawn, which } from 'bun'
import { runCli } from './lib/cli'

const pathExists = async (path: string) => {
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

const ensureParentDir = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
}

const setDefaultEnv = (key: string, value: string) => {
  const current = process.env[key]
  if (!current || current.trim() === '') {
    process.env[key] = value
  }
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const ensureLessFlags = () => {
  const requiredFlags = new Set(['F', 'R', 'S', 'X'])
  const current = process.env.LESS ?? ''
  if (!current) {
    process.env.LESS = 'FRSX'
    return
  }

  const prefix = current.startsWith('-') ? '-' : ''
  const existingFlags = new Set(current.replace(/^-/, '').split(''))
  let updated = current.replace(/^-/, '')
  let changed = false

  for (const flag of requiredFlags) {
    if (!existingFlags.has(flag)) {
      updated += flag
      changed = true
    }
  }

  if (changed) {
    process.env.LESS = `${prefix}${updated}`
  }
}

const configureNonInteractiveEnvironment = () => {
  setDefaultEnv('GIT_TERMINAL_PROMPT', '0')
  setDefaultEnv('PAGER', 'cat')
  setDefaultEnv('GIT_PAGER', 'cat')
  setDefaultEnv('MANPAGER', 'cat')
  setDefaultEnv('SYSTEMD_PAGER', 'cat')
  setDefaultEnv('KUBECTL_PAGER', 'cat')
  setDefaultEnv('BAT_PAGER', 'cat')
  ensureLessFlags()
}

const normalizeDockerEnv = () => {
  const tlsVerify = process.env.DOCKER_TLS_VERIFY?.trim().toLowerCase()
  if (tlsVerify === '0' || tlsVerify === 'false' || tlsVerify === 'no') {
    delete process.env.DOCKER_TLS_VERIFY
  }
}

const configureBunCache = async (targetDir: string) => {
  const workspaceRoot = process.env.WORKSPACE ?? dirname(targetDir)
  const cacheDir = process.env.BUN_INSTALL_CACHE_DIR?.trim() || join(workspaceRoot, '.bun-install-cache')
  if (!process.env.BUN_INSTALL_CACHE_DIR) {
    process.env.BUN_INSTALL_CACHE_DIR = cacheDir
  }
  await mkdir(cacheDir, { recursive: true })
  return cacheDir
}

const resetBunCache = async (cacheDir: string) => {
  await rm(cacheDir, { recursive: true, force: true })
  await mkdir(cacheDir, { recursive: true })
}

const runBunInstall = async (bunExecutable: string, args: string[]) => {
  const child = spawn({
    cmd: [bunExecutable, 'install', ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  return exitCode ?? 1
}

const bootstrapWorkspace = async (cacheDir: string) => {
  if (process.env.CODEX_SKIP_BOOTSTRAP === '1') {
    return
  }

  const bunExecutable = (await which('bun')) ?? 'bun'
  console.log('Installing workspace dependencies via Bun...')
  const frozenExit = await runBunInstall(bunExecutable, ['--frozen-lockfile'])

  if (frozenExit !== 0) {
    console.warn('bun install --frozen-lockfile failed; clearing cache and retrying with copyfile backend')
    await resetBunCache(cacheDir)
    const retryExit = await runBunInstall(bunExecutable, ['--no-cache', '--backend=copyfile'])

    if (retryExit !== 0) {
      console.warn('bun install retry failed; attempting final install with --force and copyfile backend')
      const finalExit = await runBunInstall(bunExecutable, ['--force', '--no-cache', '--backend=copyfile'])
      if (finalExit !== 0) {
        throw new Error('Bun install failed even after cache reset retries')
      }
    }
  }
}

const waitForDocker = async () => {
  const dockerHost = process.env.DOCKER_HOST
  const dockerEnabled = process.env.DOCKER_ENABLED === '1'

  if (!dockerEnabled || !dockerHost) {
    return
  }

  const maxAttempts = parsePositiveInt(process.env.DOCKER_WAIT_ATTEMPTS, 12)
  const baseDelayMs = parsePositiveInt(process.env.DOCKER_WAIT_BASE_DELAY_MS, 1000)
  const maxDelayMs = parsePositiveInt(process.env.DOCKER_WAIT_MAX_DELAY_MS, 10000)
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await $`docker info --format '{{json .ServerVersion}}'`
      return
    } catch (error) {
      lastError = error
      const delayMs = Math.min(baseDelayMs * attempt, maxDelayMs)
      console.warn(`Waiting for Docker daemon at ${dockerHost} (attempt ${attempt}/${maxAttempts})...`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  const message =
    `Docker is not reachable via ${dockerHost}. Ensure the sidecar is healthy and port 2375 is exposed.\n` +
    'Hint: check sidecar logs and ensure DOCKER_TLS_VERIFY is unset (0/false is treated as unset) when using the in-pod daemon.'

  if (lastError instanceof Error) {
    lastError.message = `${message}\nLast error: ${lastError.message}`
    throw lastError
  }

  throw new Error(message)
}

export const runCodexBootstrap = async (argv: string[] = process.argv.slice(2)) => {
  const repoUrl = process.env.REPO_URL ?? 'https://github.com/proompteng/lab'
  const worktreeDefault = process.env.WORKTREE ?? '/workspace/lab'
  const targetDir = process.env.TARGET_DIR ?? worktreeDefault
  const baseBranch = process.env.BASE_BRANCH ?? 'main'
  const headBranch = process.env.HEAD_BRANCH ?? ''

  configureNonInteractiveEnvironment()
  normalizeDockerEnv()

  process.env.WORKTREE = worktreeDefault
  process.env.TARGET_DIR = targetDir
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch

  await ensureParentDir(targetDir)

  const gitDir = join(targetDir, '.git')

  if (await pathExists(gitDir)) {
    await $`git -C ${targetDir} fetch --all --prune`
  } else {
    await rm(targetDir, { recursive: true, force: true })
    await $`gh repo clone ${repoUrl} ${targetDir}`
    await $`git -C ${targetDir} checkout ${baseBranch}`
  }

  process.chdir(targetDir)

  const bunCacheDir = await configureBunCache(targetDir)

  if (headBranch && headBranch !== baseBranch) {
    const remoteHead = await $`git -C ${targetDir} rev-parse --verify --quiet origin/${headBranch}`.nothrow()
    const hasRemoteHead = remoteHead.exitCode === 0

    const checkoutResult = await $`git -C ${targetDir} checkout ${headBranch}`.nothrow()
    if (checkoutResult.exitCode !== 0) {
      const fromRef = hasRemoteHead ? `origin/${headBranch}` : `origin/${baseBranch}`
      await $`git -C ${targetDir} checkout -B ${headBranch} ${fromRef}`.nothrow()
    }
  }

  await bootstrapWorkspace(bunCacheDir)
  await waitForDocker()

  const [command, ...commandArgs] = argv
  if (!command) {
    return 0
  }

  const commandPath = (await which(command)) ?? command
  const child = spawn({
    cmd: [commandPath, ...commandArgs],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: targetDir,
  })

  const exitCode = await child.exited
  return exitCode ?? 0
}

await runCli(import.meta, async () => runCodexBootstrap())
