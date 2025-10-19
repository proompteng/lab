#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { env, argv, stderr } = process
const { existsSync } = require('node:fs')
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

const hasWellKnownTypes = () => {
  const wellKnownRelative = ['google', 'protobuf', 'duration.proto']
  const includeDirs = new Set(['/usr/include', '/usr/local/include'])

  if (env.HOMEBREW_PREFIX) {
    includeDirs.add(path.join(env.HOMEBREW_PREFIX, 'include'))
  } else {
    includeDirs.add('/opt/homebrew/include')
  }

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
