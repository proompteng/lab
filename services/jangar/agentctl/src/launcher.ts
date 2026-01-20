#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const resolveLabel = () => {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
  }

  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
  }

  return null
}

const resolveBinaryPath = () => {
  const override = process.env.AGENTCTL_BINARY?.trim()
  if (override) return override

  const label = resolveLabel()
  if (!label) return null

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  return resolve(scriptDir, `agentctl-${label}`)
}

const run = () => {
  const binaryPath = resolveBinaryPath()
  if (!binaryPath || !existsSync(binaryPath)) {
    console.error('agentctl binary not found. Run `bun run build:bins` to generate packaged binaries.')
    process.exit(1)
  }

  const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

run()
