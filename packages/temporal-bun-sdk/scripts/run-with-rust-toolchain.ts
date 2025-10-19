#!/usr/bin/env bun
import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { argv, env, stderr } from 'node:process'
import { fileURLToPath } from 'node:url'

type CommandArgs = ReadonlyArray<string>

const args = argv.slice(2)
if (args.length === 0) {
  stderr.write('Usage: run-with-rust-toolchain <command> [args...]\n')
  process.exit(1)
}

const homeDir = env.HOME ?? os.homedir()
const cargoHome = env.CARGO_HOME ?? `${homeDir}/.cargo`
const cargoBinDir = `${cargoHome}/bin`
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const run = (command: string, commandArgs: CommandArgs, options: SpawnSyncOptions = {}): SpawnSyncReturns<Buffer> =>
  spawnSync(command, commandArgs, { stdio: 'inherit', ...options })

const tryCommand = (command: string, commandArgs: CommandArgs, options: SpawnSyncOptions = {}): boolean => {
  try {
    const result = spawnSync(command, commandArgs, {
      stdio: ['ignore', 'ignore', 'ignore'],
      ...options,
    })
    return result.status === 0 && !result.error
  } catch {
    return false
  }
}

const resolvePathWithCargo = (): string => [cargoBinDir, env.PATH ?? ''].filter(Boolean).join(path.delimiter)

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
    try {
      const result = spawnSync(brewExecutable, ['--prefix', 'protobuf'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (result.status === 0 && result.stdout) {
        const protobufPrefix = (result.stdout as string).trim()
        addIncludeDir(path.join(protobufPrefix, 'include'))
        addPrefixCandidate(path.resolve(protobufPrefix, '..', '..'))
        appendCellarIncludes(includeDirs, path.resolve(protobufPrefix, '..', '..', 'Cellar'))
      }
    } catch {
      // Ignore brew detection failures and continue gathering include candidates.
    }

    try {
      const defaultPrefixResult = spawnSync(brewExecutable, ['--prefix'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (defaultPrefixResult.status === 0 && defaultPrefixResult.stdout) {
        addPrefixCandidate((defaultPrefixResult.stdout as string).trim())
      }
    } catch {
      // Ignore brew detection failures and continue gathering include candidates.
    }
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

const ensureCargo = (): boolean => {
  const pathWithCargo = resolvePathWithCargo()
  if (tryCommand('cargo', ['--version'], { env: { ...env, PATH: pathWithCargo } })) {
    return true
  }

  stderr.write(
    'Cargo is required but was not found on PATH. The Codex build image now bundles the Rust toolchain; rebuild the image (apps/froussard/Dockerfile.codex) or install Rust manually before retrying.\n',
  )
  return false
}

const ensureProtoc = (): boolean => {
  if (tryCommand('protoc', ['--version'])) {
    return true
  }

  stderr.write(
    '`protoc` is required but missing. Ensure protobuf-compiler is installed or run inside the updated Codex build image (#1546).\n',
  )
  return false
}

const ensureProtobufIncludes = (): boolean => {
  if (hasWellKnownTypes()) {
    return true
  }

  stderr.write(
    'Protobuf well-known type headers (google/protobuf/*.proto) are missing. Install libprotobuf-dev or rebuild with the refreshed Codex image so headers are available.\n',
  )
  return false
}

if (!ensureCargo() || !ensureProtoc() || !ensureProtobufIncludes()) {
  process.exit(1)
}

const [command, ...commandArgs] = args
const combinedPath = resolvePathWithCargo()
const result = run(command, commandArgs, {
  env: {
    ...env,
    PATH: combinedPath,
    CARGO_HOME: cargoHome,
  },
})

process.exit(result.status === null ? 1 : result.status)
