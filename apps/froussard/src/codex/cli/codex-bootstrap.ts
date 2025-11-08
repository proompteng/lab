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

const resolveNvmDir = () => {
  const home = process.env.HOME ?? '/root'
  return process.env.NVM_DIR ?? join(home, '.nvm')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

const computeFileHash = async (path: string): Promise<string | null> => {
  if (!(await pathExists(path))) {
    return null
  }
  const contents = await readFile(path)
  const hash = createHash('sha256')
  hash.update(contents)
  return hash.digest('hex')
}

const readStoredLockHash = async (path: string): Promise<string | null> => {
  if (!(await pathExists(path))) {
    return null
  }
  const data = await readFile(path, 'utf8')
  const trimmed = data.trim()
  return trimmed.length > 0 ? trimmed : null
}

const writeStoredLockHash = async (path: string, value: string) => {
  await ensureParentDir(path)
  await writeFile(path, `${value}\n`, 'utf8')
}

const bootstrapWorkspace = async (targetDir: string, repoAlreadyCloned: boolean) => {
  if (process.env.CODEX_SKIP_BOOTSTRAP === '1') {
    return
  }

  const pnpmExecutable = await ensurePnpmAvailable()
  const dockerEnabled = process.env.DOCKER_ENABLED === '1'
  const pnpmMetadataDir = join(targetDir, 'node_modules/.pnpm')
  const lockfilePath = join(targetDir, 'pnpm-lock.yaml')
  const lockfileChecksumPath = join(targetDir, 'node_modules/.pnpm-lock.checksum')
  const lockfileExists = await pathExists(lockfilePath)
  const pnpmCacheExists = await pathExists(pnpmMetadataDir)
  const storedLockHash = await readStoredLockHash(lockfileChecksumPath)
  const currentLockHash = lockfileExists ? await computeFileHash(lockfilePath) : null

  const shouldSkipInstall =
    dockerEnabled &&
    repoAlreadyCloned &&
    pnpmCacheExists &&
    lockfileExists &&
    storedLockHash !== null &&
    currentLockHash !== null &&
    storedLockHash === currentLockHash

  if (shouldSkipInstall) {
    console.log('Detected cached pnpm workspace (Docker-enabled). Skipping dependency install.')
  } else {
    console.log('Installing workspace dependencies via pnpm...')
    await runWithNvm(`"${pnpmExecutable}" install --frozen-lockfile`)

    const refreshedLockHash = await computeFileHash(lockfilePath)
    if (refreshedLockHash) {
      await writeStoredLockHash(lockfileChecksumPath, refreshedLockHash)
    } else if (await pathExists(lockfileChecksumPath)) {
      await rm(lockfileChecksumPath, { force: true })
    }
  }

  console.log('Building Temporal Bun Zig native bridge...')
  await runWithNvm(`"${pnpmExecutable}" --filter @proompteng/temporal-bun-sdk run build:native:zig`)
}

const waitForDocker = async () => {
  const dockerHost = process.env.DOCKER_HOST
  if (!dockerHost) {
    return
  }

  const dockerBinary = await which('docker')
  if (!dockerBinary) {
    throw new Error('DOCKER_HOST is set but the docker CLI is missing from PATH.')
  }

  const maxAttempts = Number.parseInt(process.env.DOCKER_READY_ATTEMPTS ?? '20', 10)
  const delayMs = Number.parseInt(process.env.DOCKER_READY_DELAY_MS ?? '3000', 10)
  let attempt = 0
  let lastError: unknown

  while (attempt < maxAttempts) {
    attempt += 1
    try {
      await $`${dockerBinary} info`
      if (attempt > 1) {
        console.log(`Docker daemon became ready after ${attempt} attempts.`)
      }
      return
    } catch (error) {
      lastError = error
      console.log(`Waiting for Docker daemon at ${dockerHost} (attempt ${attempt}/${maxAttempts})...`)
      await sleep(delayMs)
    }
  }

  const hints: string[] = ['Timed out waiting for Docker daemon readiness']
  hints.push(`host=${dockerHost}`)
  if (lastError && typeof lastError === 'object') {
    const errorMessage = (lastError as { message?: string }).message
    const stderr = (lastError as { stderr?: string }).stderr
    if (errorMessage) {
      hints.push(`error=${errorMessage}`)
    }
    if (stderr) {
      hints.push(`stderr=${stderr.trim()}`)
    }
  }
  hints.push('Confirm the Codex Docker sidecar is running and reachable before invoking stage commands.')
  throw new Error(hints.join(' | '))
}

export const runCodexBootstrap = async (argv: string[] = process.argv.slice(2)) => {
  const repoUrl = process.env.REPO_URL ?? 'https://github.com/proompteng/lab'
  const worktreeDefault = process.env.WORKTREE ?? '/workspace/lab'
  const targetDir = process.env.TARGET_DIR ?? worktreeDefault
  const baseBranch = process.env.BASE_BRANCH ?? 'main'
  const headBranch = process.env.HEAD_BRANCH ?? ''

  process.env.WORKTREE = worktreeDefault
  process.env.TARGET_DIR = targetDir
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch

  await ensureParentDir(targetDir)

  const gitDir = join(targetDir, '.git')

  const repoAlreadyCloned = await pathExists(gitDir)

  if (repoAlreadyCloned) {
    await $`git -C ${targetDir} fetch --all --prune`
    await $`git -C ${targetDir} reset --hard origin/${baseBranch}`
  } else {
    await rm(targetDir, { recursive: true, force: true })
    await $`gh repo clone ${repoUrl} ${targetDir}`
    await $`git -C ${targetDir} checkout ${baseBranch}`
  }

  process.chdir(targetDir)

  await bootstrapWorkspace(targetDir, repoAlreadyCloned)

  const [command, ...commandArgs] = argv
  if (!command) {
    return 0
  }

  await waitForDocker()

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
