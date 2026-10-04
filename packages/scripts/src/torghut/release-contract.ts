#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'

const defaultContractPath = 'torghut-release-contract.json'

const sourceShaPattern = /^[0-9a-f]{40}$/i
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/i
const requiredPlatforms = ['linux/amd64', 'linux/arm64'] as const

export type TorghutReleaseContract = {
  sourceSha: string
  tag: string
  digest: string
  image: string
  platforms: string[]
  platformDigests: Record<string, string>
  createdAt: string
}

type ContractField = keyof TorghutReleaseContract

type CliOptions = {
  command?: 'write' | 'get' | 'emit-github-output'
  path?: string
  sourceSha?: string
  tag?: string
  digest?: string
  image?: string
  platforms?: string[]
  platformDigests?: Record<string, string>
  field?: ContractField
}

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const parsePlatformList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const normalizePlatformDigests = (value: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([platform, digest]) => [platform.trim(), normalizeDigest(digest)])
      .filter(([platform]) => platform),
  )

const parsePlatformDigest = (value: string): [string, string] => {
  const separatorIndex = value.indexOf('=')
  if (separatorIndex < 0) {
    throw new Error(`Invalid platform digest '${value}'; expected <platform>=<sha256:...>`)
  }

  const platform = value.slice(0, separatorIndex).trim()
  const digest = normalizeDigest(value.slice(separatorIndex + 1))
  if (!platform || !digest) {
    throw new Error(`Invalid platform digest '${value}'; expected <platform>=<sha256:...>`)
  }
  return [platform, digest]
}

const resolveContractPath = (path: string) => resolve(repoRoot, path)

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/release-contract.ts <command> [options]

Commands:
  write
    --path <path>
    --source-sha <sha40>
    --tag <tag>
    --digest <sha256:...>
    --image <registry/repo>
    --platforms <linux/amd64,linux/arm64>
    --platform-digest <platform>=<sha256:...>  May be repeated
  get
    --path <path>
    --field <sourceSha|tag|digest|image|platforms|platformDigests|createdAt>
  emit-github-output
    --path <path>`)
      process.exit(0)
    }

    if (!options.command && (arg === 'write' || arg === 'get' || arg === 'emit-github-output')) {
      options.command = arg
      continue
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--path':
        options.path = value
        break
      case '--source-sha':
        options.sourceSha = value
        break
      case '--tag':
        options.tag = value
        break
      case '--digest':
        options.digest = value
        break
      case '--image':
        options.image = value
        break
      case '--platforms':
        options.platforms = parsePlatformList(value)
        break
      case '--platform-digest':
        options.platformDigests ??= {}
        {
          const [platform, digest] = parsePlatformDigest(value)
          options.platformDigests[platform] = digest
        }
        break
      case '--field':
        if (!['sourceSha', 'tag', 'digest', 'image', 'platforms', 'platformDigests', 'createdAt'].includes(value)) {
          throw new Error(`Unknown field: ${value}`)
        }
        options.field = value as ContractField
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const assertValidContract = (contract: TorghutReleaseContract) => {
  if (!sourceShaPattern.test(contract.sourceSha)) {
    throw new Error(`Invalid sourceSha '${contract.sourceSha}'`)
  }
  if (!tagPattern.test(contract.tag)) {
    throw new Error(`Invalid tag '${contract.tag}'`)
  }
  if (!digestPattern.test(contract.digest)) {
    throw new Error(`Invalid digest '${contract.digest}'`)
  }
  if (!contract.image.trim()) {
    throw new Error('image cannot be empty')
  }
  if (!Array.isArray(contract.platforms) || contract.platforms.length === 0) {
    throw new Error('platforms cannot be empty')
  }
  const uniquePlatforms = new Set(contract.platforms)
  if (uniquePlatforms.size !== contract.platforms.length) {
    throw new Error(`platforms contains duplicates: ${contract.platforms.join(', ')}`)
  }
  const missingRequiredPlatforms = requiredPlatforms.filter((platform) => !uniquePlatforms.has(platform))
  if (missingRequiredPlatforms.length > 0) {
    throw new Error(`platforms missing required values: ${missingRequiredPlatforms.join(', ')}`)
  }
  for (const platform of contract.platforms) {
    if (!platform.trim() || !/^[a-z0-9]+\/[a-z0-9]+(?:\/[A-Za-z0-9._-]+)?$/.test(platform)) {
      throw new Error(`Invalid platform '${platform}'`)
    }
    const platformDigest = contract.platformDigests[platform]
    if (!digestPattern.test(platformDigest ?? '')) {
      throw new Error(`Invalid digest for platform '${platform}': '${platformDigest ?? ''}'`)
    }
  }
  if (!contract.createdAt.trim()) {
    throw new Error('createdAt cannot be empty')
  }
  if (Number.isNaN(Date.parse(contract.createdAt))) {
    throw new Error(`Invalid createdAt '${contract.createdAt}'`)
  }
}

export const writeReleaseContract = (path: string, contract: TorghutReleaseContract) => {
  const normalized: TorghutReleaseContract = {
    ...contract,
    digest: normalizeDigest(contract.digest),
    platforms: [...contract.platforms],
    platformDigests: normalizePlatformDigests(contract.platformDigests),
  }
  assertValidContract(normalized)
  writeFileSync(resolveContractPath(path), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
}

export const readReleaseContract = (path: string): TorghutReleaseContract => {
  const source = readFileSync(resolveContractPath(path), 'utf8')
  const parsed = JSON.parse(source) as Partial<TorghutReleaseContract>
  const contract: TorghutReleaseContract = {
    sourceSha: parsed.sourceSha ?? '',
    tag: parsed.tag ?? '',
    digest: normalizeDigest(parsed.digest ?? ''),
    image: parsed.image ?? '',
    platforms: Array.isArray(parsed.platforms)
      ? parsed.platforms.filter((value): value is string => typeof value === 'string')
      : [],
    platformDigests:
      parsed.platformDigests && typeof parsed.platformDigests === 'object' && !Array.isArray(parsed.platformDigests)
        ? normalizePlatformDigests(parsed.platformDigests as Record<string, string>)
        : {},
    createdAt: parsed.createdAt ?? '',
  }
  assertValidContract(contract)
  return contract
}

const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const command = parsed.command
  const path = parsed.path ?? defaultContractPath

  if (!command) {
    throw new Error('Missing command (write|get|emit-github-output)')
  }

  if (command === 'write') {
    const sourceSha = parsed.sourceSha?.trim() ?? ''
    const tag = parsed.tag?.trim() ?? ''
    const digest = normalizeDigest(parsed.digest ?? '')
    const image = parsed.image?.trim() ?? ''
    const platforms = parsed.platforms ?? []
    const platformDigests = parsed.platformDigests ?? {}
    const createdAt = new Date().toISOString()

    writeReleaseContract(path, {
      sourceSha,
      tag,
      digest,
      image,
      platforms,
      platformDigests,
      createdAt,
    })
    return
  }

  const contract = readReleaseContract(path)

  if (command === 'get') {
    if (!parsed.field) {
      throw new Error('get requires --field')
    }
    const value = contract[parsed.field]
    console.log(typeof value === 'string' ? value : JSON.stringify(value))
    return
  }

  console.log(`source_sha=${contract.sourceSha}`)
  console.log(`tag=${contract.tag}`)
  console.log(`digest=${contract.digest}`)
  console.log(`image=${contract.image}`)
  console.log(`platforms=${contract.platforms.join(',')}`)
  console.log(`platform_digests=${JSON.stringify(contract.platformDigests)}`)
  console.log(`created_at=${contract.createdAt}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to process torghut release contract', error)
  }
}
