#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { fatal, repoRoot } from './cli'
import { type EnabledAppInventory, type EnabledAppInventoryEntry, loadEnabledAppInventory } from './enabled-apps'
import type { NixOciPlatform } from './nix-oci'

type JsonRecord = Record<string, unknown>

export type NixRolloutReleaseContract = {
  service: string
  image: string
  tag: string
  digest: string
  reference: string
  sourceSha: string
  packageAttr: string
  platforms: NixOciPlatform[]
  builder: string
  invocation?: string
  path: string
}

export type NixRolloutReport = {
  totals: {
    entries: number
    applicationSetEntries: number
    directApplications: number
    byClass: Record<string, number>
  }
  nixImages: EnabledAppInventoryEntry[]
  manifestOnlyImageApps: EnabledAppInventoryEntry[]
  deferredApps: EnabledAppInventoryEntry[]
  missingBuildContracts: string[]
  releaseContracts: {
    provided: number
    valid: number
    invalid: string[]
    missingForNixImages: string[]
  }
}

const requiredPlatforms: NixOciPlatform[] = ['linux/amd64', 'linux/arm64']
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

const listJsonFiles = (path: string): string[] => {
  if (!existsSync(path)) return []
  const stat = statSync(path)
  if (stat.isFile()) return path.endsWith('.json') ? [path] : []

  const files: string[] = []
  for (const name of readdirSync(path)) {
    files.push(...listJsonFiles(join(path, name)))
  }
  return files.sort()
}

const parseReleaseContract = (path: string): NixRolloutReleaseContract | undefined => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) return undefined

  const platforms = asStringArray(parsed.platforms)
  const contract = {
    service: asString(parsed.service) ?? '',
    image: asString(parsed.image) ?? '',
    tag: asString(parsed.tag) ?? '',
    digest: asString(parsed.digest) ?? '',
    reference: asString(parsed.reference) ?? '',
    sourceSha: asString(parsed.sourceSha) ?? '',
    packageAttr: asString(parsed.packageAttr) ?? '',
    platforms: platforms as NixOciPlatform[],
    builder: asString(parsed.builder) ?? '',
    invocation: asString(parsed.invocation),
    path,
  }

  return contract
}

export const loadNixRolloutReleaseContracts = (contractsPath: string): NixRolloutReleaseContract[] =>
  listJsonFiles(contractsPath)
    .map((path) => parseReleaseContract(path))
    .filter((contract): contract is NixRolloutReleaseContract => contract !== undefined)

const validateReleaseContract = (contract: NixRolloutReleaseContract): string[] => {
  const errors: string[] = []
  for (const field of ['service', 'image', 'tag', 'digest', 'reference', 'sourceSha', 'packageAttr'] as const) {
    if (!contract[field]) errors.push(`${field} is missing`)
  }
  if (!sha256DigestPattern.test(contract.digest)) errors.push(`digest is not a full sha256 digest: ${contract.digest}`)
  if (contract.image && contract.digest && contract.reference !== `${contract.image}@${contract.digest}`) {
    errors.push(`reference does not match image and digest: ${contract.reference}`)
  }
  if (contract.builder !== 'nix-dockerTools-skopeo') errors.push(`builder is not nix-dockerTools-skopeo`)
  for (const platform of requiredPlatforms) {
    if (!contract.platforms.includes(platform)) errors.push(`missing platform ${platform}`)
  }
  return errors
}

const imageRepository = (reference: string): string => {
  const withoutDigest = reference.split('@', 1)[0] ?? reference
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
}

const imageDigest = (reference: string): string | undefined => {
  const separator = reference.lastIndexOf('@')
  if (separator < 0) return undefined
  const digest = reference.slice(separator + 1)
  return sha256DigestPattern.test(digest) ? digest : undefined
}

const contractCoversImage = (contract: NixRolloutReleaseContract, image: string): boolean => {
  const repository = imageRepository(image)
  const deployedDigest = imageDigest(image)
  return (
    imageRepository(contract.image) === repository &&
    contract.reference === `${contract.image}@${contract.digest}` &&
    (deployedDigest === undefined || deployedDigest === contract.digest)
  )
}

const countByClass = (entries: EnabledAppInventoryEntry[]): Record<string, number> =>
  entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.class] = (counts[entry.class] ?? 0) + 1
    return counts
  }, {})

export const buildNixRolloutReport = (input: {
  inventory?: EnabledAppInventory
  releaseContracts?: NixRolloutReleaseContract[]
  requireContracts?: boolean
}): NixRolloutReport => {
  const inventory = input.inventory ?? loadEnabledAppInventory()
  const releaseContracts = input.releaseContracts ?? []
  const nixImages = inventory.entries.filter((entry) => entry.class === 'nix-image')
  const manifestOnlyImageApps = inventory.entries.filter(
    (entry) => entry.class === 'vendor-manifest' && entry.repoImages.length > 0,
  )
  const deferredApps = inventory.entries.filter((entry) => entry.class === 'deferred')
  const missingBuildContracts = nixImages.flatMap((entry) => {
    const missing = []
    if (!entry.nixImageAttr) missing.push('nix attr')
    if (!entry.buildScriptPath) missing.push('manual build script')
    if (!entry.deployScriptPath) missing.push('manual deploy script')
    if (entry.workflowPaths.length === 0) missing.push('workflow')
    return missing.length > 0 ? [`${entry.name}: missing ${missing.join(', ')}`] : []
  })
  const evaluatedContracts = releaseContracts.map((contract) => ({
    contract,
    errors: validateReleaseContract(contract),
  }))
  const invalidContracts = evaluatedContracts.flatMap(({ contract, errors }) =>
    errors.length > 0 ? [`${contract.path}: ${errors.join('; ')}`] : [],
  )
  const validContracts = evaluatedContracts.filter(({ errors }) => errors.length === 0).map(({ contract }) => contract)
  const missingForNixImages = input.requireContracts
    ? nixImages.flatMap((entry) => {
        const missingImages = entry.repoImages.filter(
          (image) => !validContracts.some((contract) => contractCoversImage(contract, image)),
        )
        if (missingImages.length === 0) return []
        if (entry.repoImages.length === 1) return [entry.name]
        return missingImages.map((image) => `${entry.name}:${image}`)
      })
    : []

  return {
    totals: {
      entries: inventory.entries.length,
      applicationSetEntries: inventory.applicationSetEntryCount,
      directApplications: inventory.directApplicationCount,
      byClass: countByClass(inventory.entries),
    },
    nixImages,
    manifestOnlyImageApps,
    deferredApps,
    missingBuildContracts,
    releaseContracts: {
      provided: releaseContracts.length,
      valid: validContracts.length,
      invalid: invalidContracts,
      missingForNixImages,
    },
  }
}

const formatList = (values: string[]): string => (values.length > 0 ? values.join(', ') : 'None')

export const formatNixRolloutReportMarkdown = (report: NixRolloutReport): string => {
  const lines = [
    '# Nix Enabled-App Rollout Report',
    '',
    '## Inventory',
    '',
    `- Enabled ApplicationSet entries: ${report.totals.applicationSetEntries}`,
    `- Direct root-managed Applications: ${report.totals.directApplications}`,
    `- Total enabled entries: ${report.totals.entries}`,
    `- Classes: ${Object.entries(report.totals.byClass)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}=${count}`)
      .join(', ')}`,
    '',
    '## Nix Image Apps',
    '',
    '| App | Nix Attr | Manual Build | Manual Deploy | Workflows |',
    '| --- | --- | --- | --- | --- |',
    ...report.nixImages.map((entry) =>
      [
        `| ${entry.name}`,
        entry.nixImageAttr ?? '',
        entry.buildScriptPath ?? '',
        entry.deployScriptPath ?? '',
        `${entry.workflowPaths.join('<br>')} |`,
      ].join(' | '),
    ),
    '',
    '## Manifest-Only Repo Image References',
    '',
    '| App | Images | Reason |',
    '| --- | --- | --- |',
    ...report.manifestOnlyImageApps.map(
      (entry) => `| ${entry.name} | ${entry.repoImages.join('<br>')} | ${entry.deferredReason ?? ''} |`,
    ),
    '',
    '## Gates',
    '',
    `- Deferred apps: ${formatList(report.deferredApps.map((entry) => entry.name))}`,
    `- Missing Nix image build contracts: ${formatList(report.missingBuildContracts)}`,
    `- Release contracts provided: ${report.releaseContracts.provided}`,
    `- Valid release contracts: ${report.releaseContracts.valid}`,
    `- Invalid release contracts: ${formatList(report.releaseContracts.invalid)}`,
    `- Nix image apps missing release contracts: ${formatList(report.releaseContracts.missingForNixImages)}`,
    '',
  ]
  return `${lines.join('\n')}\n`
}

const readCliArgs = () => {
  const args = process.argv.slice(2)
  const contractsIndex = args.indexOf('--contracts-dir')
  const contractsDir = contractsIndex >= 0 ? args[contractsIndex + 1] : undefined
  if (contractsIndex >= 0 && !contractsDir) {
    throw new Error('--contracts-dir requires a path')
  }
  return {
    json: args.includes('--json'),
    contractsDir,
    requireContracts: args.includes('--require-contracts'),
  }
}

const runCli = (): void => {
  const args = readCliArgs()
  const releaseContracts = args.contractsDir
    ? loadNixRolloutReleaseContracts(resolve(repoRoot, args.contractsDir))
    : undefined
  const report = buildNixRolloutReport({ releaseContracts, requireContracts: args.requireContracts })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(formatNixRolloutReportMarkdown(report))
}

if (import.meta.main) {
  try {
    runCli()
  } catch (error) {
    fatal('Failed to build Nix rollout report', error)
  }
}
