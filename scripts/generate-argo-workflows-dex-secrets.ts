#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { $ } from 'bun'

type CliOptions = {
  argocdOutput?: string
  workflowsOutput?: string
  configPath?: string
  controllerName?: string
  controllerNamespace?: string
  clientId?: string
  clientSecret?: string
  password?: string
  keepTemp?: boolean
}

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
const defaultArgocdOutput = resolve(repoRoot, 'argocd/applications/argocd/base/argo-workflows-sso-sealedsecret.yaml')
const defaultWorkflowsOutput = resolve(
  repoRoot,
  'argocd/applications/argo-workflows/argo-workflows-sso-sealedsecret.yaml',
)
const defaultConfigPath = resolve(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml')

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-argo-workflows-dex-secrets.ts [options]

Options:
  --argocd-output <path>         Override output path for the Argo CD SealedSecret (default: ${defaultArgocdOutput}).
  --workflows-output <path>      Override output path for the Argo Workflows SealedSecret (default: ${defaultWorkflowsOutput}).
  --config-path <path>           Path to the Dex config patch (default: ${defaultConfigPath}).
  --controller-name <name>       Sealed Secrets controller name (default: sealed-secrets).
  --controller-namespace <ns>    Sealed Secrets controller namespace (default: sealed-secrets).
  --client-id <value>            Use an explicit OIDC client ID instead of generating one.
  --client-secret <value>        Use an explicit OIDC client secret instead of generating one.
  --password <value>             Use an explicit Dex static password instead of generating one.
  --keep-temp                    Preserve temporary manifests (useful for debugging sealing issues).
  --help                         Show this help message.
`)
  process.exit(0)
}

const parseArgs = (): CliOptions => {
  const options: CliOptions = {}
  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]
    if (!raw) continue

    if (raw === '--help' || raw === '-h') {
      printUsage()
    }

    const hasValue = raw.startsWith('--')
    const [flag, inline] = hasValue ? raw.split('=') : [raw, undefined]

    const nextValue = (): string => {
      if (inline !== undefined) return inline
      const value = args[i + 1]
      if (!value || value.startsWith('-')) fatal(`Flag '${flag}' requires a value`)
      i += 1
      return value
    }

    switch (flag) {
      case '--argocd-output':
        options.argocdOutput = nextValue()
        break
      case '--workflows-output':
        options.workflowsOutput = nextValue()
        break
      case '--config-path':
        options.configPath = nextValue()
        break
      case '--controller-name':
        options.controllerName = nextValue()
        break
      case '--controller-namespace':
        options.controllerNamespace = nextValue()
        break
      case '--client-id':
        options.clientId = nextValue()
        break
      case '--client-secret':
        options.clientSecret = nextValue()
        break
      case '--password':
        options.password = nextValue()
        break
      case '--keep-temp':
        options.keepTemp = true
        break
      default:
        if (flag.startsWith('-')) fatal(`Unknown flag '${flag}'. Use --help for usage.`)
        else fatal(`Unexpected argument '${flag}'. Use --help for usage.`)
    }
  }

  return options
}

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) fatal(`Required CLI '${binary}' is not available in PATH`)
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

const randomString = (length: number, alphabet: string) => {
  const bytes = randomBytes(length * 2)
  const chars: string[] = []
  for (let i = 0; chars.length < length && i < bytes.length; i += 1) {
    chars.push(alphabet[bytes[i] % alphabet.length])
  }
  while (chars.length < length) {
    const retry = randomBytes(1)[0] % alphabet.length
    chars.push(alphabet[retry])
  }
  return chars.join('')
}

const sealSecret = async (manifest: string, controllerName: string, controllerNamespace: string, keepTemp: boolean) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'argo-workflows-dex-'))
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(manifestPath, manifest)
  } catch (error) {
    fatal('Failed to write temporary manifest for kubeseal', error)
  }

  const baseCommand = [
    'kubeseal',
    '--controller-name',
    quote(controllerName),
    '--controller-namespace',
    quote(controllerNamespace),
    '--format',
    'yaml',
  ].join(' ')

  const command = `${baseCommand} < ${quote(manifestPath)}`

  try {
    const sealed = await $`bash -lc ${command}`.text()
    return sealed.startsWith('---') ? sealed : `---\n${sealed}`
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  } finally {
    if (!keepTemp) {
      try {
        rmSync(manifestPath, { force: true })
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    }
  }
}

const options = parseArgs()

ensureCli('kubeseal')

const controllerName = options.controllerName ?? process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const controllerNamespace =
  options.controllerNamespace ?? process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const argocdOutput = resolve(options.argocdOutput ?? defaultArgocdOutput)
const workflowsOutput = resolve(options.workflowsOutput ?? defaultWorkflowsOutput)
const configPath = resolve(options.configPath ?? defaultConfigPath)

const clientSecretAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const passwordAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+'

const clientId = options.clientId ?? 'argo-workflows-sso'
const clientSecret = options.clientSecret ?? randomString(48, clientSecretAlphabet)
const password = options.password ?? randomString(20, passwordAlphabet)

let passwordHash: string
try {
  passwordHash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })
} catch (error) {
  fatal('Failed to compute bcrypt hash for password', error)
}

const argocdSecretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: argo-workflows-sso
  namespace: argocd
stringData:
  client-id: ${clientId}
  client-secret: ${clientSecret}
  hash: ${passwordHash}
type: Opaque
`

const workflowsSecretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: argo-workflows-sso
  namespace: argo-workflows
stringData:
  client-id: ${clientId}
  client-secret: ${clientSecret}
type: Opaque
`

const sealedArgocdSecret = await sealSecret(
  argocdSecretManifest,
  controllerName,
  controllerNamespace,
  Boolean(options.keepTemp),
)
const sealedWorkflowsSecret = await sealSecret(
  workflowsSecretManifest,
  controllerName,
  controllerNamespace,
  Boolean(options.keepTemp),
)

const writeSealedSecret = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, 0o600)
  console.log(`SealedSecret written to ${path}`)
}

writeSealedSecret(argocdOutput, sealedArgocdSecret)
writeSealedSecret(workflowsOutput, sealedWorkflowsSecret)

try {
  const config = readFileSync(configPath, 'utf8')
  const updated = config.replace(
    /(hash:\s*")([^"]*)(")/,
    (_match, prefix, _oldHash, suffix) => `${prefix}${passwordHash}${suffix}`,
  )
  if (updated === config) {
    console.warn(`Warning: did not find existing hash in ${configPath}. File left unchanged.`)
  } else {
    writeFileSync(configPath, updated)
    console.log(`Updated static password hash in ${configPath}`)
  }
} catch (error) {
  fatal('Failed to update Dex configuration map with new password hash', error)
}

console.log('\nGenerated credentials (store securely):')
console.log(`  Client ID: ${clientId}`)
console.log(`  Client Secret: ${clientSecret}`)
console.log(`  Password: ${password}`)
console.log(`  Password Hash: ${passwordHash}`)
