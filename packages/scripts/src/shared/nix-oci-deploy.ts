import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { ensureCli, repoRoot, run } from './cli'
import { execGit } from './git'
import { buildNixOciBuildPlan } from './nix-oci'
import { inspectOciPlatforms } from './oci'

export type BuildAndPushNixImageOptions = {
  service: string
  imageName: string
  packageAttr: string
  registry?: string
  repository?: string
  tag?: string
  sourceSha?: string
  latestTag?: string
  dryRun?: boolean
  contractPath?: string
}

export type BuildAndPushNixImageResult = {
  service: string
  image: string
  tag: string
  digest: string
  reference: string
  sourceSha: string
  packageAttr: string
  contractPath: string
  platforms: string[]
  platformDigests: Record<string, string>
  imageTarPath?: string
  dryRun?: boolean
}

const defaultRegistry = 'registry.ide-newton.ts.net'

const requiredValue = (value: string | undefined, name: string): string => {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required`)
  }
  return normalized
}

const runCapture = (command: string, args: string[]): string => {
  ensureCli(command)
  const result = Bun.spawnSync([command, ...args], { cwd: repoRoot })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`)
  }
  return stdout
}

const writeReleaseContract = (result: BuildAndPushNixImageResult, invocation: 'manual-script') => {
  mkdirSync(dirname(result.contractPath), { recursive: true })
  writeFileSync(
    result.contractPath,
    `${JSON.stringify(
      {
        service: result.service,
        image: result.image,
        tag: result.tag,
        digest: result.digest,
        reference: result.reference,
        sourceSha: result.sourceSha,
        packageAttr: result.packageAttr,
        platforms: result.platforms,
        platformDigests: result.platformDigests,
        imageTarPath: result.imageTarPath,
        builder: 'nix-dockerTools-skopeo',
        invocation,
        dryRun: result.dryRun === true ? true : undefined,
      },
      null,
      2,
    )}\n`,
  )
}

export const buildAndPushNixImage = async (
  options: BuildAndPushNixImageOptions,
): Promise<BuildAndPushNixImageResult> => {
  const registry = requiredValue(options.registry ?? defaultRegistry, 'registry')
  const repository = requiredValue(options.repository ?? `lab/${options.imageName}`, 'repository')
  const tag = requiredValue(options.tag ?? execGit(['rev-parse', '--short', 'HEAD']), 'tag')
  const sourceSha = requiredValue(options.sourceSha ?? execGit(['rev-parse', 'HEAD']), 'sourceSha')
  const service = requiredValue(options.service, 'service')
  const packageAttr = requiredValue(options.packageAttr, 'packageAttr')
  const plan = buildNixOciBuildPlan({
    service,
    imageName: requiredValue(options.imageName, 'imageName'),
    packageAttr,
    sourceSha,
    tag,
    registry,
    repository,
  })
  const image = plan.image
  const contractPath = resolve(
    repoRoot,
    options.contractPath ?? `.artifacts/${options.service}/manual-release-contract.json`,
  )

  if (options.dryRun) {
    const dryRunDigest = 'sha256:dry-run'
    const result = {
      service,
      image,
      tag,
      digest: dryRunDigest,
      reference: `${image}@${dryRunDigest}`,
      sourceSha,
      packageAttr,
      contractPath,
      platforms: [],
      platformDigests: {},
      dryRun: true,
    }
    writeReleaseContract(result, 'manual-script')
    return result
  }

  ensureCli('nix')
  ensureCli('crane')

  const outLink = resolve(repoRoot, `.artifacts/${options.service}/nix-image-result`)
  mkdirSync(dirname(outLink), { recursive: true })
  await run('nix', ['build', `.#${packageAttr}`, '--print-build-logs', '--out-link', outLink], { cwd: repoRoot })
  const tarPath = realpathSync(outLink)

  const pushArgs = ['run', '.#oci-push', '--', '--image', image, '--tag', tag, '--tar', tarPath]
  if (options.latestTag) {
    pushArgs.push('--latest-tag', options.latestTag)
  }
  await run('nix', pushArgs, { cwd: repoRoot })

  const digest = runCapture('crane', ['digest', `${image}:${tag}`])
  const observedPlatforms = inspectOciPlatforms(`${image}:${tag}`)
  if (observedPlatforms.length === 0) {
    throw new Error(`Pushed Nix OCI image has no observable platform metadata: ${image}:${tag}`)
  }
  const result = {
    service,
    image,
    tag,
    digest,
    reference: `${image}@${digest}`,
    sourceSha,
    packageAttr,
    contractPath,
    platforms: observedPlatforms.map((entry) => entry.platform),
    platformDigests: Object.fromEntries(observedPlatforms.map((entry) => [entry.platform, entry.digest])),
    imageTarPath: tarPath,
  }
  writeReleaseContract(result, 'manual-script')
  return result
}
