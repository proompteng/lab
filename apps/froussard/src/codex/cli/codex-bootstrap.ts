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

const resolveNvmDir = () => {
  const home = process.env.HOME ?? '/root'
  return process.env.NVM_DIR ?? join(home, '.nvm')
}

const runWithNvm = async (command: string, capture = false) => {
  const nvmDir = resolveNvmDir()
  const nvmScript = `${nvmDir}/nvm.sh`
  if (!(await pathExists(nvmScript))) {
    throw new Error(`Unable to locate nvm shim at ${nvmScript}`)
  }
  const commandWithEnv = `export NVM_DIR="${nvmDir}"; [ -s "${nvmScript}" ] && . "${nvmScript}"; nvm use --silent default >/dev/null || nvm use --silent ${process.env.NODE_VERSION ?? '24.11.1'} >/dev/null; ${command}`
  const task = $`bash -lc ${commandWithEnv}`
  if (capture) {
    return (await task.text()).trim()
  }
  await task
  return ''
}

const ensurePnpmAvailable = async (): Promise<string> => {
  const existing = await which('pnpm')
  if (existing) {
    return existing
  }

  try {
    await runWithNvm('corepack enable pnpm')
  } catch (error) {
    console.warn('corepack failed to enable pnpm, falling back to npm global install', error)
    await runWithNvm('npm install -g pnpm')
  }

  const pnpmPath = await runWithNvm('command -v pnpm', true)
  if (!pnpmPath) {
    throw new Error('pnpm installation via nvm failed: command -v pnpm returned empty result')
  }

  const pnpmBinDir = dirname(pnpmPath)
  process.env.NVM_DIR = resolveNvmDir()
  const currentPath = process.env.PATH ?? ''
  if (!currentPath.split(':').includes(pnpmBinDir)) {
    process.env.PATH = `${pnpmBinDir}:${currentPath}`
  }

  await runWithNvm(`ln -sf "${pnpmPath}" /usr/local/bin/pnpm`)

  return pnpmPath
}

const bootstrapWorkspace = async () => {
  if (process.env.CODEX_SKIP_BOOTSTRAP === '1') {
    return
  }

  const pnpmExecutable = await ensurePnpmAvailable()

  console.log('Installing workspace dependencies via pnpm...')
  await runWithNvm(`"${pnpmExecutable}" install --frozen-lockfile`)
}

const waitForDocker = async () => {
  const dockerHost = process.env.DOCKER_HOST
  const dockerEnabled = process.env.DOCKER_ENABLED === '1'

  if (!dockerEnabled || !dockerHost) {
    return
  }

  const maxAttempts = 6
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await $`docker info --format '{{json .ServerVersion}}'`
      return
    } catch (error) {
      lastError = error
      const delayMs = 1000 * attempt
      console.warn(`Waiting for Docker daemon at ${dockerHost} (attempt ${attempt}/${maxAttempts})...`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  const message =
    `Docker is not reachable via ${dockerHost}. Ensure the sidecar is healthy and port 2375 is exposed.\n` +
    'Hint: check sidecar logs and confirm DOCKER_TLS_VERIFY=0 when using the in-pod daemon.'

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

  process.env.WORKTREE = worktreeDefault
  process.env.TARGET_DIR = targetDir
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch

  await ensureParentDir(targetDir)

  const gitDir = join(targetDir, '.git')

  if (await pathExists(gitDir)) {
    await $`git -C ${targetDir} fetch --all --prune`
    await $`git -C ${targetDir} reset --hard origin/${baseBranch}`
  } else {
    await rm(targetDir, { recursive: true, force: true })
    await $`gh repo clone ${repoUrl} ${targetDir}`
    await $`git -C ${targetDir} checkout ${baseBranch}`
  }

  process.chdir(targetDir)

  if (headBranch && headBranch !== baseBranch) {
    const remoteHead =
      await $`git -C ${targetDir} show-ref --verify --quiet refs/remotes/origin/${headBranch}`.nothrow()
    const hasRemoteHead = remoteHead.exitCode === 0

    const checkoutResult = await $`git -C ${targetDir} checkout ${headBranch}`.nothrow()
    if (checkoutResult.exitCode !== 0) {
      const fromRef = hasRemoteHead ? `origin/${headBranch}` : `origin/${baseBranch}`
      await $`git -C ${targetDir} checkout -B ${headBranch} ${fromRef}`.nothrow()
    }

    if (hasRemoteHead) {
      const resetHead = await $`git -C ${targetDir} reset --hard origin/${headBranch}`.nothrow()
      if (resetHead.exitCode !== 0) {
        await $`git -C ${targetDir} reset --hard origin/${baseBranch}`.nothrow()
      }
    } else {
      await $`git -C ${targetDir} reset --hard origin/${baseBranch}`.nothrow()
    }
  }

  await bootstrapWorkspace()
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
