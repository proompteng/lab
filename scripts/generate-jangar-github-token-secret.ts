#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { $ } from 'bun'

const fatal = (message: string, error?: unknown): never => {
  if (error instanceof Error) {
    console.error(`${message}\n${error.message}`)
  } else if (error) {
    console.error(`${message}\n${error}`)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const repoRoot = resolve(import.meta.dir, '..')
const defaultOutputPath = resolve(repoRoot, 'argocd/applications/jangar/github-token.yaml')

const defaultEnvPath = resolve(repoRoot, '.env')
const defaultEnvKey = 'GITHUB_API_TOKEN'

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-jangar-github-token-secret.ts [output-path]

Reads the GitHub token from a .env file (defaults to ${defaultEnvPath}, key ${defaultEnvKey}),
seals it with kubeseal, and writes the SealedSecret manifest to argocd/applications/jangar/github-token.yaml
by default.

Overrides:
  JANGAR_GITHUB_TOKEN_ENV_FILE  Path to the .env file containing the token
  JANGAR_GITHUB_TOKEN_ENV_KEY   Environment key to read from the .env file
`)
  process.exit(0)
}

const args = process.argv.slice(2)

if (args.length > 1) {
  fatal('Too many arguments. Pass an optional output path or nothing.')
}

const maybeOutput = args[0]

if (maybeOutput === '--help' || maybeOutput === '-h') {
  printUsage()
}

if (maybeOutput?.startsWith('-')) {
  fatal(`Unknown flag '${maybeOutput}'. Pass an optional output path or nothing.`)
}

const outputPath = resolve(maybeOutput ?? defaultOutputPath)

const envFilePath = process.env.JANGAR_GITHUB_TOKEN_ENV_FILE ?? defaultEnvPath
const envKey = process.env.JANGAR_GITHUB_TOKEN_ENV_KEY ?? defaultEnvKey
const sealedControllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const sealedControllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const secretName = 'github-token'
const secretNamespace = 'jangar'
const secretKey = 'token'

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

ensureCli('kubectl')
ensureCli('kubeseal')

const parseEnvValue = (content: string, key: string): string | null => {
  const lines = content.split(/\r?\n/)
  for (const raw of lines) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const name = line.slice(0, eqIndex).trim()
    if (name !== key) continue
    let value = line.slice(eqIndex + 1).trim()
    if (!value) return ''
    const quoteChar = value[0]
    if ((quoteChar === '"' || quoteChar === "'") && value.endsWith(quoteChar)) {
      value = value.slice(1, -1)
      if (quoteChar === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      return value
    }
    const hashIndex = value.indexOf('#')
    if (hashIndex >= 0) {
      value = value.slice(0, hashIndex).trim()
    }
    return value
  }
  return null
}

const readEnvToken = (path: string, key: string): string => {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    fatal(`Failed to read .env file at ${path}`, error)
  }

  const value = parseEnvValue(content, key)
  if (value === null) {
    fatal(`Missing ${key} in ${path}`)
  }
  return value.replace(/\r?\n/g, '')
}

const githubToken = readEnvToken(envFilePath, envKey)

if (!githubToken) {
  fatal(`GitHub token is empty. Check ${envKey} in ${envFilePath}`)
}

const tempDir = mkdtempSync(join(tmpdir(), 'jangar-github-token-'))
const tokenFilePath = join(tempDir, 'token.txt')

try {
  writeFileSync(tokenFilePath, githubToken, { mode: 0o600 })
} catch (error) {
  fatal('Failed to write temporary token file', error)
}

const runKubectlCreate = async (): Promise<string> => {
  const command = [
    'kubectl create secret generic',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '--from-file',
    quote(`${secretKey}=${tokenFilePath}`),
    '--dry-run=client -o yaml',
  ].join(' ')

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to generate Kubernetes Secret manifest with kubectl', error)
  }
}

const secretManifest = await runKubectlCreate()

const runKubeseal = async (manifest: string): Promise<string> => {
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(manifestPath, manifest)
  } catch (error) {
    fatal('Failed to write temporary manifest for kubeseal', error)
  }

  const baseCommand = [
    'kubeseal',
    '--name',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '--controller-name',
    quote(sealedControllerName),
    '--controller-namespace',
    quote(sealedControllerNamespace),
    '--format',
    'yaml',
  ].join(' ')

  const command = `${baseCommand} < ${quote(manifestPath)}`

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  } finally {
    try {
      rmSync(manifestPath, { force: true })
    } catch {}
  }
}

const sealedSecret = await runKubeseal(secretManifest)

if (!sealedSecret.includes(`${secretKey}:`)) {
  fatal(`kubeseal output missing expected encrypted field '${secretKey}'`)
}

try {
  rmSync(tokenFilePath, { force: true })
  rmSync(tempDir, { recursive: true, force: true })
} catch {}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, sealedSecret, { mode: 0o600 })
chmodSync(outputPath, 0o600)

console.log(`SealedSecret written to ${outputPath}. Commit and sync jangar to roll out the new token.`)
