#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

const computeFileHash = async (path: string): Promise<string | null> => {
  try {
    const data = await readFile(path)
    const hash = createHash('sha256')
    hash.update(data)
    return hash.digest('hex')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
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
  const commandWithEnv = `export NVM_DIR="${nvmDir}"; [ -s "${nvmScript}" ] && . "${nvmScript}"; nvm use --silent default >/dev/null || nvm use --silent ${process.env.NODE_VERSION ?? '22'} >/dev/null; ${command}`
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

const shouldSkipPnpmInstall = async (targetDir: string): Promise<boolean> => {
  if (process.env.DOCKER_ENABLED !== '1') {
    return false
  }

  const gitDir = join(targetDir, '.git')
  const pnpmStoreDir = join(targetDir, 'node_modules/.pnpm')

  if (!(await pathExists(gitDir)) || !(await pathExists(pnpmStoreDir))) {
    return false
  }

  const lockfilePath = join(targetDir, 'pnpm-lock.yaml')
  const recordedHashPath = join(targetDir, 'node_modules/.codex-pnpm-lock.sha256')
  const lockfileHash = await computeFileHash(lockfilePath)
  const recordedHash = await computeFileHash(recordedHashPath)

  if (lockfileHash && recordedHash && lockfileHash === recordedHash) {
    console.log('Skipping pnpm install: existing workspace and lockfile unchanged (DOCKER_ENABLED=1).')
    return true
  }

  return false
}

const recordLockfileHash = async (targetDir: string) => {
  const lockfilePath = join(targetDir, 'pnpm-lock.yaml')
  const lockfileHash = await computeFileHash(lockfilePath)
  if (!lockfileHash) {
    return
  }

  const recordedHashPath = join(targetDir, 'node_modules/.codex-pnpm-lock.sha256')
  await ensureParentDir(recordedHashPath)
  await writeFile(recordedHashPath, lockfileHash, 'utf8')
}

const bootstrapWorkspace = async (targetDir: string) => {
  if (process.env.CODEX_SKIP_BOOTSTRAP === '1') {
    return
  }

  const pnpmExecutable = await ensurePnpmAvailable()

  if (await shouldSkipPnpmInstall(targetDir)) {
    return
  }

  console.log('Installing workspace dependencies via pnpm...')
  await runWithNvm(`"${pnpmExecutable}" install --frozen-lockfile`)
  await recordLockfileHash(targetDir)
}

const waitForDocker = async () => {
  const dockerHost = process.env.DOCKER_HOST
  if (!dockerHost) {
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

  await bootstrapWorkspace(targetDir)
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
