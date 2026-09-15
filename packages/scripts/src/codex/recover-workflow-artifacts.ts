#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

import type { Subprocess } from 'bun'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

type Options = {
  workflow: string
  namespace: string
  bucket?: string
  alias: string
  destination: string
  applyChanges: boolean
  portForward: boolean
  minioNamespace: string
  minioService: string
  minioPort: number
  localPort: number
}

type WorkflowJson = {
  spec?: unknown
  status?: {
    nodes?: Record<
      string,
      {
        outputs?: {
          artifacts?: ArtifactJson[]
        }
      }
    >
  }
}

type ArtifactJson = {
  name?: string
  path?: string
  s3?: {
    bucket?: string
    key?: string
  }
}

type ParsedArtifact = {
  name: string
  key: string
}

type WorkflowTemplate = {
  outputs?: {
    artifacts?: Array<{
      s3?: { bucket?: string }
    }>
  }
}

type PortForwardHandle = {
  stop: () => void
}

const PORT_FORWARD_TIMEOUT_MS = 15_000

const textDecoder = new TextDecoder()

const parseArgs = (): Options => {
  const args = process.argv.slice(2)
  const options: Partial<Options> = {
    namespace: 'argo-workflows',
    alias: process.env.MINIO_ALIAS?.trim()?.length ? process.env.MINIO_ALIAS.trim() : 'argo',
    applyChanges: true,
    portForward: true,
    minioNamespace: 'minio',
    minioService: 'observability-minio',
    minioPort: 9000,
    localPort: 9000,
  }

  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    switch (arg) {
      case '--namespace':
      case '-n': {
        index += 1
        const value = args[index]
        if (!value) fatal(`${arg} requires a value`)
        options.namespace = value
        break
      }
      case '--bucket': {
        index += 1
        const value = args[index]
        if (!value) fatal('--bucket requires a value')
        options.bucket = value
        break
      }
      case '--alias': {
        index += 1
        const value = args[index]
        if (!value) fatal('--alias requires a value')
        options.alias = value
        break
      }
      case '--dest':
      case '--destination': {
        index += 1
        const value = args[index]
        if (!value) fatal(`${arg} requires a value`)
        options.destination = value
        break
      }
      case '--minio-namespace': {
        index += 1
        const value = args[index]
        if (!value) fatal('--minio-namespace requires a value')
        options.minioNamespace = value
        break
      }
      case '--minio-service': {
        index += 1
        const value = args[index]
        if (!value) fatal('--minio-service requires a value')
        options.minioService = value
        break
      }
      case '--minio-port': {
        index += 1
        const value = args[index]
        if (!value) fatal('--minio-port requires a value')
        const parsed = Number.parseInt(value, 10)
        if (Number.isNaN(parsed) || parsed <= 0) fatal('--minio-port must be a positive integer')
        options.minioPort = parsed
        break
      }
      case '--local-port': {
        index += 1
        const value = args[index]
        if (!value) fatal('--local-port requires a value')
        const parsed = Number.parseInt(value, 10)
        if (Number.isNaN(parsed) || parsed <= 0) fatal('--local-port must be a positive integer')
        options.localPort = parsed
        break
      }
      case '--no-apply': {
        options.applyChanges = false
        break
      }
      case '--no-port-forward': {
        options.portForward = false
        break
      }
      case '--help':
      case '-h': {
        printHelp()
        process.exit(0)
        break
      }
      default:
        fatal(`Unknown option: ${arg}`)
    }
  }

  if (positional.length === 0) {
    fatal('Usage: recover-workflow-artifacts <workflow> [options]. Use --help for details.')
  }

  if (positional.length > 1) {
    fatal('Only one workflow name may be specified')
  }

  const workflow = positional[0]
  const destination = options.destination
    ? resolve(process.cwd(), options.destination)
    : resolve(repoRoot, '.codex', 'recovery', workflow)

  return {
    workflow,
    namespace: options.namespace ?? 'argo-workflows',
    bucket: options.bucket,
    alias: options.alias ?? 'argo',
    destination,
    applyChanges: options.applyChanges ?? true,
    portForward: options.portForward ?? true,
    minioNamespace: options.minioNamespace ?? 'minio',
    minioService: options.minioService ?? 'observability-minio',
    minioPort: options.minioPort ?? 9000,
    localPort: options.localPort ?? 9000,
  }
}

const printHelp = () => {
  console.log(`Usage: recover-workflow-artifacts <workflow> [options]

Download Codex workflow artifacts from MinIO and restore the recorded changes locally.

Options:
  -n, --namespace <value>    Kubernetes namespace for the workflow (default: argo-workflows)
      --bucket <value>       MinIO bucket name (auto-detected when possible)
      --alias <value>        MinIO client alias to use with mc (default: $MINIO_ALIAS or 'argo')
      --dest <path>          Directory to store downloaded artifacts
      --minio-namespace      Namespace containing the MinIO service (default: minio)
      --minio-service        Service name to port-forward (default: observability-minio)
      --minio-port           Target port on the MinIO service (default: 9000)
      --local-port           Local port to bind for the port-forward (default: 9000)
      --no-apply             Skip applying the captured changes to the current worktree
      --no-port-forward      Skip establishing a kubectl port-forward
  -h, --help                 Show this help message
`)
}

const execJson = (command: string, args: string[]): unknown => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const stderr = textDecoder.decode(result.stderr)
    fatal(`Command failed: ${command} ${args.join(' ')}\n${stderr.trim()}`)
  }
  try {
    return JSON.parse(textDecoder.decode(result.stdout))
  } catch (error) {
    fatal(`Failed to parse JSON from ${command} ${args.join(' ')}`, error)
  }
}

const collectArtifacts = (workflowJson: WorkflowJson): ParsedArtifact[] => {
  const nodes = workflowJson.status?.nodes ?? {}
  const artifacts: ParsedArtifact[] = []

  for (const node of Object.values(nodes)) {
    for (const artifact of node?.outputs?.artifacts ?? []) {
      if (!artifact?.name || !artifact?.s3?.key) {
        continue
      }

      // Deduplicate by artifact name (latest entry wins).
      const existingIndex = artifacts.findIndex((entry) => entry.name === artifact.name)
      const parsed: ParsedArtifact = {
        name: artifact.name,
        key: artifact.s3.key,
      }
      if (existingIndex >= 0) {
        artifacts[existingIndex] = parsed
      } else {
        artifacts.push(parsed)
      }
    }
  }

  return artifacts
}

const detectBucket = (workflowJson: WorkflowJson): string | undefined => {
  const nodes = workflowJson.status?.nodes ?? {}
  for (const node of Object.values(nodes)) {
    for (const artifact of node?.outputs?.artifacts ?? []) {
      const bucket = artifact?.s3?.bucket?.trim()
      if (bucket) return bucket
    }
  }

  const specTemplates = (workflowJson as { spec?: { templates?: WorkflowTemplate[] } }).spec?.templates
  const templates = Array.isArray(specTemplates) ? specTemplates : []

  for (const template of templates) {
    for (const artifact of template?.outputs?.artifacts ?? []) {
      const bucket = artifact?.s3?.bucket?.trim()
      if (bucket) return bucket
    }
  }

  // Attempt to read archiveLocation fallback.
  const archiveLocation = (workflowJson as { spec?: { archiveLocation?: { s3?: { bucket?: string } } } }).spec
    ?.archiveLocation?.s3?.bucket
  if (archiveLocation && archiveLocation.trim().length > 0) {
    return archiveLocation.trim()
  }

  return undefined
}

const ensureDestination = async (path: string) => {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true })
  }
}

const downloadArtifact = async ({
  alias,
  bucket,
  artifact,
  destination,
}: {
  alias: string
  bucket: string
  artifact: ParsedArtifact
  destination: string
}) => {
  const filename = basename(artifact.key)
  const target = join(destination, filename)

  await run('mc', ['cp', `${alias}/${bucket}/${artifact.key}`, target])
  return target
}

const extractArchive = async (archive: string, directory: string) => {
  await run('tar', ['-xzf', archive, '-C', directory])
}

const recoverChanges = async ({ artifactsDir }: { artifactsDir: string }) => {
  const changesArchive = join(artifactsDir, '.codex-implementation-changes.tar.gz')
  if (existsSync(changesArchive)) {
    console.log('Extracting recorded filesystem changes into the repository...')
    await run('tar', ['-xzf', changesArchive, '-C', repoRoot])
  } else {
    console.warn('Changes archive not found; skipping filesystem extraction.')
  }

  const patchPath = join(artifactsDir, '.codex-implementation.patch')
  if (existsSync(patchPath)) {
    console.log('Applying git patch...')
    await run('git', ['apply', '--3way', '--whitespace=nowarn', patchPath], { cwd: repoRoot })
  } else {
    console.warn('Patch file not found; skipping git apply.')
  }
}

const showStatus = async ({ artifactsDir }: { artifactsDir: string }) => {
  const statusPath = join(artifactsDir, '.codex-implementation-status.txt')
  if (!existsSync(statusPath)) {
    console.warn('Status file not found; skipping status output.')
    return
  }

  const content = await Bun.file(statusPath).text()
  console.log('\n=== Codex Implementation Status ===')
  console.log(content.trim())
  console.log('=== End Status ===\n')
}

const waitForPortForwardReady = async (subprocess: Subprocess, options: Options) => {
  const decoder = new TextDecoder()
  let resolved = false

  const createReadPromise = (stream: ReadableStream<Uint8Array> | number | null | undefined) => {
    if (!stream || typeof stream === 'number') return null
    const reader = stream.getReader()

    const read = (async () => {
      let buffer = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (resolved) return

          const chunk = decoder.decode(value)
          buffer += chunk
          buffer = buffer.length > 4096 ? buffer.slice(-4096) : buffer
          process.stderr.write(chunk)

          if (chunk.includes('address already in use')) {
            throw new Error(`Local port ${options.localPort} is already in use`)
          }

          if (buffer.includes('Forwarding from')) {
            resolved = true
            return
          }

          if (!resolved && chunk.toLowerCase().includes('error')) {
            throw new Error(`kubectl port-forward error: ${chunk.trim()}`)
          }
        }

        if (!resolved) {
          throw new Error('kubectl port-forward closed before reporting readiness')
        }
      } finally {
        reader.releaseLock()
      }
    })()

    return read
  }

  const readPromises = [createReadPromise(subprocess.stdout), createReadPromise(subprocess.stderr)].filter(
    (value): value is Promise<void> => value !== null,
  )

  if (readPromises.length === 0) {
    throw new Error('kubectl port-forward did not expose readable streams')
  }

  const exitPromise = subprocess.exited.then((code) => {
    if (!resolved) {
      throw new Error(`kubectl port-forward exited early with code ${code}`)
    }
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!resolved) {
        reject(new Error('Timed out waiting for kubectl port-forward to become ready'))
      }
    }, PORT_FORWARD_TIMEOUT_MS)
  })

  try {
    await Promise.race([...readPromises, exitPromise, timeoutPromise])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

const startPortForward = async (options: Options): Promise<PortForwardHandle> => {
  console.log(
    `Establishing kubectl port-forward for ${options.minioNamespace}/svc/${options.minioService} -> 127.0.0.1:${options.localPort}...`,
  )

  const args = [
    '-n',
    options.minioNamespace,
    'port-forward',
    `svc/${options.minioService}`,
    `${options.localPort}:${options.minioPort}`,
    '--address',
    '127.0.0.1',
  ]

  const subprocess = Bun.spawn(['kubectl', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    await waitForPortForwardReady(subprocess, options)
  } catch (error) {
    subprocess.kill()
    throw error
  }

  return {
    stop: () => {
      if (subprocess.exitCode === null) {
        subprocess.kill()
      }
    },
  }
}

export const main = async () => {
  const options = parseArgs()

  ensureCli('argo')
  ensureCli('mc')
  ensureCli('tar')
  ensureCli('git')
  if (options.portForward) {
    ensureCli('kubectl')
  }

  let portForwardHandle: PortForwardHandle | undefined

  const workflowJson = execJson('argo', [
    'get',
    options.workflow,
    '--namespace',
    options.namespace,
    '-o',
    'json',
  ]) as WorkflowJson

  const bucket = options.bucket ?? detectBucket(workflowJson) ?? 'argo-workflows'
  if (!bucket) {
    fatal('Unable to determine artifact bucket. Provide one with --bucket <name>.')
  }

  const artifacts = collectArtifacts(workflowJson)
  if (artifacts.length === 0) {
    fatal('No artifacts with S3 keys found on this workflow.')
  }

  await ensureDestination(options.destination)

  try {
    if (options.portForward) {
      portForwardHandle = await startPortForward(options)
    } else {
      console.log('Skipping port-forward (--no-port-forward supplied).')
    }

    console.log(`Downloading artifacts for workflow '${options.workflow}' into ${options.destination}...`)
    const downloadedPaths: string[] = []
    for (const artifact of artifacts) {
      const archivePath = await downloadArtifact({
        alias: options.alias,
        bucket,
        artifact,
        destination: options.destination,
      })

      if (archivePath.endsWith('.tgz')) {
        await extractArchive(archivePath, options.destination)
      } else {
        downloadedPaths.push(archivePath)
      }
    }

    if (options.applyChanges) {
      await recoverChanges({ artifactsDir: options.destination })
    } else {
      console.log('Skipping worktree modification (--no-apply supplied).')
    }

    await showStatus({ artifactsDir: options.destination })

    console.log('Recovery artifacts ready. Inspect main.log for workflow output if needed.')
    for (const path of downloadedPaths) {
      console.log(` - ${path}`)
    }
  } finally {
    portForwardHandle?.stop()
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to recover artifacts', error))
}
