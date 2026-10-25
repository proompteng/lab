#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

interface Options {
  certPath: string
  keychain: string
  dryRun: boolean
}

function printUsage(): void {
  console.log(`Usage: bun scripts/trust-ca-macos.ts <cert-path> [options]

Adds a CA certificate to the macOS System keychain as a trusted root.

Options:
  --keychain <path>  Keychain path (default: /Library/Keychains/System.keychain)
  --dry-run          Print the command without executing it
  --help, -h         Show this help message

Examples:
  bun scripts/trust-ca-macos.ts ~/github.com/certs/harvester-lan/harvester-lan-ca.crt
  bun scripts/trust-ca-macos.ts ./rootCA.pem --keychain /Library/Keychains/System.keychain
`)
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    certPath: '',
    keychain: '/Library/Keychains/System.keychain',
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--keychain': {
        const value = argv[++i]
        if (!value) throw new Error(`${arg} requires a value`)
        options.keychain = value
        break
      }
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (!options.certPath && !arg.startsWith('-')) {
          options.certPath = arg
          break
        }
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.certPath) {
    printUsage()
    throw new Error('Missing required <cert-path> argument')
  }

  return options
}

function expandHome(value: string): string {
  if (value === '~') {
    return homedir()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return `${homedir()}/${value.slice(2)}`
  }
  return value
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('This script only supports macOS (darwin).')
  }

  const options = parseArgs(process.argv.slice(2))
  const certPath = resolve(expandHome(options.certPath))
  const keychain = resolve(expandHome(options.keychain))

  if (!existsSync(certPath)) {
    throw new Error(`Certificate not found: ${certPath}`)
  }

  const baseCommand = ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, certPath]
  const command = process.getuid?.() === 0 ? baseCommand : ['sudo', ...baseCommand]
  const preview = command.join(' ')

  if (options.dryRun) {
    console.log(`[dry-run] ${preview}`)
    return
  }

  console.log(`> ${preview}`)
  const processResult = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await processResult.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}`)
  }

  console.log('CA certificate added to the System keychain.')
}

await main()
