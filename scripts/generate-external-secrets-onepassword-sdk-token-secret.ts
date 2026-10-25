#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const defaultOutputPath = resolve(
  repoRoot,
  'argocd/applications/external-secrets/onepassword-sdk-token-sealedsecret.yaml',
)
const defaultOpTokenPath = 'op://infra/external-secrets/service-account-token'

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-external-secrets-onepassword-sdk-token-secret.ts [output-path]

Reads the 1Password service-account token from 1Password, seals it with kubeseal,
and writes the SealedSecret manifest to
argocd/applications/external-secrets/onepassword-sdk-token-sealedsecret.yaml by default.

Environment overrides:
  EXTERNAL_SECRETS_ONEPASSWORD_SDK_TOKEN_OP_PATH
  EXTERNAL_SECRETS_SEALED_CONTROLLER_NAME
  EXTERNAL_SECRETS_SEALED_CONTROLLER_NAMESPACE
  SEALED_SECRETS_CONTROLLER_NAME
  SEALED_SECRETS_CONTROLLER_NAMESPACE
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
const opTokenPath = process.env.EXTERNAL_SECRETS_ONEPASSWORD_SDK_TOKEN_OP_PATH ?? defaultOpTokenPath
const sealedControllerName =
  process.env.EXTERNAL_SECRETS_SEALED_CONTROLLER_NAME ?? process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const sealedControllerNamespace =
  process.env.EXTERNAL_SECRETS_SEALED_CONTROLLER_NAMESPACE ??
  process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ??
  'sealed-secrets'

const secretName = 'onepassword-sdk-token'
const secretNamespace = 'external-secrets'
const secretKey = 'token'

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

ensureCli('op')
ensureCli('kubectl')
ensureCli('kubeseal')

const readSecret = async (path: string): Promise<string> => {
  try {
    const result = await $`op read ${path}`.text()
    return result.replace(/\r?\n/g, '')
  } catch (error) {
    fatal(`Failed to read secret from 1Password path: ${path}`, error)
  }
}

const token = await readSecret(opTokenPath)

if (!token) {
  fatal(`1Password SDK token is empty. Check 1Password path: ${opTokenPath}`)
}

const tempDir = mkdtempSync(join(tmpdir(), 'external-secrets-onepassword-token-'))
const tokenFilePath = join(tempDir, 'token.txt')

const cleanupTemp = () => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
}

try {
  writeFileSync(tokenFilePath, token, { mode: 0o600 })
} catch (error) {
  cleanupTemp()
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
    cleanupTemp()
    fatal('Failed to generate Kubernetes Secret manifest with kubectl', error)
  }
}

const secretManifest = await runKubectlCreate()

const runKubeseal = async (manifest: string): Promise<string> => {
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(manifestPath, manifest)
  } catch (error) {
    cleanupTemp()
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
    cleanupTemp()
    fatal('Failed to seal secret with kubeseal', error)
  } finally {
    try {
      rmSync(manifestPath, { force: true })
    } catch {}
  }
}

const sealedSecret = await runKubeseal(secretManifest)

if (!sealedSecret.includes(`${secretKey}:`)) {
  cleanupTemp()
  fatal(`kubeseal output missing expected encrypted field '${secretKey}'`)
}

cleanupTemp()

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, sealedSecret, { mode: 0o600 })
chmodSync(outputPath, 0o600)

console.log(`SealedSecret written to ${outputPath}. Commit and sync external-secrets to roll out the token.`)
