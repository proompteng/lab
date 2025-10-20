/* eslint-disable no-console */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

interface ArchiveDescriptor {
  url: string
  sha256: string | null
  format: 'tar.gz' | 'tar.zst'
  stripComponents?: number
}

interface ManifestFile {
  name: string
  sha256: string | null
}

interface TargetDescriptor {
  archive: ArchiveDescriptor
  outputDir: string
  files: ManifestFile[]
}

interface Manifest {
  version: string
  publishedAt: string
  artifacts: Record<string, TargetDescriptor>
}

interface Options {
  checkOnly: boolean
  targets: string[] | null
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const manifestPath = join(packageRoot, 'native', 'temporal-bun-bridge-zig', 'core-artifacts.manifest.json')

const TEMP_ARCHIVE_DIR = 'temporal-core-archives'
const BASE_URL_ENV = 'TEMPORAL_CORE_FETCH_BASE_URL'
const CACHE_DIR_ENV = 'TEMPORAL_CORE_FETCH_CACHE_DIR'

class FetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'FetchError'
  }
}

const readManifest = async (): Promise<Manifest> => {
  const contents = await readFile(manifestPath, 'utf8')
  return JSON.parse(contents) as Manifest
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = { checkOnly: false, targets: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') {
      options.checkOnly = true
      continue
    }
    if (arg === '--target') {
      const value = argv[++i]
      if (!value) {
        throw new Error('--target requires an argument')
      }
      options.targets ??= []
      options.targets.push(value)
      continue
    }
    if (arg === '--targets') {
      const value = argv[++i]
      if (!value) {
        throw new Error('--targets requires an argument')
      }
      options.targets ??= []
      const split = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      options.targets.push(...split)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

const selectTargets = (manifest: Manifest, requested: string[] | null): string[] => {
  const available = Object.keys(manifest.artifacts)
  if (!requested || requested.length === 0) {
    return available
  }
  const missing = requested.filter((target) => !available.includes(target))
  if (missing.length > 0) {
    throw new Error(`Unknown target(s): ${missing.join(', ')}`)
  }
  return requested
}

const ensureDir = async (path: string) => {
  await mkdir(path, { recursive: true })
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const computeSha256 = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  await pipeline(stream, hash)
  return hash.digest('hex')
}

const runCommand = async (command: string, args: string[], cwd?: string) => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    })
    proc.on('error', (error) => {
      rejectPromise(error)
    })
    proc.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`Command ${command} ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}

const extractArchive = async (archivePath: string, descriptor: ArchiveDescriptor, destination: string) => {
  const stripComponents = descriptor.stripComponents ?? 0
  const tarArgs = ['-xf', archivePath, '-C', destination]
  if (stripComponents > 0) {
    tarArgs.push(`--strip-components=${stripComponents}`)
  }
  if (descriptor.format === 'tar.gz') {
    tarArgs.splice(1, 0, '-z')
    await runCommand('tar', tarArgs)
    return
  }
  if (descriptor.format === 'tar.zst') {
    try {
      await runCommand('tar', ['--use-compress-program=unzstd', ...tarArgs])
      return
    } catch (_error) {
      console.warn('tar --use-compress-program=unzstd failed; falling back to manual zstd extraction')
      const extractedTar = `${archivePath}.tar`
      try {
        await runCommand('zstd', ['-d', '--force', `--output=${extractedTar}`, archivePath])
        await runCommand('tar', ['-xf', extractedTar, '-C', destination, ...tarArgs.slice(3)])
      } finally {
        await rm(extractedTar, { force: true })
      }
    }
    return
  }
  throw new Error(`Unsupported archive format: ${descriptor.format}`)
}

const resolveUrl = (descriptor: ArchiveDescriptor): string => {
  const overrideBase = process.env[BASE_URL_ENV]
  if (!overrideBase) {
    return descriptor.url
  }
  try {
    const resolved = new URL(descriptor.url)
    const override = new URL(overrideBase)
    resolved.protocol = override.protocol
    resolved.host = override.host
    resolved.port = override.port
    if (override.pathname && override.pathname !== '/') {
      const normalized = override.pathname.endsWith('/') ? override.pathname.slice(0, -1) : override.pathname
      resolved.pathname = `${normalized}${resolved.pathname}`
    }
    return resolved.toString()
  } catch (error) {
    throw new FetchError(`Failed to resolve override for ${descriptor.url}`, error instanceof Error ? error : undefined)
  }
}

const downloadArchive = async (descriptor: ArchiveDescriptor, target: string): Promise<string> => {
  const archiveUrl = resolveUrl(descriptor)
  const baseCache = process.env[CACHE_DIR_ENV]
  const cacheRoot = baseCache ? resolve(baseCache) : await mkdtemp(join(tmpdir(), TEMP_ARCHIVE_DIR))

  await ensureDir(cacheRoot)
  const parsed = new URL(archiveUrl)
  const filename = parsed.pathname.split('/').filter(Boolean).pop()
  if (!filename) {
    throw new FetchError(`Unable to derive filename from ${archiveUrl}`)
  }
  const archivePath = join(cacheRoot, filename)

  if (await fileExists(archivePath)) {
    console.log(`Using cached archive for ${target}: ${archivePath}`)
    return archivePath
  }

  console.log(`Downloading Temporal core archive for ${target} from ${archiveUrl}`)
  const response = await fetch(archiveUrl)
  if (!response.ok || !response.body) {
    throw new FetchError(`Failed to download ${archiveUrl}: HTTP ${response.status} ${response.statusText}`)
  }

  await ensureDir(dirname(archivePath))
  try {
    await pipeline(response.body, createWriteStream(archivePath))
  } catch (error) {
    await rm(archivePath, { force: true })
    throw new FetchError(`Failed to write archive for ${target}`, error instanceof Error ? error : undefined)
  }

  return archivePath
}

const validateFile = async (filePath: string, expectedSha: string | null): Promise<boolean> => {
  if (!(await fileExists(filePath))) {
    return false
  }
  if (!expectedSha) {
    return true
  }
  const actual = await computeSha256(filePath)
  return actual === expectedSha
}

const validateTarget = async (
  _target: string,
  descriptor: TargetDescriptor,
): Promise<{ valid: boolean; missing: string[]; mismatched: string[] }> => {
  const outputDir = join(packageRoot, descriptor.outputDir)
  const missing: string[] = []
  const mismatched: string[] = []
  for (const file of descriptor.files) {
    const filePath = join(outputDir, file.name)
    if (!(await fileExists(filePath))) {
      missing.push(file.name)
      continue
    }
    if (file.sha256) {
      const matches = await validateFile(filePath, file.sha256)
      if (!matches) {
        mismatched.push(file.name)
      }
    }
  }
  return { valid: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

const stageTarget = async (_target: string, descriptor: TargetDescriptor, archivePath: string): Promise<void> => {
  const outputDir = join(packageRoot, descriptor.outputDir)
  await ensureDir(outputDir)
  await extractArchive(archivePath, descriptor.archive, outputDir)
}

const summarizeFailure = (target: string, detail: { missing: string[]; mismatched: string[] }): string => {
  const segments: string[] = []
  if (detail.missing.length > 0) {
    segments.push(`missing [${detail.missing.join(', ')}]`)
  }
  if (detail.mismatched.length > 0) {
    segments.push(`checksum mismatch [${detail.mismatched.join(', ')}]`)
  }
  return `${target}: ${segments.join('; ')}`
}

const verifyArchiveChecksum = async (archivePath: string, expected: string | null) => {
  if (!expected) {
    return
  }
  const actual = await computeSha256(archivePath)
  if (actual !== expected) {
    throw new Error(`Archive checksum mismatch: expected ${expected} but received ${actual}`)
  }
}

const main = async () => {
  try {
    const manifest = await readManifest()
    const options = parseArgs(process.argv.slice(2))
    const targets = selectTargets(manifest, options.targets)

    const failures: string[] = []
    for (const target of targets) {
      const descriptor = manifest.artifacts[target]
      if (!descriptor) {
        continue
      }

      const status = await validateTarget(target, descriptor)
      if (status.valid) {
        if (!options.checkOnly) {
          console.log(`✔ Temporal core archives already present for ${target}`)
        }
        continue
      }

      if (options.checkOnly) {
        failures.push(summarizeFailure(target, status))
        continue
      }

      console.log(
        `Preparing Temporal core artifacts for ${target} (missing: ${status.missing.join(', ') || 'none'}, mismatched: ${
          status.mismatched.join(', ') || 'none'
        })`,
      )

      try {
        const archivePath = await downloadArchive(descriptor.archive, target)
        await verifyArchiveChecksum(archivePath, descriptor.archive.sha256)
        await stageTarget(target, descriptor, archivePath)
        const postStatus = await validateTarget(target, descriptor)
        if (!postStatus.valid) {
          failures.push(summarizeFailure(target, postStatus))
        } else {
          console.log(`✔ Temporal core artifacts staged for ${target}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error while fetching archive'
        console.warn(`⚠ Failed to fetch Temporal core artifacts for ${target}: ${message}`)
        failures.push(`${target}: fetch failed (${message}). The Zig build will fall back to cargo compilation.`)
      }
    }

    if (options.checkOnly) {
      if (failures.length > 0) {
        console.error(`Temporal core cache check failed:\n - ${failures.join('\n - ')}`)
        process.exitCode = 1
      } else {
        console.log('Temporal core cache verified.')
      }
      return
    }

    if (failures.length > 0) {
      console.warn(
        `Temporal core cache populated with warnings:\n - ${failures.join('\n - ')}\nThe Zig build will trigger Cargo fallback for unresolved targets.`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`Temporal core fetch failed: ${message}`)
    process.exitCode = 1
  }
}

await main()
