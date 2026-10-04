#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

const repoRoot = resolve(import.meta.dir, '../../../..')
const defaultOutputPath = resolve(repoRoot, 'argocd/applications/jangar/codex-auth-sealedsecret.yaml')
const defaultAuthPath = process.env.CODEX_AUTH ?? resolve(homedir(), '.codex/auth.json')

const printUsage = (): never => {
  console.log(`Usage: bun run packages/scripts/src/jangar/generate-codex-auth-sealed-secret.ts [output-path]

Reads the local Codex auth file (override with JANGAR_CODEX_AUTH_PATH or CODEX_AUTH),
seals it with kubeseal, and writes the SealedSecret manifest to
argocd/applications/jangar/codex-auth-sealedsecret.yaml by default.
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
const authPath = resolve(process.env.JANGAR_CODEX_AUTH_PATH ?? defaultAuthPath)
const sealedControllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const sealedControllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const secretName = 'codex-auth'
const secretNamespace = 'jangar'
const secretKey = 'auth.json'

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

ensureCli('kubectl')
ensureCli('kubeseal')

const validateAuthFile = (path: string) => {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(path)
  } catch (error) {
    fatal(`Codex auth file does not exist: ${path}`, error)
  }
  if (!stats.isFile()) {
    fatal(`Codex auth path is not a file: ${path}`)
  }
  try {
    const payload = readFileSync(path)
    if (payload.length === 0) {
      fatal(`Codex auth file is empty: ${path}`)
    }
  } catch (error) {
    fatal(`Failed to read Codex auth file: ${path}`, error)
  }
}

validateAuthFile(authPath)

const tempDir = mkdtempSync(join(tmpdir(), 'jangar-codex-auth-'))
const secretManifestPath = join(tempDir, 'secret.yaml')

const runKubectlCreate = async (): Promise<string> => {
  const command = [
    'kubectl create secret generic',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '--from-file',
    quote(`${secretKey}=${authPath}`),
    '--dry-run=client -o yaml',
  ].join(' ')

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to generate Kubernetes Secret manifest with kubectl', error)
  }
}

const secretManifest = await runKubectlCreate()

try {
  writeFileSync(secretManifestPath, secretManifest)
} catch (error) {
  fatal('Failed to write temporary manifest for kubeseal', error)
}

const runKubeseal = async (): Promise<string> => {
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

  const command = `${baseCommand} < ${quote(secretManifestPath)}`

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  }
}

const sealedSecret = await runKubeseal()

if (!sealedSecret.includes(`${secretKey}:`)) {
  fatal(`kubeseal output missing expected encrypted field '${secretKey}'`)
}

try {
  rmSync(tempDir, { recursive: true, force: true })
} catch {}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, sealedSecret, { mode: 0o600 })
chmodSync(outputPath, 0o600)

console.log(`SealedSecret written to ${outputPath}.`)
console.log(`Using auth source file: ${authPath}`)
