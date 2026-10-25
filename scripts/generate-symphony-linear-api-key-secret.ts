#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { $ } from 'bun'

type CliOptions = {
  apiKey?: string
  controllerName: string
  controllerNamespace: string
  opPath: string
  outputPath: string
  useClusterSecret: boolean
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
const defaultOutputPath = resolve(repoRoot, 'argocd/applications/symphony/linear-api-key-sealedsecret.yaml')
const defaultOpPath = 'op://infra/linear/password'
const defaultControllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const defaultControllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const secretName = 'symphony-linear-api-key'
const secretNamespace = 'jangar'
const secretKey = 'LINEAR_API_KEY'

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-symphony-linear-api-key-secret.ts [options] [output-path]

Reads the Symphony Linear API key from 1Password by default, seals it with kubeseal,
and writes the SealedSecret manifest to argocd/applications/symphony/linear-api-key-sealedsecret.yaml.

Options:
  --api-key <value>             Use this Linear API key directly.
  --from-cluster-secret         Read LINEAR_API_KEY from the live secret in namespace '${secretNamespace}'.
  --op-path <path>              1Password path to read (default: ${defaultOpPath}).
  --output <path>               Override the output manifest path.
  --controller-name <name>      Sealed Secrets controller name (default: ${defaultControllerName}).
  --controller-namespace <ns>   Sealed Secrets controller namespace (default: ${defaultControllerNamespace}).
  -h, --help                    Show this help message.

Environment overrides:
  SYMPHONY_LINEAR_API_KEY_OP_PATH
  SEALED_SECRETS_CONTROLLER_NAME
  SEALED_SECRETS_CONTROLLER_NAMESPACE
`)
  process.exit(0)
}

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2)
  const options: CliOptions = {
    controllerName: defaultControllerName,
    controllerNamespace: defaultControllerNamespace,
    opPath: process.env.SYMPHONY_LINEAR_API_KEY_OP_PATH ?? defaultOpPath,
    outputPath: defaultOutputPath,
    useClusterSecret: false,
  }

  let positionalOutputPath: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      printUsage()
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith('-')) {
        fatal(`Flag '${flag}' requires a value`)
      }
      index += 1
      return value
    }

    switch (flag) {
      case '--api-key':
        if (options.useClusterSecret) {
          fatal(`Flag '${flag}' cannot be combined with --from-cluster-secret`)
        }
        options.apiKey = readValue()
        break
      case '--from-cluster-secret':
        if (options.apiKey) {
          fatal(`Flag '${flag}' cannot be combined with --api-key`)
        }
        options.useClusterSecret = true
        break
      case '--op-path':
        options.opPath = readValue()
        break
      case '--output':
        options.outputPath = resolve(readValue())
        break
      case '--controller-name':
        options.controllerName = readValue()
        break
      case '--controller-namespace':
        options.controllerNamespace = readValue()
        break
      default:
        if (flag.startsWith('-')) {
          fatal(`Unknown flag '${flag}'. Use --help for usage.`)
        }
        if (positionalOutputPath) {
          fatal(`Unexpected argument '${flag}'. Pass at most one output path.`)
        }
        positionalOutputPath = flag
    }
  }

  if (positionalOutputPath) {
    if (options.outputPath !== defaultOutputPath) {
      fatal('Pass either a positional output path or --output, not both.')
    }
    options.outputPath = resolve(positionalOutputPath)
  }

  return options
}

const readSecretFromOnePassword = async (path: string): Promise<string> => {
  ensureCli('op')
  try {
    const result = await $`op read ${path}`.text()
    return result.replace(/\r?\n/g, '')
  } catch (error) {
    fatal(
      `Failed to read secret from 1Password path: ${path}. Sign in with 'op signin' or use --from-cluster-secret / --api-key.`,
      error,
    )
  }
}

const readSecretFromCluster = async (): Promise<string> => {
  ensureCli('kubectl')

  const command = [
    'kubectl get secret',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '-o',
    quote(`jsonpath={.data.${secretKey}}`),
  ].join(' ')

  let encoded = ''
  try {
    encoded = (await $`bash -lc ${command}`.text()).trim()
  } catch (error) {
    fatal(`Failed to read live cluster secret ${secretNamespace}/${secretName}`, error)
  }

  if (!encoded) {
    fatal(`Live cluster secret ${secretNamespace}/${secretName} is missing data key '${secretKey}'`)
  }

  try {
    return Buffer.from(encoded, 'base64').toString('utf8').replace(/\r?\n/g, '')
  } catch (error) {
    fatal(`Failed to decode live cluster secret ${secretNamespace}/${secretName}`, error)
  }
}

const buildSecretManifest = async (apiKeyFilePath: string): Promise<string> => {
  ensureCli('kubectl')

  const command = [
    'kubectl create secret generic',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '--from-file',
    quote(`${secretKey}=${apiKeyFilePath}`),
    '--dry-run=client -o yaml',
  ].join(' ')

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to generate Kubernetes Secret manifest with kubectl', error)
  }
}

const sealManifest = async (manifestPath: string, options: CliOptions): Promise<string> => {
  ensureCli('kubeseal')

  const baseCommand = [
    'kubeseal',
    '--name',
    quote(secretName),
    '--namespace',
    quote(secretNamespace),
    '--controller-name',
    quote(options.controllerName),
    '--controller-namespace',
    quote(options.controllerNamespace),
    '--format',
    'yaml',
  ].join(' ')

  const command = `${baseCommand} < ${quote(manifestPath)}`

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  }
}

const main = async () => {
  const options = parseArgs()

  const apiKey =
    options.apiKey ??
    (options.useClusterSecret ? await readSecretFromCluster() : await readSecretFromOnePassword(options.opPath))

  if (!apiKey) {
    fatal('Linear API key is empty.')
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'symphony-linear-api-key-'))
  const apiKeyFilePath = join(tempDir, 'linear-api-key.txt')
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(apiKeyFilePath, apiKey, { mode: 0o600 })
    const manifest = await buildSecretManifest(apiKeyFilePath)
    writeFileSync(manifestPath, manifest, { mode: 0o600 })

    const sealedSecret = await sealManifest(manifestPath, options)
    if (!sealedSecret.includes(`${secretKey}:`)) {
      fatal(`kubeseal output missing expected encrypted field '${secretKey}'`)
    }

    mkdirSync(dirname(options.outputPath), { recursive: true })
    writeFileSync(options.outputPath, sealedSecret, { mode: 0o600 })
    chmodSync(options.outputPath, 0o600)

    const source = options.apiKey
      ? 'explicit --api-key'
      : options.useClusterSecret
        ? 'live cluster secret'
        : options.opPath
    console.log(`SealedSecret written to ${options.outputPath}.`)
    console.log(`Source: ${source}`)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => fatal('Failed to generate Symphony Linear API key SealedSecret', error))
