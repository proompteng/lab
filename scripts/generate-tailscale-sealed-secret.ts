#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const fatal = (message: string, error?: unknown): never => {
  if (error && error instanceof Error) {
    console.error(message, '\n', error.message)
  } else if (error) {
    console.error(message, '\n', error)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const repoRoot = resolve(import.meta.dir, '..')

const [, , maybeOutput] = process.argv

if (maybeOutput?.startsWith('-')) {
  fatal(`Unknown flag '${maybeOutput}'. Pass an optional output path or nothing.`)
}

const outputPath = resolve(
  maybeOutput ? resolve(process.cwd(), maybeOutput) : join(repoRoot, 'argocd/applications/tailscale/base/secrets.yaml'),
)

const opClientIdPath = process.env.TAILSCALE_OP_CLIENT_ID_PATH ?? 'op://infra/tailscale operator/client_id'
const opClientSecretPath = process.env.TAILSCALE_OP_CLIENT_SECRET_PATH ?? 'op://infra/tailscale operator/client_secret'
const sealedControllerName = process.env.TAILSCALE_SEALED_CONTROLLER_NAME ?? 'sealed-secrets'
const sealedControllerNamespace = process.env.TAILSCALE_SEALED_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const secretName = 'operator-oauth-token'
const secretNamespace = 'tailscale'

const requireCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

requireCli('op')
requireCli('kubectl')
requireCli('kubeseal')

const readSecret = (path: string): string => {
  try {
    return execFileSync('op', ['read', path], { encoding: 'utf8' }).trim()
  } catch (error) {
    fatal(`Failed to read secret from 1Password path: ${path}`, error)
  }
}

const clientId = readSecret(opClientIdPath)
const clientSecret = readSecret(opClientSecretPath)

if (!clientId) {
  fatal(`Client ID is empty. Check 1Password path: ${opClientIdPath}`)
}

if (!clientSecret) {
  fatal(`Client secret is empty. Check 1Password path: ${opClientSecretPath}`)
}

const runKubectlSecret = (): string => {
  const args = [
    'create',
    'secret',
    'generic',
    secretName,
    '--namespace',
    secretNamespace,
    `--from-literal=client_id=${clientId}`,
    `--from-literal=client_secret=${clientSecret}`,
    '--dry-run=client',
    '-o',
    'yaml',
  ]

  try {
    return execFileSync('kubectl', args, { encoding: 'utf8' })
  } catch (error) {
    fatal('Failed to generate Kubernetes Secret manifest with kubectl', error)
  }
}

const secretManifest = runKubectlSecret()

const runKubeseal = (manifest: string): string => {
  const args = [
    '--controller-name',
    sealedControllerName,
    '--controller-namespace',
    sealedControllerNamespace,
    '--format',
    'yaml',
  ]

  try {
    return execFileSync('kubeseal', args, { input: manifest, encoding: 'utf8' })
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  }
}

const sealedSecret = runKubeseal(secretManifest)

if (!sealedSecret.includes('client_id:') || !sealedSecret.includes('client_secret:')) {
  fatal('kubeseal output missing expected encrypted fields')
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, sealedSecret, { mode: 0o600 })
chmodSync(outputPath, 0o600)

console.log(`SealedSecret written to ${outputPath}. Commit and trigger an Argo CD sync to roll it out.`)
