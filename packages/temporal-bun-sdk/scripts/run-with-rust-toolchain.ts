#!/usr/bin/env bun
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { env, argv, stderr } from 'node:process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

type CommandArgs = ReadonlyArray<string>

type CommandInvocation = {
  command: string
  args: CommandArgs
}

const args = argv.slice(2)
if (args.length === 0) {
  stderr.write('Usage: run-with-rust-toolchain <command> [args...]\n')
  process.exit(1)
}

const homeDir = env.HOME ?? os.homedir()
const cargoHome = env.CARGO_HOME ?? `${homeDir}/.cargo`
const cargoBinDir = `${cargoHome}/bin`
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const run = (
  command: string,
  commandArgs: CommandArgs,
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> => spawnSync(command, commandArgs, { stdio: 'inherit', ...options })

const runQuiet = (
  command: string,
  commandArgs: CommandArgs,
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> => spawnSync(command, commandArgs, { stdio: ['ignore', 'ignore', 'ignore'], ...options })

const captureStdout = (command: string, commandArgs: CommandArgs): string | null => {
  try {
    const result = spawnSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0 || !result.stdout) {
      return null
    }
    return (result.stdout as string).trim()
  } catch {
    return null
  }
}

const tryCommand = (command: string, commandArgs: CommandArgs): boolean => {
  try {
    const result = runQuiet(command, commandArgs)
    return result.status === 0 && !result.error
  } catch {
    return false
  }
}

const isRunningAsRoot = () => (typeof process.getuid === 'function' ? process.getuid() === 0 : false)

const ensureCargo = (): boolean => {
  if (tryCommand('cargo', ['--version']) || tryCommand(`${cargoBinDir}/cargo`, ['--version'])) {
    return true
  }

  if (!env.CI) {
    stderr.write(
      'Cargo toolchain is required to build Temporal core artifacts. Install Rust from https://rustup.rs/ and retry.\n',
    )
    return false
  }

  stderr.write('Cargo not found on PATH; installing stable Rust toolchain via rustup...\n')
  const install = run('sh', [
    '-c',
    'curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable',
  ])

  if (install.status !== 0 || install.error) {
    stderr.write('Failed to install Rust using rustup.\n')
    return false
  }

  if (!tryCommand(`${cargoBinDir}/cargo`, ['--version'])) {
    stderr.write('Rust installation completed but cargo is still unavailable at the expected path.\n')
    return false
  }

  stderr.write('Rust toolchain installed successfully.\n')
  return true
}

const appendCellarIncludes = (includeDirs: Set<string>, cellarRoot?: string | null) => {
  if (!cellarRoot) {
    return
  }

  const protobufCellar = path.join(cellarRoot, 'protobuf')
  if (!existsSync(protobufCellar)) {
    return
  }

  try {
    for (const entry of readdirSync(protobufCellar, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        includeDirs.add(path.join(protobufCellar, entry.name, 'include'))
      }
    }
  } catch {
    // Ignore filesystem issues and fall back to other include locations.
  }
}

const collectHomebrewIncludeDirs = (): Set<string> => {
  const includeDirs = new Set<string>()
  const prefixCandidates = new Set<string>()

  const addIncludeDir = (dir?: string | null) => {
    if (dir) {
      includeDirs.add(dir)
    }
  }

  const addPrefixCandidate = (prefix?: string | null) => {
    if (prefix) {
      prefixCandidates.add(prefix)
    }
  }

  addPrefixCandidate(env.HOMEBREW_PREFIX ?? null)
  addPrefixCandidate(env.BREW_PREFIX ?? null)
  addPrefixCandidate('/opt/homebrew')

  const brewExecutables = new Set(
    [env.HOMEBREW_BREW_FILE, '/opt/homebrew/bin/brew', '/usr/local/bin/brew', 'brew'].filter(Boolean) as string[],
  )

  for (const brewExecutable of brewExecutables) {
    const protobufPrefix = captureStdout(brewExecutable, ['--prefix', 'protobuf'])
    if (protobufPrefix) {
      addIncludeDir(path.join(protobufPrefix, 'include'))
      addPrefixCandidate(path.resolve(protobufPrefix, '..', '..'))
      appendCellarIncludes(includeDirs, path.resolve(protobufPrefix, '..', '..', 'Cellar'))
    }

    const defaultPrefix = captureStdout(brewExecutable, ['--prefix'])
    addPrefixCandidate(defaultPrefix)
  }

  appendCellarIncludes(includeDirs, env.HOMEBREW_CELLAR ?? null)

  for (const prefixCandidate of prefixCandidates) {
    addIncludeDir(path.join(prefixCandidate, 'include'))
    addIncludeDir(path.join(prefixCandidate, 'opt', 'protobuf', 'include'))
    appendCellarIncludes(includeDirs, path.join(prefixCandidate, 'Cellar'))
  }

  return includeDirs
}

const hasWellKnownTypes = (): boolean => {
  const wellKnownRelative = ['google', 'protobuf', 'duration.proto']
  const includeDirs = new Set<string>(['/usr/include', '/usr/local/include', ...collectHomebrewIncludeDirs()])

  const candidates = [
    ...Array.from(includeDirs).map((dir) => path.join(dir, ...wellKnownRelative)),
    path.join(scriptDir, '..', 'vendor', 'sdk-core', 'sdk-core-protos', 'protos', 'api_upstream', ...wellKnownRelative),
  ]

  return candidates.some((candidate) => existsSync(candidate))
}

const findCommand = (candidates: Array<string | undefined>, testArgs: CommandArgs = ['--version']): string | null => {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    if (tryCommand(candidate, testArgs)) {
      return candidate
    }
  }
  return null
}

const resolveAptInstallInvocation = (): CommandInvocation | null => {
  const aptGet = findCommand([env.APT_GET_PATH, '/usr/bin/apt-get', '/usr/local/bin/apt-get', 'apt-get'])
  if (!aptGet) {
    return null
  }

  if (isRunningAsRoot()) {
    return {
      command: aptGet,
      args: ['install', '-y', 'libprotobuf-dev'],
    }
  }

  const sudo = findCommand([env.SUDO_PATH, '/usr/bin/sudo', '/usr/local/bin/sudo', 'sudo'])
  if (sudo && tryCommand(sudo, ['-n', 'true'])) {
    return {
      command: sudo,
      args: ['-n', aptGet, 'install', '-y', 'libprotobuf-dev'],
    }
  }

  return null
}

const ensureProtobufIncludes = (): boolean => {
  if (hasWellKnownTypes()) {
    return true
  }

  if (!env.CI) {
    stderr.write(
      'Missing google/protobuf well-known types; install libprotobuf-dev (or ensure protoc includes are on PATH) and retry.\n',
    )
    return false
  }

  const aptInvocation = resolveAptInstallInvocation()
  if (!aptInvocation) {
    stderr.write(
      'Unable to install libprotobuf-dev automatically because apt-get/sudo are unavailable or require a password. Install it manually and retry.\n',
    )
    return false
  }

  stderr.write('Protobuf well-known type headers not found; installing libprotobuf-dev...\n')
  const install = run(aptInvocation.command, aptInvocation.args)

  if (install.status !== 0 || install.error) {
    stderr.write('Failed to install libprotobuf-dev via apt.\n')
    return false
  }

  if (!hasWellKnownTypes()) {
    stderr.write('libprotobuf-dev installed but google/protobuf headers still missing.\n')
    return false
  }

  return true
}

if (!ensureCargo() || !ensureProtobufIncludes()) {
  process.exit(1)
}

const [command, ...commandArgs] = args
const combinedPath = [cargoBinDir, env.PATH ?? ''].filter(Boolean).join(path.delimiter)
const result = run(command, commandArgs, {
  env: {
    ...env,
    PATH: combinedPath,
    CARGO_HOME: cargoHome,
  },
})

process.exit(result.status === null ? 1 : result.status)
