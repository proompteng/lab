#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const defaultAuthPath = process.env.CODEX_AUTH ?? resolve(homedir(), '.codex/auth.json')

const printUsage = (): never => {
  console.log(`Usage: bun run packages/scripts/src/symphony/generate-codex-auth-sealed-secret.ts [options]

Seals a local Codex auth.json payload into a SealedSecret manifest for Symphony pods.

Options:
  --namespace <namespace>      Secret namespace (default: ${defaultNamespace})
  --secret-name <name>         Secret name (default: ${defaultSecretName})
  --secret-key <key>           Secret data key (default: ${defaultSecretKey})
  --auth-path <path>           Local Codex auth.json path (default: ${defaultAuthPath})
  --output <path>              Output path (default: ${defaultOutputPath})
  -h, --help                   Show this help

Environment:
  CODEX_AUTH                                   Optional fallback auth path.
  SEALED_SECRETS_CONTROLLER_NAME               Default: sealed-secrets
  SEALED_SECRETS_CONTROLLER_NAMESPACE          Default: sealed-secrets
`)
  process.exit(0)
}

const args = process.argv.slice(2)
let namespace = defaultNamespace
let secretName = defaultSecretName
let secretKey = defaultSecretKey
let authPath = defaultAuthPath
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
    case '--auth-path': {
      authPath = resolve(args[index + 1] ?? fatal('Missing value for --auth-path'))
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

const tempDir = mkdtempSync(join(tmpdir(), 'symphony-codex-auth-'))
const secretManifestPath = join(tempDir, 'secret.yaml')

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
