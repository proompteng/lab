#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inspect } from 'node:util'
import { $ } from 'bun'

const fatal = (message: string, error?: unknown): never => {
  if (error instanceof Error) {
    console.error(`${message}\n${error.message}`)
  } else if (error) {
    console.error(`${message}\n${inspect(error)}`)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const repoRoot = resolve(import.meta.dir, '../../../..')
const defaultOutputPath = resolve(repoRoot, 'argocd/applications/symphony/codex-auth-sealedsecret.yaml')
const defaultNamespace = 'jangar'
const defaultSecretName = 'codex-auth-symphony'
const defaultSecretKey = 'auth.json'

const printUsage = (): never => {
  console.log(`Usage: bun run packages/scripts/src/symphony/generate-codex-auth-sealed-secret.ts [options]

Seals a Codex API-key auth.json payload into a SealedSecret manifest for Symphony pods.

Options:
  --namespace <namespace>      Secret namespace (default: ${defaultNamespace})
  --secret-name <name>         Secret name (default: ${defaultSecretName})
  --secret-key <key>           Secret data key (default: ${defaultSecretKey})
  --output <path>              Output path (default: ${defaultOutputPath})
  -h, --help                   Show this help

Environment:
  OPENAI_API_KEY                               Required. Used to build {"auth_mode":"apikey",...}.
  SEALED_SECRETS_CONTROLLER_NAME               Default: sealed-secrets
  SEALED_SECRETS_CONTROLLER_NAMESPACE          Default: sealed-secrets
`)
  process.exit(0)
}

const args = process.argv.slice(2)
let namespace = defaultNamespace
let secretName = defaultSecretName
let secretKey = defaultSecretKey
let outputPath = defaultOutputPath

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  switch (arg) {
    case '--namespace': {
      namespace = args[index + 1] ?? fatal('Missing value for --namespace')
      index += 1
      break
    }
    case '--secret-name': {
      secretName = args[index + 1] ?? fatal('Missing value for --secret-name')
      index += 1
      break
    }
    case '--secret-key': {
      secretKey = args[index + 1] ?? fatal('Missing value for --secret-key')
      index += 1
      break
    }
    case '--output': {
      outputPath = resolve(args[index + 1] ?? fatal('Missing value for --output'))
      index += 1
      break
    }
    case '--help':
    case '-h':
      printUsage()
      break
    default:
      fatal(`Unknown argument '${arg}'`)
  }
}

const sealedControllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const sealedControllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'
const apiKey = process.env.OPENAI_API_KEY?.trim()

if (!apiKey) {
  fatal('OPENAI_API_KEY is required')
}

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

ensureCli('kubectl')
ensureCli('kubeseal')

const tempDir = mkdtempSync(join(tmpdir(), 'symphony-codex-auth-'))
const authPath = join(tempDir, 'auth.json')
const secretManifestPath = join(tempDir, 'secret.yaml')

const authPayload = JSON.stringify(
  {
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  },
  null,
  2,
)

writeFileSync(authPath, authPayload, { mode: 0o600 })

const stats = statSync(authPath)
if (!stats.isFile() || stats.size === 0) {
  fatal(`Failed to create temporary auth payload at ${authPath}`)
}

const runKubectlCreate = async (): Promise<string> => {
  const command = [
    'kubectl create secret generic',
    quote(secretName),
    '--namespace',
    quote(namespace),
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
writeFileSync(secretManifestPath, secretManifest)

const runKubeseal = async (): Promise<string> => {
  const baseCommand = [
    'kubeseal',
    '--name',
    quote(secretName),
    '--namespace',
    quote(namespace),
    '--controller-name',
    quote(sealedControllerName),
    '--controller-namespace',
    quote(sealedControllerNamespace),
    '--format',
    'yaml',
  ].join(' ')

  try {
    return await $`bash -lc ${`${baseCommand} < ${quote(secretManifestPath)}`}`.text()
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  }
}

const sealedSecret = await runKubeseal()
if (!sealedSecret.includes(`${secretKey}:`)) {
  fatal(`kubeseal output missing expected encrypted field '${secretKey}'`)
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, sealedSecret, { mode: 0o600 })
chmodSync(outputPath, 0o600)

try {
  rmSync(tempDir, { recursive: true, force: true })
} catch {}

console.log(`SealedSecret written to ${outputPath}.`)
console.log(`Secret target: ${namespace}/${secretName}`)
