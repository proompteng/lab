import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML, { isMap, isSeq } from 'yaml'

import { repoRoot } from '../shared/cli'

export const TENGRI_IMAGE = 'registry.ide-newton.ts.net/lab/tengri'
export const NANOAGENT_IMAGE = 'registry.ide-newton.ts.net/lab/nanoagent'
export const TENGRI_GRPC_ENDPOINT = 'tengri-grpc.tengri.svc.cluster.local:50051'
export const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`

const digestPattern = /^sha256:[0-9a-f]{64}$/
const defaultKustomizationPath = 'argocd/applications/tengri/kustomization.yaml'
const defaultApplicationSetPath = 'argocd/applicationsets/platform.yaml'
const defaultBffDeploymentPath = 'argocd/applications/proompteng/deployment.yaml'
const defaultTengriDeploymentPath = 'argocd/applications/tengri/deployment.yaml'
const tengriApplicationTarget = {
  path: 'argocd/applications/tengri',
  namespace: 'tengri',
  automation: 'auto',
} as const

export type TengriRelease = {
  tengriDigest: string
  nanoagentDigest: string
  enabled: boolean
  bffEnabled: boolean
}

export type TengriReleasePaths = {
  kustomizationPath?: string
  applicationSetPath?: string
  bffDeploymentPath?: string
  tengriDeploymentPath?: string
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
  const document = YAML.parseDocument(contents, { keepSourceTokens: true })
  if (document.errors.length > 0) {
    throw new Error(`Platform ApplicationSet is not valid YAML: ${document.errors[0].message}`)
  }

  const generators = document.getIn(['spec', 'generators', 0, 'matrix', 'generators'], true)
  if (!isSeq(generators)) {
    throw new Error('Platform ApplicationSet must contain the expected matrix generators')
  }

  const matches = generators.items.flatMap((generator) => {
    if (!isMap(generator)) return []
    const elements = generator.getIn(['list', 'elements'], true)
    if (!isSeq(elements)) return []
    return elements.items.filter((entry) => isMap(entry) && entry.get('name') === 'tengri')
  })
  if (matches.length !== 1) {
    throw new Error(`Platform ApplicationSet must contain exactly one Tengri entry, found ${matches.length}`)
  }
  const entry = matches[0]
  const application = entry.toJSON() as Record<string, unknown>
  assertTengriApplicationTarget(application)

  const enabledNode = entry.get('enabled', true)
  const enabled = entry.get('enabled')
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('Tengri ApplicationSet entry must contain one quoted true or false enabled flag')
  }
  if (!enabledNode?.range) {
    throw new Error('Tengri ApplicationSet enabled flag does not have a mutable source range')
  }

  return {
    enabled: enabled === 'true',
    enabledStart: enabledNode.range[0],
    enabledEnd: enabledNode.range[1],
  }
}

function assertTengriApplicationTarget(application: Record<string, unknown>) {
  if (application.name !== 'tengri') {
    throw new Error('Tengri ApplicationSet entry must be named tengri')
  }
  if (Object.hasOwn(application, '<<')) {
    throw new Error('Tengri ApplicationSet entry must not use YAML merge keys')
  }
  for (const [field, expected] of Object.entries(tengriApplicationTarget)) {
    const actual = application[field]
    if (actual !== expected) {
      throw new Error(
        `Tengri ApplicationSet entry must target path=${tengriApplicationTarget.path}, namespace=${tengriApplicationTarget.namespace}, automation=${tengriApplicationTarget.automation}; got ${field}=${typeof actual === 'string' ? actual : 'missing or invalid'}`,
      )
    }
  }
  const sourceOverrides = ['repoURL', 'targetRevision'].filter((field) => Object.hasOwn(application, field))
  if (sourceOverrides.length > 0) {
    throw new Error(
      `Tengri ApplicationSet entry must use the platform repository and main revision defaults; remove ${sourceOverrides.join(', ')}`,
    )
  }
}

function parseBffEndpoint(contents: string) {
  const parsed = YAML.parse(contents) as {
    spec?: {
      template?: {
        spec?: { containers?: Array<{ name?: string; env?: Array<{ name?: string; value?: string }> }> }
      }
    }
  }
  const containers =
    parsed.spec?.template?.spec?.containers?.filter((container) => container.name === 'proompteng') ?? []
  if (containers.length !== 1) {
    throw new Error(`Proompteng deployment must contain exactly one proompteng container, found ${containers.length}`)
  }
  const endpoints = containers[0]?.env?.filter((entry) => entry.name === 'TENGRI_GRPC_ENDPOINT') ?? []
  if (endpoints.length !== 1 || typeof endpoints[0]?.value !== 'string') {
    throw new Error(`Proompteng deployment must contain one literal TENGRI_GRPC_ENDPOINT, found ${endpoints.length}`)
  }
  const endpoint = endpoints[0].value
  if (endpoint !== '' && endpoint !== TENGRI_GRPC_ENDPOINT) {
    throw new Error(`Proompteng deployment contains an unexpected Tengri endpoint: ${endpoint}`)
  }
  return endpoint
}

function findProomptengContainerBlock(contents: string) {
  const lines = contents.split('\n')
  const containerSections = lines.flatMap((line, index) => {
    const match = /^(\s*)containers:\s*(?:#.*)?$/.exec(line)
    return match ? [{ index, indentation: match[1].length }] : []
  })
  if (containerSections.length !== 1) {
    throw new Error(
      `Proompteng deployment must contain exactly one containers section, found ${containerSections.length}`,
    )
  }

  const section = containerSections[0]
  const itemIndentation = section.indentation + 2
  const itemPattern = new RegExp(
    `^ {${itemIndentation}}- name:\\s*(?:"proompteng"|'proompteng'|proompteng)\\s*(?:#.*)?$`,
  )
  let sectionEnd = lines.length
  for (let index = section.index + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indentation = line.length - line.trimStart().length
    if (indentation <= section.indentation) {
      sectionEnd = index
      break
    }
  }

  const starts: number[] = []
  for (let index = section.index + 1; index < sectionEnd; index += 1) {
    if (itemPattern.test(lines[index])) starts.push(index)
  }
  if (starts.length !== 1) {
    throw new Error(`Proompteng deployment must contain one mutable proompteng container block, found ${starts.length}`)
  }

  const start = starts[0]
  let end = sectionEnd
  const siblingPattern = new RegExp(`^ {${itemIndentation}}-\\s+`)
  for (let index = start + 1; index < sectionEnd; index += 1) {
    if (siblingPattern.test(lines[index])) {
      end = index
      break
    }
  }
  return { lines, start, end }
}

function replaceBffEndpoint(contents: string) {
  parseBffEndpoint(contents)
  const { lines, start, end } = findProomptengContainerBlock(contents)
  const block = lines.slice(start, end).join('\n')
  const nextBlock = replaceExactlyOnce(
    block,
    /(^\s*- name: TENGRI_GRPC_ENDPOINT\s*\n(?:^\s*#.*\n)*^\s*value:)\s*(?:"[^"]*"|'[^']*'|[^\s#]+)\s*$/m,
    `$1 ${TENGRI_GRPC_ENDPOINT}`,
    'Tengri BFF endpoint in the proompteng container',
  )
  lines.splice(start, end - start, ...nextBlock.split('\n'))
  return lines.join('\n')
}

function assertTengriDeploymentImage(contents: string) {
  const parsed = YAML.parse(contents) as {
    spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } }
  }
  const containers = parsed.spec?.template?.spec?.containers?.filter((container) => container.name === 'tengri') ?? []
  if (containers.length !== 1) {
    throw new Error(`Tengri Deployment must contain exactly one tengri container, found ${containers.length}`)
  }
  if (containers[0]?.image !== TENGRI_IMAGE) {
    throw new Error(`Tengri Deployment image must be ${TENGRI_IMAGE}, got ${containers[0]?.image ?? 'missing'}`)
  }
}

export function readTengriRelease(paths: TengriReleasePaths = {}): TengriRelease {
  const kustomizationPath = absolutePath(paths.kustomizationPath ?? defaultKustomizationPath)
  const applicationSetPath = absolutePath(paths.applicationSetPath ?? defaultApplicationSetPath)
  const bffDeploymentPath = absolutePath(paths.bffDeploymentPath ?? defaultBffDeploymentPath)
  const tengriDeploymentPath = absolutePath(paths.tengriDeploymentPath ?? defaultTengriDeploymentPath)
  const images = parseKustomization(readFileSync(kustomizationPath, 'utf8'))
  const application = findTengriApplicationBlock(readFileSync(applicationSetPath, 'utf8'))
  const bffEndpoint = parseBffEndpoint(readFileSync(bffDeploymentPath, 'utf8'))
  assertTengriDeploymentImage(readFileSync(tengriDeploymentPath, 'utf8'))
  return { ...images, enabled: application.enabled, bffEnabled: bffEndpoint === TENGRI_GRPC_ENDPOINT }
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
  if (release.bffEnabled !== release.enabled) {
    throw new Error('Tengri BFF endpoint and ApplicationSet entry must be enabled or disabled together')
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
  const bffDeploymentPath = absolutePath(paths.bffDeploymentPath ?? defaultBffDeploymentPath)
  const tengriDeploymentPath = absolutePath(paths.tengriDeploymentPath ?? defaultTengriDeploymentPath)
  const originalKustomization = readFileSync(kustomizationPath, 'utf8')
  const originalApplicationSet = readFileSync(applicationSetPath, 'utf8')
  const originalBffDeployment = readFileSync(bffDeploymentPath, 'utf8')
  assertTengriDeploymentImage(readFileSync(tengriDeploymentPath, 'utf8'))

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
  const nextApplicationSet = `${originalApplicationSet.slice(0, application.enabledStart)}"true"${originalApplicationSet.slice(application.enabledEnd)}`
  const nextBffDeployment = replaceBffEndpoint(originalBffDeployment)

  // Validate all mutations in memory before writing any file.
  const parsed = parseKustomization(nextKustomization)
  const nextApplication = findTengriApplicationBlock(nextApplicationSet)
  const nextBffEndpoint = parseBffEndpoint(nextBffDeployment)
  if (
    parsed.tengriDigest !== release.tengriDigest ||
    parsed.nanoagentDigest !== release.nanoagentDigest ||
    !nextApplication.enabled ||
    nextBffEndpoint !== TENGRI_GRPC_ENDPOINT
  ) {
    throw new Error('Tengri release mutation did not produce the requested atomic release state')
  }

  writeFileSync(kustomizationPath, nextKustomization)
  writeFileSync(applicationSetPath, nextApplicationSet)
  writeFileSync(bffDeploymentPath, nextBffDeployment)
  return validateTengriRelease(paths)
}
