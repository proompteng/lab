#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ZIG_VERSION = '0.15.1'

type SupportedPlatform =
  | { platform: 'linux'; arch: 'x64'; archivePrefix: string }
  | { platform: 'linux'; arch: 'arm64'; archivePrefix: string }
  | { platform: 'darwin'; arch: 'x64'; archivePrefix: string }
  | { platform: 'darwin'; arch: 'arm64'; archivePrefix: string }

function detectTarget(): SupportedPlatform {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'linux' && arch === 'x64') {
    return { platform: 'linux', arch: 'x64', archivePrefix: 'zig-x86_64-linux' }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { platform: 'linux', arch: 'arm64', archivePrefix: 'zig-aarch64-linux' }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { platform: 'darwin', arch: 'x64', archivePrefix: 'zig-x86_64-macos' }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { platform: 'darwin', arch: 'arm64', archivePrefix: 'zig-aarch64-macos' }
  }

  throw new Error(`Unsupported platform for Zig bootstrap: ${platform}-${arch}`)
}

async function ensureZigBinary(packageRoot: string): Promise<string> {
  if (process.env.ZIG_BIN && existsSync(process.env.ZIG_BIN)) {
    return process.env.ZIG_BIN
  }

  const discovered = await Bun.which('zig')
  if (discovered) {
    return discovered
  }

  const target = detectTarget()
  const archiveBase = `${target.archivePrefix}-${ZIG_VERSION}`
  const archiveName = `${archiveBase}.tar.xz`
  const downloadUrl = `https://ziglang.org/download/${ZIG_VERSION}/${archiveName}`
  const installRoot = join(packageRoot, '.zig-toolchain')
  const archivePath = join(installRoot, archiveName)
  const extractedDir = join(installRoot, archiveBase)
  const zigBinaryPath = join(extractedDir, 'zig')

  if (existsSync(zigBinaryPath)) {
    return zigBinaryPath
  }

  console.log(`Zig ${ZIG_VERSION} not found. Downloading ${downloadUrl}`)

  mkdirSync(installRoot, { recursive: true })

  const response = await fetch(downloadUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Zig toolchain: ${response.status} ${response.statusText}`)
  }

  await Bun.write(archivePath, response)

  console.log(`Extracting ${archiveName} to ${installRoot}`)

  const tarResult = Bun.spawn({
    cmd: ['tar', '-xJf', archivePath, '-C', installRoot],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const tarExit = await tarResult.exited
  if (tarExit !== 0) {
    throw new Error(`tar extraction failed with exit code ${tarExit}`)
  }

  if (!existsSync(zigBinaryPath)) {
    throw new Error(`Zig binary not found after extraction: ${zigBinaryPath}`)
  }

  try {
    chmodSync(zigBinaryPath, 0o755)
  } catch {}

  console.log(`Zig installed at ${zigBinaryPath}`)
  return zigBinaryPath
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() },
): Promise<void> {
  const processEnv = { ...process.env, ...options.env }
  const proc = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    env: processEnv,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}`)
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = join(scriptDir, '..')
  const env = { ...process.env, USE_PREBUILT_LIBS: 'true' }

  await runCommand('bun', ['run', 'scripts/download-temporal-libs.ts', 'download'], {
    cwd: packageRoot,
    env,
  })

  const zigBinary = await ensureZigBinary(packageRoot)
  const buildFile = join('native', 'temporal-bun-bridge-zig', 'build.zig')

  await runCommand(zigBinary, ['build', '-Doptimize=ReleaseFast', '--build-file', buildFile], {
    cwd: packageRoot,
    env,
  })

  await runCommand(zigBinary, ['build', '-Doptimize=Debug', '--build-file', buildFile, 'test'], {
    cwd: packageRoot,
    env,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
