#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'

const defaultContractPath = 'jangar-release-contract.json'

const sourceShaPattern = /^[0-9a-f]{40}$/i
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/i

export type JangarReleaseContract = {
  sourceSha: string
  tag: string
  digest: string
  image: string
  controlPlaneImage?: string
  controlPlaneDigest?: string
  createdAt: string
}

type ContractField = keyof JangarReleaseContract

type CliOptions = {
  command?: 'write' | 'get' | 'emit-github-output'
  path?: string
  sourceSha?: string
  tag?: string
  digest?: string
  image?: string
  controlPlaneImage?: string
  controlPlaneDigest?: string
  field?: ContractField
}

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }
  const digestPart = trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
  return digestPart
}

const resolveContractPath = (path: string) => resolve(repoRoot, path)

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/release-contract.ts <command> [options]

Commands:
  write
    --path <path>
    --source-sha <sha40>
    --tag <tag>
    --digest <sha256:...>
    --image <registry/repo>
    --control-plane-image <registry/repo>
    --control-plane-digest <sha256:...>
  get
    --path <path>
    --field <sourceSha|tag|digest|image|controlPlaneImage|controlPlaneDigest|createdAt>
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
      case '--control-plane-image':
        options.controlPlaneImage = value
        break
      case '--control-plane-digest':
        options.controlPlaneDigest = value
        break
      case '--field':
        if (
          !['sourceSha', 'tag', 'digest', 'image', 'controlPlaneImage', 'controlPlaneDigest', 'createdAt'].includes(
            value,
          )
        ) {
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

const assertValidContract = (contract: JangarReleaseContract) => {
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
  if (contract.controlPlaneImage !== undefined && !contract.controlPlaneImage.trim()) {
    throw new Error('controlPlaneImage cannot be empty when provided')
  }
  if (contract.controlPlaneDigest !== undefined && contract.controlPlaneDigest.trim() !== '') {
    if (!digestPattern.test(contract.controlPlaneDigest)) {
      throw new Error(`Invalid controlPlaneDigest '${contract.controlPlaneDigest}'`)
    }
  }
  if (!contract.createdAt.trim()) {
    throw new Error('createdAt cannot be empty')
  }

  const createdAtMs = Date.parse(contract.createdAt)
  if (Number.isNaN(createdAtMs)) {
    throw new Error(`Invalid createdAt '${contract.createdAt}'`)
  }
}

export const writeReleaseContract = (path: string, contract: JangarReleaseContract) => {
  const normalized: JangarReleaseContract = {
    ...contract,
    digest: normalizeDigest(contract.digest),
    controlPlaneDigest:
      contract.controlPlaneDigest === undefined ? undefined : normalizeDigest(contract.controlPlaneDigest),
  }
  assertValidContract(normalized)
  writeFileSync(resolveContractPath(path), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
}

export const readReleaseContract = (path: string): JangarReleaseContract => {
  const source = readFileSync(resolveContractPath(path), 'utf8')
  const parsed = JSON.parse(source) as Partial<JangarReleaseContract>
  const contract: JangarReleaseContract = {
    sourceSha: parsed.sourceSha ?? '',
    tag: parsed.tag ?? '',
    digest: normalizeDigest(parsed.digest ?? ''),
    image: parsed.image ?? '',
    controlPlaneImage: typeof parsed.controlPlaneImage === 'string' ? parsed.controlPlaneImage : undefined,
    controlPlaneDigest:
      typeof parsed.controlPlaneDigest === 'string' ? normalizeDigest(parsed.controlPlaneDigest) : undefined,
    createdAt: parsed.createdAt ?? '',
  }
  assertValidContract(contract)
  return contract
}

export const main = (cliOptions?: CliOptions) => {
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
    const controlPlaneImage = parsed.controlPlaneImage?.trim()
    const controlPlaneDigest = parsed.controlPlaneDigest ? normalizeDigest(parsed.controlPlaneDigest) : undefined
    const createdAt = new Date().toISOString()

    const contract: JangarReleaseContract = {
      sourceSha,
      tag,
      digest,
      image,
      controlPlaneImage,
      controlPlaneDigest,
      createdAt,
    }
    writeReleaseContract(path, contract)
    return
  }

  const contract = readReleaseContract(path)

  if (command === 'get') {
    if (!parsed.field) {
      throw new Error('get requires --field')
    }
    console.log(contract[parsed.field])
    return
  }

  console.log(`source_sha=${contract.sourceSha}`)
  console.log(`tag=${contract.tag}`)
  console.log(`digest=${contract.digest}`)
  console.log(`image=${contract.image}`)
  console.log(`control_plane_image=${contract.controlPlaneImage ?? ''}`)
  console.log(`control_plane_digest=${contract.controlPlaneDigest ?? ''}`)
  console.log(`created_at=${contract.createdAt}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to process jangar release contract', error)
  }
}

export const __private = {
  assertValidContract,
  normalizeDigest,
  parseArgs,
}
