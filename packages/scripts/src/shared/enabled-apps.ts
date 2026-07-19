#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import YAML from 'yaml'

import { fatal, repoRoot } from './cli'

export type EnabledAppClass = 'nix-image' | 'helm-chart' | 'vendor-manifest' | 'external-source' | 'deferred'

export type EnabledAppInventoryEntry = {
  name: string
  path: string
  repoURL: string
  sourceFile: string
  sourceKind: 'applicationset-element' | 'direct-application'
  class: EnabledAppClass
  enabled: boolean
  hasHelmChart: boolean
  repoImages: string[]
  buildScriptPath?: string
  deployScriptPath?: string
  workflowPaths: string[]
  nixImageAttr?: string
  deferredReason?: string
}

export type EnabledAppInventory = {
  entries: EnabledAppInventoryEntry[]
  applicationSetEntryCount: number
  directApplicationCount: number
}

type JsonRecord = Record<string, unknown>

const labRepoURL = 'https://github.com/proompteng/lab.git'
const labImagePrefix = 'registry.ide-newton.ts.net/lab/'
const labImageRegistry = 'registry.ide-newton.ts.net'
const sha256HexPattern = /^[0-9a-f]{64}$/
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/

const earlyNixImageApps = new Set([
  'agents',
  'app',
  'arc',
  'attic',
  'bayn',
  'bumba',
  'docs',
  'froussard',
  'headlamp',
  'jangar',
  'oirat',
  'olden',
  'proompteng',
  'sag',
  'symphony',
  'symphony-jangar',
  'symphony-torghut',
  'synthesis',
  'torghut',
  'torghut-hyperliquid-feed',
  'torghut-hyperliquid-runtime',
  'torghut-options',
])

const appToNixAttr = new Map<string, string>([
  ['app', 'app-image'],
  ['arc', 'arc-runner-image'],
  ['attic', 'atticd-image'],
  ['bayn', 'bayn-image'],
  ['bumba', 'bumba-image'],
  ['docs', 'docs-image'],
  ['froussard', 'froussard-image'],
  ['headlamp', 'headlamp-image'],
  ['jangar', 'jangar-image'],
  ['oirat', 'oirat-image'],
  ['olden', 'olden-image'],
  ['proompteng', 'proompteng-image'],
  ['sag', 'sag-image'],
  ['symphony', 'symphony-image'],
  ['symphony-jangar', 'symphony-image'],
  ['symphony-torghut', 'symphony-image'],
  ['synthesis', 'synthesis-image'],
  ['agents', 'agents-codex-runner-image'],
  ['torghut', 'torghut-image'],
  ['torghut-hyperliquid-feed', 'torghut-hyperliquid-feed-image'],
  ['torghut-hyperliquid-runtime', 'torghut-image'],
  ['torghut-options', 'torghut-image'],
])

const appToBuildScriptPath = new Map<string, string>([
  ['arc', 'packages/scripts/src/arc-runner/build-image.ts'],
  ['symphony-jangar', 'packages/scripts/src/symphony/build-image.ts'],
  ['symphony-torghut', 'packages/scripts/src/symphony/build-image.ts'],
  ['torghut-hyperliquid-feed', 'packages/scripts/src/torghut/build-hyperliquid-feed-image.ts'],
  ['torghut-hyperliquid-runtime', 'packages/scripts/src/torghut/build-image.ts'],
  ['torghut-options', 'packages/scripts/src/torghut/build-image.ts'],
])

const appToDeployScriptPath = new Map<string, string>([
  ['arc', 'packages/scripts/src/arc-runner/deploy-service.ts'],
  ['bayn', 'packages/scripts/src/bayn/update-manifests.ts'],
  ['symphony-jangar', 'packages/scripts/src/symphony/deploy-service.ts'],
  ['symphony-torghut', 'packages/scripts/src/symphony/deploy-service.ts'],
  ['torghut-hyperliquid-feed', 'packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts'],
  ['torghut-hyperliquid-runtime', 'packages/scripts/src/torghut/update-manifests.ts'],
  ['torghut-options', 'packages/scripts/src/torghut/update-manifests.ts'],
])

const appToWorkflowPaths = new Map<string, string[]>([
  ['symphony-jangar', ['.github/workflows/symphony-build-push.yaml']],
  ['symphony-torghut', ['.github/workflows/symphony-build-push.yaml']],
  ['torghut-hyperliquid-feed', ['.github/workflows/torghut-hyperliquid-feed-build-push.yaml']],
  ['torghut-hyperliquid-runtime', ['.github/workflows/torghut-build-push.yaml']],
  [
    'torghut-options',
    [
      '.github/workflows/torghut-build-push.yaml',
      '.github/workflows/torghut-ta-build-push.yaml',
      '.github/workflows/torghut-ws-build-push.yaml',
    ],
  ],
])

const manifestOnlyRepoImageApps = new Map<string, string>([
  ['analysis', 'repo image is tracked by image updater, but no local source build/deploy path exists in this repo'],
  ['bilig', 'repo image is produced outside this checkout; this app is GitOps/image-updater managed here'],
  [
    'tigresse',
    'operator source lives in the private proompteng/tigresse repository; lab only vendors the chart and pins its image digest',
  ],
])

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const walk = (value: unknown, visit: (record: JsonRecord) => void): void => {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit)
    return
  }
  if (!isRecord(value)) return

  visit(value)
  for (const child of Object.values(value)) {
    walk(child, visit)
  }
}

const readYamlDocuments = (path: string): unknown[] => {
  const raw = readFileSync(path, 'utf8')
  return YAML.parseAllDocuments(raw)
    .filter((document) => !document.errors.length)
    .map((document) => document.toJSON())
    .filter((document) => document !== null)
}

const listYamlFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return []

  const entries: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      entries.push(...listYamlFiles(path))
    } else if (stat.isFile() && /\.(ya?ml)$/.test(name)) {
      entries.push(path)
    }
  }
  return entries.sort()
}

const isEnabledValue = (value: unknown): boolean => {
  const normalized =
    typeof value === 'string'
      ? value.trim().toLowerCase()
      : typeof value === 'boolean' || typeof value === 'number'
        ? String(value).toLowerCase()
        : 'true'
  return normalized !== 'false' && normalized !== '0'
}

const collectApplicationSetElements = (document: unknown, sourceFile: string): EnabledAppInventoryEntry[] => {
  const entries: EnabledAppInventoryEntry[] = []
  walk(document, (record) => {
    const elements = record.elements
    if (!Array.isArray(elements)) return

    for (const element of elements) {
      if (!isRecord(element)) continue

      const name = asString(element.name)
      const path = asString(element.path)
      if (!name || !path || !isEnabledValue(element.enabled)) continue

      entries.push({
        name,
        path,
        repoURL: asString(element.repoURL) ?? labRepoURL,
        sourceFile,
        sourceKind: 'applicationset-element',
        class: 'vendor-manifest',
        enabled: true,
        hasHelmChart: false,
        repoImages: [],
        workflowPaths: [],
      })
    }
  })
  return entries
}

const collectDirectApplications = (document: unknown, sourceFile: string): EnabledAppInventoryEntry[] => {
  if (!isRecord(document) || document.kind !== 'Application') return []
  const metadata = isRecord(document.metadata) ? document.metadata : {}
  const spec = isRecord(document.spec) ? document.spec : {}
  const source = isRecord(spec.source) ? spec.source : {}
  const name = asString(metadata.name)
  const path = asString(source.path)
  if (!name || !path || name === 'root') return []

  return [
    {
      name,
      path,
      repoURL: asString(source.repoURL) ?? labRepoURL,
      sourceFile,
      sourceKind: 'direct-application',
      class: 'vendor-manifest',
      enabled: true,
      hasHelmChart: false,
      repoImages: [],
      workflowPaths: [],
    },
  ]
}

const collectRepoImages = (yamlPath: string, document: unknown): string[] => {
  const images = new Set<string>()
  walk(document, (record) => {
    const image = asString(record.image)
    if (image?.startsWith(labImagePrefix)) images.add(image)

    const registry = asString(record.registry)
    const repository = asString(record.repository)
    const tag = asString(record.tag)
    const digest = asString(record.digest)
    const qualifiedRepository = repository?.startsWith(labImagePrefix)
      ? repository
      : registry === labImageRegistry && repository?.startsWith('lab/')
        ? `${registry}/${repository}`
        : undefined
    if (qualifiedRepository) {
      images.add(imageReferenceWithSiblingDigest(qualifiedRepository, digest, tag))
    }

    if (basename(yamlPath) === 'kustomization.yaml' && Array.isArray(record.images)) {
      for (const entry of record.images) {
        if (!isRecord(entry)) continue
        const value = asString(entry.newName) ?? asString(entry.name)
        if (value?.startsWith(labImagePrefix)) {
          images.add(imageReferenceWithSiblingDigest(value, asString(entry.digest), asString(entry.newTag)))
        }
      }
    }
  })
  return [...images]
}

const imageReferenceWithSiblingDigest = (
  repository: string,
  digest: string | undefined,
  tag: string | undefined,
): string => {
  if (repository.endsWith('@sha256') && tag && sha256HexPattern.test(tag)) {
    return `${repository}:${tag}`
  }
  if (!repository.includes('@') && digest && sha256DigestPattern.test(digest)) {
    return `${repository}@${digest}`
  }
  return repository
}

const imageRepository = (reference: string): string => {
  const withoutDigest = reference.split('@', 1)[0] ?? reference
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
}

const normalizeRepoImages = (images: Iterable<string>): string[] => {
  const values = uniqueSorted(images)
  const digestPinnedRepositories = new Set(
    values
      .filter((reference) => /@sha256:[0-9a-f]{64}$/.test(reference))
      .map((reference) => imageRepository(reference)),
  )
  return values.filter(
    (reference) => /@sha256:[0-9a-f]{64}$/.test(reference) || !digestPinnedRepositories.has(imageRepository(reference)),
  )
}

const inspectApplicationPath = (root: string, entry: EnabledAppInventoryEntry): EnabledAppInventoryEntry => {
  if (entry.repoURL !== labRepoURL) {
    return entry
  }

  const absolutePath = resolve(root, entry.path)
  const yamlFiles = listYamlFiles(absolutePath)
  const repoImages = new Set<string>()
  let hasHelmChart = false

  for (const yamlPath of yamlFiles) {
    for (const document of readYamlDocuments(yamlPath)) {
      walk(document, (record) => {
        if (Array.isArray(record.helmCharts) || record.kind === 'HelmRelease') {
          hasHelmChart = true
        }
      })
      for (const image of collectRepoImages(yamlPath, document)) repoImages.add(image)
    }
  }

  const buildScriptPath = appToBuildScriptPath.get(entry.name) ?? `packages/scripts/src/${entry.name}/build-image.ts`
  const deployScriptPath =
    appToDeployScriptPath.get(entry.name) ?? `packages/scripts/src/${entry.name}/deploy-service.ts`
  const detectedWorkflowPaths = listYamlFiles(resolve(root, '.github/workflows')).filter((path) => {
    const workflow = readFileSync(path, 'utf8')
    return (
      workflow.includes(`image_name: ${entry.name}`) ||
      workflow.includes(`registry.ide-newton.ts.net/lab/${entry.name}`)
    )
  })
  const workflowPaths = uniqueSorted([
    ...detectedWorkflowPaths.map((path) => relative(root, path)),
    ...(appToWorkflowPaths.get(entry.name) ?? []).filter((path) => existsSync(resolve(root, path))),
  ])

  return {
    ...entry,
    hasHelmChart,
    repoImages: normalizeRepoImages(repoImages),
    buildScriptPath: existsSync(resolve(root, buildScriptPath)) ? buildScriptPath : undefined,
    deployScriptPath: existsSync(resolve(root, deployScriptPath)) ? deployScriptPath : undefined,
    workflowPaths,
    nixImageAttr: appToNixAttr.get(entry.name),
  }
}

const classify = (entry: EnabledAppInventoryEntry): EnabledAppInventoryEntry => {
  if (entry.repoURL !== labRepoURL) {
    return { ...entry, class: 'external-source' }
  }

  const manifestOnlyReason = manifestOnlyRepoImageApps.get(entry.name)
  if (manifestOnlyReason) {
    return { ...entry, class: 'vendor-manifest', deferredReason: manifestOnlyReason }
  }

  if (entry.repoImages.length > 0) {
    if (earlyNixImageApps.has(entry.name)) {
      return { ...entry, class: 'nix-image' }
    }
    return {
      ...entry,
      class: 'deferred',
      deferredReason: 'repo image is present but this app is not in the approved early Nix migration wave',
    }
  }

  if (entry.hasHelmChart) {
    return { ...entry, class: 'helm-chart' }
  }

  return { ...entry, class: 'vendor-manifest' }
}

export const loadEnabledAppInventory = (root = repoRoot): EnabledAppInventory => {
  const applicationsetsDir = resolve(root, 'argocd/applicationsets')
  const sourceFiles = listYamlFiles(applicationsetsDir)
  const rawEntries: EnabledAppInventoryEntry[] = []

  for (const path of sourceFiles) {
    const sourceFile = relative(root, path)
    for (const document of readYamlDocuments(path)) {
      rawEntries.push(...collectApplicationSetElements(document, sourceFile))
      rawEntries.push(...collectDirectApplications(document, sourceFile))
    }
  }

  const deduped = new Map<string, EnabledAppInventoryEntry>()
  for (const entry of rawEntries) {
    deduped.set(`${entry.sourceKind}:${entry.name}:${entry.path}:${entry.repoURL}`, entry)
  }

  const entries = [...deduped.values()]
    .map((entry) => classify(inspectApplicationPath(root, entry)))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    entries,
    applicationSetEntryCount: entries.filter((entry) => entry.sourceKind === 'applicationset-element').length,
    directApplicationCount: entries.filter((entry) => entry.sourceKind === 'direct-application').length,
  }
}

export const assertEnabledAppBuildPolicy = (inventory: EnabledAppInventory): void => {
  const invalid = inventory.entries.filter(
    (entry) =>
      (entry.class === 'helm-chart' || entry.class === 'vendor-manifest' || entry.class === 'external-source') &&
      (entry.nixImageAttr || entry.buildScriptPath),
  )

  if (invalid.length > 0) {
    throw new Error(
      `Non-build app(s) have image build state: ${invalid.map((entry) => `${entry.name}:${entry.class}`).join(', ')}`,
    )
  }

  const chartBuilds = inventory.entries.filter((entry) => entry.class === 'helm-chart' && entry.repoImages.length > 0)
  if (chartBuilds.length > 0) {
    throw new Error(
      `Helm-chart app(s) unexpectedly own lab images: ${chartBuilds.map((entry) => entry.name).join(', ')}`,
    )
  }
}

const printTable = (inventory: EnabledAppInventory): void => {
  for (const entry of inventory.entries) {
    console.log(
      [entry.class, entry.name, entry.path, entry.repoURL, entry.repoImages.join(','), entry.deferredReason ?? ''].join(
        '\t',
      ),
    )
  }
}

const runCli = (): void => {
  const args = process.argv.slice(2)
  const inventory = loadEnabledAppInventory()
  if (args.includes('--assert')) {
    assertEnabledAppBuildPolicy(inventory)
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(inventory, null, 2))
    return
  }
  printTable(inventory)
}

if (import.meta.main) {
  try {
    runCli()
  } catch (error) {
    fatal('Enabled app inventory check failed', error)
  }
}
