#!/usr/bin/env bun

import { fatal } from './cli'

export type NixOciPlatform = 'linux/amd64' | 'linux/arm64'

export type NixOciBuildPlanInput = {
  service: string
  imageName: string
  packageAttr: string
  sourceSha: string
  tag: string
  registry?: string
  repository?: string
  platforms?: NixOciPlatform[]
}

export type NixOciBuildPlan = Omit<Required<NixOciBuildPlanInput>, 'platforms'> & {
  platforms: NixOciPlatform[]
  image: string
  referenceTag: string
  nixBuildArgs: string[]
  platformPushArgs: Partial<Record<NixOciPlatform, string[]>>
  indexArgs: string[]
}

export type NixOciReleaseContract = {
  service: string
  image: string
  tag: string
  digest: string
  reference: string
  sourceSha: string
  packageAttr: string
  platforms: NixOciPlatform[]
  lockfileHashes: Record<string, string>
  toolVersions: Record<string, string>
  builder: 'nix-dockerTools-skopeo'
  invocation: 'github-actions' | 'manual-script'
}

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultPlatforms: NixOciPlatform[] = ['linux/amd64', 'linux/arm64']

const normalizeNonEmpty = (value: string, field: string): string => {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}

const assertLabRepository = (registry: string, repository: string): void => {
  if (registry !== defaultRegistry || !repository.startsWith('lab/')) {
    throw new Error(`Nix OCI image pushes must stay in ${defaultRegistry}/lab, got ${registry}/${repository}`)
  }
}

export const buildNixOciBuildPlan = (input: NixOciBuildPlanInput): NixOciBuildPlan => {
  const service = normalizeNonEmpty(input.service, 'service')
  const imageName = normalizeNonEmpty(input.imageName, 'imageName')
  const packageAttr = normalizeNonEmpty(input.packageAttr, 'packageAttr')
  const sourceSha = normalizeNonEmpty(input.sourceSha, 'sourceSha')
  const tag = normalizeNonEmpty(input.tag, 'tag')
  const registry = normalizeNonEmpty(input.registry ?? defaultRegistry, 'registry')
  const repository = normalizeNonEmpty(input.repository ?? `lab/${imageName}`, 'repository')
  const platforms = input.platforms?.length ? input.platforms : defaultPlatforms

  assertLabRepository(registry, repository)

  const image = `${registry}/${repository}`
  const archTags = platforms.flatMap((platform) => {
    const arch = platform.replace('linux/', '') as 'amd64' | 'arm64'
    return ['--arch-tag', `${platform}=${tag}-${arch}`]
  })
  const platformPushArgs = Object.fromEntries(
    platforms.map((platform) => {
      const arch = platform.replace('linux/', '') as 'amd64' | 'arm64'
      return [
        platform,
        [
          'nix',
          'run',
          '.#oci-push',
          '--',
          '--image',
          image,
          '--tag',
          `${tag}-${arch}`,
          '--tar',
          `<${packageAttr}-tar>`,
        ],
      ]
    }),
  ) as Partial<Record<NixOciPlatform, string[]>>

  return {
    service,
    imageName,
    packageAttr,
    sourceSha,
    tag,
    registry,
    repository,
    platforms,
    image,
    referenceTag: `${image}:${tag}`,
    nixBuildArgs: ['nix', 'build', `.#${packageAttr}`, '--print-build-logs'],
    platformPushArgs,
    indexArgs: ['nix', 'run', '.#create-oci-index', '--', '--image', image, '--tag', tag, ...archTags],
  }
}

export const buildNixOciReleaseContract = (input: {
  plan: NixOciBuildPlan
  digest: string
  invocation: NixOciReleaseContract['invocation']
  lockfileHashes?: Record<string, string>
  toolVersions?: Record<string, string>
}): NixOciReleaseContract => {
  const digest = normalizeNonEmpty(input.digest, 'digest')
  if (!digest.startsWith('sha256:')) {
    throw new Error(`digest must be a sha256 digest, got ${digest}`)
  }

  return {
    service: input.plan.service,
    image: input.plan.image,
    tag: input.plan.tag,
    digest,
    reference: `${input.plan.image}@${digest}`,
    sourceSha: input.plan.sourceSha,
    packageAttr: input.plan.packageAttr,
    platforms: input.plan.platforms,
    lockfileHashes: input.lockfileHashes ?? {},
    toolVersions: input.toolVersions ?? {},
    builder: 'nix-dockerTools-skopeo',
    invocation: input.invocation,
  }
}

const runCli = (): void => {
  const [, , service, imageName, packageAttr, tag, sourceSha] = process.argv
  const plan = buildNixOciBuildPlan({
    service: service ?? '',
    imageName: imageName ?? '',
    packageAttr: packageAttr ?? '',
    tag: tag ?? '',
    sourceSha: sourceSha ?? '',
  })
  console.log(JSON.stringify(plan, null, 2))
}

if (import.meta.main) {
  try {
    runCli()
  } catch (error) {
    fatal('Failed to build Nix OCI plan', error)
  }
}
