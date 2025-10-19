#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { env, argv, stderr } = process
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

if (!ensureCargo()) {
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
