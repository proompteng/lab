#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { $ } from 'bun'

type CliOptions = {
  repo?: string
  url?: string
  secretName: string
  secretNamespace: string
  sealedName?: string
  sealedNamespace?: string
  output?: string
  keyPath?: string
  title?: string
  comment?: string
  controllerName?: string
  controllerNamespace?: string
  preserveKeys?: boolean
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
const defaultOutputRelative = join('argocd', 'applications', 'argocd', 'base', 'image-updater-git-ssh.yaml')
const defaultOutputPath = resolve(repoRoot, defaultOutputRelative)

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-image-updater-git-secret.ts --repo <owner/repo> [options]

Required:
  --repo <owner/repo>         GitHub repository (OWNER/REPO) to receive the deploy key.

Options:
  --url <ssh-url>             SSH Git URL for the Argo CD repository secret. Defaults to ssh://git@github.com/<repo>.git.
  --secret-name <name>        Kubernetes secret name. Defaults to image-updater-git-ssh.
  --secret-namespace <ns>     Kubernetes secret namespace. Defaults to argocd.
  --sealed-name <name>        SealedSecret metadata.name. Defaults to the secret name.
  --sealed-namespace <ns>     SealedSecret metadata.namespace. Defaults to the secret namespace.
  --output <path>             File path to write the SealedSecret manifest. Defaults to ${defaultOutputRelative}.
  --key-path <path>           Where to write the generated private key (without extension). Defaults to a temp dir.
  --title <title>             Title for the GitHub deploy key. Defaults to "Argo CD Image Updater".
  --comment <comment>         Comment to embed in the generated SSH key. Defaults to repo-specific text.
  --controller-name <name>    Sealed Secrets controller name. Defaults to env SEALED_SECRETS_CONTROLLER_NAME.
  --controller-namespace <ns> Sealed Secrets controller namespace. Defaults to env SEALED_SECRETS_CONTROLLER_NAMESPACE.
  --preserve-keys             Keep the generated key files on disk (default deletes temp files).
  --help                      Show this help message.
`)
  process.exit(0)
}

const parseArgs = (): CliOptions => {
  const options: CliOptions = {
    secretName: 'image-updater-git-ssh',
    secretNamespace: 'argocd',
    controllerName: process.env.SEALED_SECRETS_CONTROLLER_NAME,
    controllerNamespace: process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE,
  }

  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]
    if (!raw) continue

    if (raw === '--help' || raw === '-h') {
      printUsage()
    }

    const hasFlag = raw.startsWith('--')
    const [flag, directValue] = hasFlag ? raw.split('=') : [raw, undefined]

    const next = (): string => {
      if (directValue !== undefined) return directValue
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        fatal(`Flag '${flag}' requires a value`)
      }
      i += 1
      return value
    }

    switch (flag) {
      case '--repo':
        options.repo = next()
        break
      case '--url':
        options.url = next()
        break
      case '--secret-name':
        options.secretName = next()
        break
      case '--secret-namespace':
        options.secretNamespace = next()
        break
      case '--sealed-name':
        options.sealedName = next()
        break
      case '--sealed-namespace':
        options.sealedNamespace = next()
        break
      case '--output':
        options.output = next()
        break
      case '--key-path':
        options.keyPath = resolve(next())
        break
      case '--title':
        options.title = next()
        break
      case '--comment':
        options.comment = next()
        break
      case '--controller-name':
        options.controllerName = next()
        break
      case '--controller-namespace':
        options.controllerNamespace = next()
        break
      case '--preserve-keys':
        options.preserveKeys = true
        break
      default:
        if (hasFlag) {
          fatal(`Unknown flag '${flag}'`)
        } else {
          fatal(`Unexpected argument '${flag}'. Run with --help for usage.`)
        }
    }
  }

  return options
}

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const indentBlock = (value: string, spaces: number) => {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => `${padding}${line}`)
    .join('\n')
}

const readFile = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fatal(`Failed to read file at ${path}`, error)
  }
}

const resolveOutputPath = (output?: string): string | null => {
  if (!output || output === '') {
    return defaultOutputPath
  }
  if (output === '-') {
    return null
  }
  return resolve(output)
}

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

const generateKeyPair = async (keyPath: string | undefined, keyComment: string) => {
  const basePath = (() => {
    if (keyPath) {
      mkdirSync(dirname(keyPath), { recursive: true })
      return keyPath
    }
    const dir = mkdtempSync(join(tmpdir(), 'argocd-image-updater-'))
    return join(dir, 'id_ed25519')
  })()

  const privateKeyPath = basePath
  const publicKeyPath = `${basePath}.pub`

  try {
    const command = `ssh-keygen -t ed25519 -N "" -C '${shellEscape(keyComment)}' -f '${shellEscape(privateKeyPath)}'`
    await $`bash -lc ${command}`
  } catch (error) {
    fatal('Failed to generate SSH key with ssh-keygen', error)
  }

  return { privateKeyPath, publicKeyPath, tempDir: keyPath ? undefined : dirname(privateKeyPath) }
}

const registerDeployKey = async (publicKeyPath: string, repo: string, title: string) => {
  try {
    await $`gh repo deploy-key add ${publicKeyPath} --allow-write --title ${title} --repo ${repo}`
  } catch (error) {
    fatal('Failed to add deploy key to repository with gh', error)
  }
}

const sealSecret = async (
  manifest: string,
  sealedName: string,
  sealedNamespace: string,
  controllerName?: string,
  controllerNamespace?: string,
) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'argocd-image-updater-secret-'))
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(manifestPath, manifest)
  } catch (error) {
    fatal('Failed to write temporary manifest for kubeseal', error)
  }

  const parts = ['kubeseal', '--name', quote(sealedName), '--namespace', quote(sealedNamespace), '--format', 'yaml']

  if (controllerName) {
    parts.push('--controller-name', quote(controllerName))
  }
  if (controllerNamespace) {
    parts.push('--controller-namespace', quote(controllerNamespace))
  }

  const command = `${parts.join(' ')} < ${quote(manifestPath)}`

  try {
    return await $`bash -lc ${command}`.text()
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  } finally {
    try {
      rmSync(manifestPath, { force: true })
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

const cleanupKeys = (privateKeyPath: string, publicKeyPath: string, tempDir?: string) => {
  if (!tempDir) return
  try {
    rmSync(privateKeyPath, { force: true })
    rmSync(publicKeyPath, { force: true })
    rmSync(tempDir, { recursive: true, force: true })
  } catch (error) {
    fatal('Failed to clean up temporary key files', error)
  }
}

async function main() {
  const options = parseArgs()

  if (!options.repo) {
    fatal('Missing required --repo <owner/repo> flag')
  }

  ensureCli('ssh-keygen')
  ensureCli('gh')
  ensureCli('kubeseal')

  const repo = options.repo
  const gitUrl = options.url ?? `ssh://git@github.com/${repo}.git`
  const secretName = options.secretName
  const secretNamespace = options.secretNamespace
  const sealedName = options.sealedName ?? secretName
  const sealedNamespace = options.sealedNamespace ?? secretNamespace
  const deployKeyTitle = options.title ?? 'Argo CD Image Updater'
  const keyComment = options.comment ?? `argocd-image-updater:${repo}`
  const controllerName = options.controllerName
  const controllerNamespace = options.controllerNamespace

  const { privateKeyPath, publicKeyPath, tempDir } = await generateKeyPair(options.keyPath, keyComment)
  await registerDeployKey(publicKeyPath, repo, deployKeyTitle)

  const privateKey = readFile(privateKeyPath).trimEnd()
  const publicKey = readFile(publicKeyPath).trim()

  const secretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${secretNamespace}
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  type: git
  url: ${gitUrl}
  user: git
  sshPrivateKey: |\n${indentBlock(privateKey, 4)}
  sshPublicKey: ${publicKey}\n`

  const renderedSecret = await sealSecret(
    secretManifest,
    sealedName,
    sealedNamespace,
    controllerName,
    controllerNamespace,
  )
  const sealedSecret = renderedSecret.startsWith('---') ? renderedSecret : `---\n${renderedSecret}`

  const resolvedOutput = resolveOutputPath(options.output)

  if (resolvedOutput) {
    try {
      mkdirSync(dirname(resolvedOutput), { recursive: true })
      writeFileSync(resolvedOutput, sealedSecret)
      console.log(`SealedSecret written to ${resolvedOutput}`)
    } catch (error) {
      fatal(`Failed to write SealedSecret manifest to ${resolvedOutput}`, error)
    }
  } else {
    console.log(sealedSecret)
  }

  if (tempDir && !options.preserveKeys) {
    cleanupKeys(privateKeyPath, publicKeyPath, tempDir)
  } else {
    console.log(`Generated private key retained at ${privateKeyPath}`)
    console.log(`Generated public key retained at ${publicKeyPath}`)
  }
}
await main()
