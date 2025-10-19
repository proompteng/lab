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

const bootstrapWorkspace = async () => {
  if (process.env.CODEX_SKIP_BOOTSTRAP === '1') {
    return
  }

  const pnpmExecutable = await ensurePnpmAvailable()

  console.log('Installing workspace dependencies via pnpm...')
  await runWithNvm(`"${pnpmExecutable}" install --frozen-lockfile`)

  console.log('Building Temporal Bun Zig native bridge...')
  await runWithNvm(`"${pnpmExecutable}" --filter @proompteng/temporal-bun-sdk run build:native:zig`)
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

  if (await pathExists(gitDir)) {
    await $`git -C ${targetDir} fetch --all --prune`
    await $`git -C ${targetDir} reset --hard origin/${baseBranch}`
  } else {
    await rm(targetDir, { recursive: true, force: true })
    await $`gh repo clone ${repoUrl} ${targetDir}`
    await $`git -C ${targetDir} checkout ${baseBranch}`
  }

  process.chdir(targetDir)

  await bootstrapWorkspace()

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
