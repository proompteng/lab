#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { env, argv, stderr } = process
const { existsSync, readdirSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const args = argv.slice(2)
if (args.length === 0) {
  stderr.write('Usage: run-with-rust-toolchain <command> [args...]\n')
  process.exit(1)
}

const homeDir = env.HOME || os.homedir()
const cargoHome = env.CARGO_HOME ? env.CARGO_HOME : `${homeDir}/.cargo`
const cargoBinDir = `${cargoHome}/bin`

const run = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    stdio: 'inherit',
    ...options,
  })

const captureStdout = (command, commandArgs) => {
  try {
    const result = spawnSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0 || !result.stdout) {
      return null
    }
    return result.stdout.trim()
  } catch {
    return null
  }
}

const tryCommand = (command, commandArgs) => run(command, commandArgs, { stdio: 'ignore' }).status === 0

const ensureCargo = () => {
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
  if (install.status !== 0) {
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

const appendCellarIncludes = (includeDirs, cellarRoot) => {
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
    // Ignore filesystem issues; fall back to other include locations.
  }
}

const collectHomebrewIncludeDirs = () => {
  const includeDirs = new Set()
  const prefixCandidates = new Set()
  const addIncludeDir = (dir) => {
    if (dir) {
      includeDirs.add(dir)
    }
  }
  const addPrefixCandidate = (prefix) => {
    if (prefix) {
      prefixCandidates.add(prefix)
    }
  }

  addPrefixCandidate(env.HOMEBREW_PREFIX)
  addPrefixCandidate(env.BREW_PREFIX)
  addPrefixCandidate('/opt/homebrew')

  const brewExecutables = new Set(
    [env.HOMEBREW_BREW_FILE, '/opt/homebrew/bin/brew', '/usr/local/bin/brew', 'brew'].filter(Boolean),
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

  appendCellarIncludes(includeDirs, env.HOMEBREW_CELLAR)

  for (const prefixCandidate of prefixCandidates) {
    addIncludeDir(path.join(prefixCandidate, 'include'))
    addIncludeDir(path.join(prefixCandidate, 'opt', 'protobuf', 'include'))
    appendCellarIncludes(includeDirs, path.join(prefixCandidate, 'Cellar'))
  }

  return includeDirs
}

const hasWellKnownTypes = () => {
  const wellKnownRelative = ['google', 'protobuf', 'duration.proto']
  const includeDirs = new Set(['/usr/include', '/usr/local/include', ...collectHomebrewIncludeDirs()])

  const candidates = [
    ...Array.from(includeDirs).map((dir) => path.join(dir, ...wellKnownRelative)),
    path.join(
      __dirname,
      '..',
      'vendor',
      'sdk-core',
      'sdk-core-protos',
      'protos',
      'api_upstream',
      ...wellKnownRelative,
    ),
  ]

  return candidates.some((candidate) => existsSync(candidate))
}

const ensureProtobufIncludes = () => {
  if (hasWellKnownTypes()) {
    return true
  }

  if (!env.CI) {
    stderr.write(
      'Missing google/protobuf well-known types; install libprotobuf-dev (or ensure protoc includes are on PATH) and retry.\n',
    )
    return false
  }

  stderr.write('Protobuf well-known type headers not found; installing libprotobuf-dev...\n')
  const install = run('sudo', ['apt-get', 'install', '-y', 'libprotobuf-dev'])
  if (install.status !== 0) {
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

const command = args[0]
const commandArgs = args.slice(1)
const combinedPath = `${cargoBinDir}:${env.PATH || ''}`

const result = run(command, commandArgs, {
  env: {
    ...env,
    PATH: combinedPath,
    CARGO_HOME: cargoHome,
  },
})

process.exit(result.status === null ? 1 : result.status)
