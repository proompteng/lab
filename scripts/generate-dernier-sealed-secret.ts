#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { $ } from 'bun'

type CliOptions = {
  outputPath: string
  controllerName: string
  controllerNamespace: string
  railsMasterKey?: string
  secretKeyBase?: string
  printValues: boolean
}

const defaultOutput = resolve(
  dirname(import.meta.dir),
  '..',
  'argocd/applications/dernier/overlays/cluster/sealed-secret.yaml',
)

const fatal = (message: string, error?: unknown): never => {
  if (error instanceof Error) {
    console.error(`${message}\n${error.message}`)
  } else if (error) {
    console.error(`${message}\n${String(error)}`)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available on PATH`)
  }
}

const generateHex = (bytes: number) => randomBytes(bytes).toString('hex')

const printUsage = (): never => {
  console.log(`Usage: scripts/generate-dernier-sealed-secret.ts [options]

Options:
  --output <path>             Override output manifest path.
  --controller-name <name>    Sealed Secrets controller name (default: sealed-secrets).
  --controller-namespace <ns> Sealed Secrets controller namespace (default: sealed-secrets).
  --rails-master-key <value>  Provide explicit RAILS_MASTER_KEY instead of generating one.
  --secret-key-base <value>   Provide explicit SECRET_KEY_BASE instead of generating one.
  --print-values              Echo generated credential values (handle carefully).
  -h, --help                  Show this help message.

Environment overrides:
  SEALED_SECRETS_CONTROLLER_NAME
  SEALED_SECRETS_CONTROLLER_NAMESPACE
  DERNIER_SEALED_SECRET_OUTPUT
`)
  process.exit(0)
}

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2)
  const options: CliOptions = {
    outputPath: resolve(process.env.DERNIER_SEALED_SECRET_OUTPUT ?? defaultOutput),
    controllerName: process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets',
    controllerNamespace: process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets',
    printValues: false,
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      printUsage()
    }

    const [flag, inline] = arg.includes('=') ? arg.split('=') : [arg, undefined]
    const nextValue = () => {
      if (inline !== undefined) return inline
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        fatal(`Flag '${flag}' requires a value`)
      }
      i += 1
      return value
    }

    switch (flag) {
      case '--output':
        options.outputPath = resolve(nextValue())
        break
      case '--controller-name':
        options.controllerName = nextValue()
        break
      case '--controller-namespace':
        options.controllerNamespace = nextValue()
        break
      case '--rails-master-key':
        options.railsMasterKey = nextValue()
        break
      case '--secret-key-base':
        options.secretKeyBase = nextValue()
        break
      case '--print-values':
        options.printValues = true
        break
      default:
        if (flag.startsWith('-')) {
          fatal(`Unknown flag '${flag}'. Use --help for usage.`)
        } else {
          fatal(`Unexpected argument '${flag}'. Use --help for usage.`)
        }
    }
  }

  return options
}

const main = async () => {
  ensureCli('kubectl')
  ensureCli('kubeseal')

  const options = parseArgs()

  const namespace = 'dernier'
  const secretName = 'dernier-secrets'

  const railsMasterKey = options.railsMasterKey ?? generateHex(16)
  const secretKeyBase = options.secretKeyBase ?? generateHex(64)

  if (options.printValues) {
    console.log(`RAILS_MASTER_KEY=${railsMasterKey}`)
    console.log(`SECRET_KEY_BASE=${secretKeyBase}`)
  }

  mkdirSync(dirname(options.outputPath), { recursive: true })

  const secretManifest = await $`kubectl create secret generic ${secretName} \
    --namespace ${namespace} \
    --dry-run=client \
    -o yaml \
    --from-literal=RAILS_MASTER_KEY=${railsMasterKey} \
    --from-literal=SECRET_KEY_BASE=${secretKeyBase}`.text()

  const sealedSecret = await $`kubeseal \
    --controller-name=${options.controllerName} \
    --controller-namespace=${options.controllerNamespace} \
    --format=yaml`
    .stdin(secretManifest)
    .text()

  await Bun.write(options.outputPath, sealedSecret)
  console.error(`Sealed secret written to ${options.outputPath}`)
}

main().catch((error) => fatal('Failed to generate sealed secret', error))
