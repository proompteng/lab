#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'

import { ensureCli, fatal, repoRoot } from './cli'

export type OciPlatformDigest = {
  platform: string
  digest: string
}

export type OciArchTag = {
  platform: string
  tag: string
}

export type CreateOciIndexOptions = {
  image: string
  tag: string
  archTags: OciArchTag[]
  latest?: boolean
}

export type CreateOciIndexResult = {
  image: string
  tag: string
  reference: string
  digest: string
  platformDigests: OciPlatformDigest[]
}

type SpawnSync = typeof Bun.spawnSync

let spawnSyncImpl: SpawnSync = Bun.spawnSync

const readProcessOutput = (value: unknown): string => {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString()
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

const runRequired = (command: string, args: string[]): string => {
  ensureCli(command)
  const result = spawnSyncImpl([command, ...args], { cwd: repoRoot })
  const stdout = readProcessOutput(result.stdout).trim()
  const stderr = readProcessOutput(result.stderr).trim()

  if (result.exitCode !== 0) {
    const output = [stdout, stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`)
  }

  return stdout
}

const runOptional = (command: string, args: string[]): string | undefined => {
  if (!Bun.which(command)) {
    return undefined
  }

  const result = spawnSyncImpl([command, ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    return undefined
  }

  const stdout = readProcessOutput(result.stdout).trim()
  return stdout.length > 0 ? stdout : undefined
}

const imageReference = (image: string, tag: string): string => `${image}:${tag}`

const stripTagOrDigest = (reference: string): string => {
  const digestIndex = reference.indexOf('@')
  const withoutDigest = digestIndex >= 0 ? reference.slice(0, digestIndex) : reference
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')

  if (lastColon > lastSlash) {
    return withoutDigest.slice(0, lastColon)
  }

  return withoutDigest
}

const isFullReference = (value: string): boolean => {
  if (value.includes('@')) {
    return true
  }

  const lastSlash = value.lastIndexOf('/')
  const lastColon = value.lastIndexOf(':')
  return lastSlash >= 0 && lastColon > lastSlash
}

const resolveArchReference = (image: string, archTag: OciArchTag): string => {
  if (isFullReference(archTag.tag)) {
    return archTag.tag
  }

  return imageReference(image, archTag.tag)
}

const resolveDigestReference = (reference: string): string => {
  if (reference.includes('@sha256:')) {
    return reference
  }

  const digest = runRequired('crane', ['digest', reference])
  return `${stripTagOrDigest(reference)}@${digest}`
}

const formatPlatform = (platform: { os?: string; architecture?: string; variant?: string } | undefined): string => {
  if (!platform?.os || !platform.architecture) {
    return ''
  }
  if (platform.os === 'unknown' || platform.architecture === 'unknown') {
    return ''
  }
  if (platform.variant) {
    return `${platform.os}/${platform.architecture}/${platform.variant}`
  }
  return `${platform.os}/${platform.architecture}`
}

const parseManifestPlatforms = (manifestBody: string): OciPlatformDigest[] => {
  const parsed = JSON.parse(manifestBody) as {
    manifests?: Array<{
      digest?: string
      platform?: { os?: string; architecture?: string; variant?: string }
    }>
  }

  return (
    parsed.manifests
      ?.map((entry) => {
        const platform = formatPlatform(entry.platform)
        const digest = entry.digest?.trim()
        if (!platform || !digest) {
          return undefined
        }
        return { platform, digest }
      })
      .filter((entry): entry is OciPlatformDigest => Boolean(entry)) ?? []
  )
}

export const inspectOciPlatforms = (imageRef: string): OciPlatformDigest[] => {
  const manifestBody =
    runOptional('crane', ['manifest', imageRef]) ??
    runRequired('regctl', ['manifest', 'get', imageRef, '--format', 'raw-body'])

  return parseManifestPlatforms(manifestBody)
}

export const assertOciPlatforms = (imageRef: string, requiredPlatforms: string[]): OciPlatformDigest[] => {
  const observedPlatforms = inspectOciPlatforms(imageRef)
  const observed = new Set(observedPlatforms.map((entry) => entry.platform))
  const missing = requiredPlatforms
    .map((platform) => platform.trim())
    .filter(Boolean)
    .filter((platform) => !observed.has(platform))

  if (missing.length > 0) {
    const observedText = [...observed].sort().join(', ') || 'none'
    throw new Error(
      `Image ${imageRef} is missing required platform(s): ${missing.join(', ')}; observed: ${observedText}`,
    )
  }

  return observedPlatforms
}

export const createOciIndex = (options: CreateOciIndexOptions): CreateOciIndexResult => {
  if (options.archTags.length === 0) {
    throw new Error('createOciIndex requires at least one architecture tag')
  }

  const reference = imageReference(options.image, options.tag)
  const args = ['index', 'append']

  for (const archTag of options.archTags) {
    const archReference = resolveArchReference(options.image, archTag)
    args.push('-m', resolveDigestReference(archReference))
  }

  args.push('-t', reference)
  runRequired('crane', args)

  if (options.latest) {
    runRequired('crane', ['tag', reference, 'latest'])
  }

  const digest = runRequired('crane', ['digest', reference])
  const platformDigests = inspectOciPlatforms(reference)

  return {
    image: options.image,
    tag: options.tag,
    reference: `${options.image}@${digest}`,
    digest,
    platformDigests,
  }
}

const writeGithubOutput = (result: CreateOciIndexResult): void => {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  const lines = [
    `image=${result.image}`,
    `tag=${result.tag}`,
    `digest=${result.digest}`,
    `reference=${result.reference}`,
    ...result.platformDigests.map((entry) => {
      const suffix = entry.platform.replace(/^linux\//, '').replaceAll('/', '_')
      return `platform_digest_${suffix}=${entry.digest}`
    }),
  ]

  appendFileSync(outputPath, `${lines.join('\n')}\n`)
}

const printPlatforms = (platforms: OciPlatformDigest[]): void => {
  for (const entry of platforms) {
    console.log(`${entry.platform}\t${entry.digest}`)
  }
}

const takeValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

const parseArchTag = (value: string): OciArchTag => {
  const equalsIndex = value.indexOf('=')
  if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
    throw new Error(`--arch-tag must use platform=tag, got ${value}`)
  }

  return {
    platform: value.slice(0, equalsIndex),
    tag: value.slice(equalsIndex + 1),
  }
}

const runCreateIndexCli = (args: string[]): void => {
  let image = ''
  let tag = ''
  let latest = false
  const archTags: OciArchTag[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--image') {
      image = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--tag') {
      tag = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--arch-tag') {
      archTags.push(parseArchTag(takeValue(args, index, arg)))
      index += 1
    } else if (arg === '--latest') {
      latest = true
    } else {
      throw new Error(`Unknown create-index argument: ${arg}`)
    }
  }

  if (!image) {
    throw new Error('create-index requires --image')
  }
  if (!tag) {
    throw new Error('create-index requires --tag')
  }

  const result = createOciIndex({ image, tag, archTags, latest })
  writeGithubOutput(result)
  console.log(JSON.stringify(result, null, 2))
}

const runInspectCli = (args: string[]): void => {
  const [imageRef] = args
  if (!imageRef) {
    throw new Error('inspect requires an image reference')
  }

  printPlatforms(inspectOciPlatforms(imageRef))
}

const runAssertCli = (args: string[]): void => {
  const [imageRef, ...rest] = args
  if (!imageRef) {
    throw new Error('assert requires an image reference')
  }

  const platforms: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--platform') {
      platforms.push(takeValue(rest, index, arg))
      index += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown assert argument: ${arg}`)
    } else {
      platforms.push(arg)
    }
  }

  const requiredPlatforms = platforms.length > 0 ? platforms : ['linux/amd64', 'linux/arm64']
  printPlatforms(assertOciPlatforms(imageRef, requiredPlatforms))
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2)

  try {
    if (command === 'create-index') {
      runCreateIndexCli(args)
    } else if (command === 'inspect') {
      runInspectCli(args)
    } else if (command === 'assert') {
      runAssertCli(args)
    } else {
      throw new Error('Usage: oci.ts <create-index|inspect|assert> [options]')
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error))
  }
}

export const __private = {
  parseManifestPlatforms,
  resolveDigestReference,
  setSpawnSync: (impl: SpawnSync = Bun.spawnSync) => {
    spawnSyncImpl = impl
  },
}
