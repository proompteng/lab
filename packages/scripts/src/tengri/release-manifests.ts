import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../shared/cli'

export const TENGRI_IMAGE = 'registry.ide-newton.ts.net/lab/tengri'
export const NANOAGENT_IMAGE = 'registry.ide-newton.ts.net/lab/nanoagent'
export const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`

const digestPattern = /^sha256:[0-9a-f]{64}$/
const defaultKustomizationPath = 'argocd/applications/tengri/kustomization.yaml'
const defaultApplicationSetPath = 'argocd/applicationsets/platform.yaml'

export type TengriRelease = {
  tengriDigest: string
  nanoagentDigest: string
  enabled: boolean
}

export type TengriReleasePaths = {
  kustomizationPath?: string
  applicationSetPath?: string
}

const absolutePath = (path: string) => (path.startsWith('/') ? path : resolve(repoRoot, path))

export function assertReleaseDigest(name: string, digest: string, allowZero = false) {
  if (!digestPattern.test(digest)) {
    throw new Error(`${name} digest must match sha256:<64 lowercase hex>, got ${digest}`)
  }
  if (!allowZero && digest === ZERO_DIGEST) {
    throw new Error(`${name} digest cannot be the bootstrap zero digest`)
  }
}

function parseKustomization(contents: string) {
  const parsed = YAML.parse(contents) as {
    configMapGenerator?: Array<{ name?: string; literals?: string[] }>
    images?: Array<{ name?: string; newName?: string; digest?: string }>
  }
  const releases = parsed.configMapGenerator?.filter((entry) => entry.name === 'tengri-release') ?? []
  if (releases.length !== 1) {
    throw new Error(`Tengri kustomization must contain exactly one tengri-release generator, found ${releases.length}`)
  }
  const nanoagentLiterals = releases[0].literals?.filter((literal) => literal.startsWith('NANOAGENT_IMAGE=')) ?? []
  if (nanoagentLiterals.length !== 1) {
    throw new Error(
      `Tengri kustomization must contain exactly one digest-pinned NANOAGENT_IMAGE literal, found ${nanoagentLiterals.length}`,
    )
  }
  const nanoagentLiteral = nanoagentLiterals[0]
  const nanoagentMatch = nanoagentLiteral?.match(
    /^NANOAGENT_IMAGE=registry\.ide-newton\.ts\.net\/lab\/nanoagent@(sha256:[0-9a-f]{64})$/,
  )
  const tengriImages = parsed.images?.filter((image) => image.name === TENGRI_IMAGE) ?? []
  if (tengriImages.length !== 1) {
    throw new Error(`Tengri kustomization must contain exactly one Tengri image entry, found ${tengriImages.length}`)
  }
  const tengriImage = tengriImages[0]

  if (!nanoagentMatch?.[1]) {
    throw new Error('Tengri kustomization must contain a digest-pinned Nanoagent image in the expected repository')
  }
  if (tengriImage?.newName !== TENGRI_IMAGE || !tengriImage.digest) {
    throw new Error('Tengri kustomization must pin the expected Tengri image repository')
  }

  return {
    tengriDigest: tengriImage.digest,
    nanoagentDigest: nanoagentMatch[1],
  }
}

function findTengriApplicationBlock(contents: string) {
  const startMatch = /^\s*- name: tengri\s*$/m.exec(contents)
  if (!startMatch) {
    throw new Error('Platform ApplicationSet does not contain a Tengri entry')
  }
  const start = startMatch.index
  const afterStart = start + startMatch[0].length
  const nextEntry = /^\s*- name: [a-z0-9-]+\s*$/m.exec(contents.slice(afterStart))
  const end = nextEntry ? afterStart + nextEntry.index : contents.length
  const block = contents.slice(start, end)
  const enabledMatches = [...block.matchAll(/^\s*enabled:\s*"(true|false)"\s*$/gm)]
  if (enabledMatches.length !== 1) {
    throw new Error(`Tengri ApplicationSet entry must contain one enabled flag, found ${enabledMatches.length}`)
  }
  return { start, end, block, enabled: enabledMatches[0][1] === 'true' }
}

export function readTengriRelease(paths: TengriReleasePaths = {}): TengriRelease {
  const kustomizationPath = absolutePath(paths.kustomizationPath ?? defaultKustomizationPath)
  const applicationSetPath = absolutePath(paths.applicationSetPath ?? defaultApplicationSetPath)
  const images = parseKustomization(readFileSync(kustomizationPath, 'utf8'))
  const application = findTengriApplicationBlock(readFileSync(applicationSetPath, 'utf8'))
  return { ...images, enabled: application.enabled }
}

export function validateTengriRelease(paths: TengriReleasePaths = {}): TengriRelease {
  const release = readTengriRelease(paths)
  assertReleaseDigest('Tengri', release.tengriDigest, true)
  assertReleaseDigest('Nanoagent', release.nanoagentDigest, true)

  const bothBootstrapDigests = release.tengriDigest === ZERO_DIGEST && release.nanoagentDigest === ZERO_DIGEST
  const oneBootstrapDigest = release.tengriDigest === ZERO_DIGEST || release.nanoagentDigest === ZERO_DIGEST
  if (!release.enabled && !bothBootstrapDigests) {
    throw new Error('Disabled Tengri application must keep both images at the bootstrap zero digest')
  }
  if (release.enabled && oneBootstrapDigest) {
    throw new Error('Enabled Tengri application cannot reference a bootstrap zero digest')
  }
  return release
}

function replaceExactlyOnce(contents: string, pattern: RegExp, replacement: string, description: string) {
  const matches = [
    ...contents.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)),
  ]
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description}, found ${matches.length}`)
  }
  return contents.replace(pattern, replacement)
}

export function updateTengriRelease(
  release: Pick<TengriRelease, 'tengriDigest' | 'nanoagentDigest'> & { enabled?: boolean },
  paths: TengriReleasePaths = {},
): TengriRelease {
  assertReleaseDigest('Tengri', release.tengriDigest)
  assertReleaseDigest('Nanoagent', release.nanoagentDigest)
  const enabled = release.enabled ?? true
  if (!enabled) {
    throw new Error('Published Tengri releases must enable the application atomically')
  }

  const kustomizationPath = absolutePath(paths.kustomizationPath ?? defaultKustomizationPath)
  const applicationSetPath = absolutePath(paths.applicationSetPath ?? defaultApplicationSetPath)
  const originalKustomization = readFileSync(kustomizationPath, 'utf8')
  const originalApplicationSet = readFileSync(applicationSetPath, 'utf8')

  let nextKustomization = replaceExactlyOnce(
    originalKustomization,
    /NANOAGENT_IMAGE=registry\.ide-newton\.ts\.net\/lab\/nanoagent@sha256:[0-9a-f]{64}/,
    `NANOAGENT_IMAGE=${NANOAGENT_IMAGE}@${release.nanoagentDigest}`,
    'Nanoagent release literal',
  )
  nextKustomization = replaceExactlyOnce(
    nextKustomization,
    /(\s+- name: registry\.ide-newton\.ts\.net\/lab\/tengri\s*\n\s+newName: registry\.ide-newton\.ts\.net\/lab\/tengri\s*\n\s+digest:)\s*sha256:[0-9a-f]{64}/,
    `$1 ${release.tengriDigest}`,
    'Tengri image digest',
  )

  const application = findTengriApplicationBlock(originalApplicationSet)
  const nextBlock = replaceExactlyOnce(
    application.block,
    /(^\s*enabled:)\s*"(?:true|false)"\s*$/m,
    '$1 "true"',
    'Tengri enabled flag',
  )
  const nextApplicationSet = `${originalApplicationSet.slice(0, application.start)}${nextBlock}${originalApplicationSet.slice(application.end)}`

  // Validate all mutations in memory before writing either file.
  const parsed = parseKustomization(nextKustomization)
  const nextApplication = findTengriApplicationBlock(nextApplicationSet)
  if (
    parsed.tengriDigest !== release.tengriDigest ||
    parsed.nanoagentDigest !== release.nanoagentDigest ||
    !nextApplication.enabled
  ) {
    throw new Error('Tengri release mutation did not produce the requested atomic release state')
  }

  writeFileSync(kustomizationPath, nextKustomization)
  writeFileSync(applicationSetPath, nextApplicationSet)
  return validateTengriRelease(paths)
}
