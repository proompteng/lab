import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { ensureCli, repoRoot, run } from './cli'
import { execGit } from './git'

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
        builder: 'nix-dockerTools-skopeo',
        invocation,
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
  const image = `${registry}/${repository}`
  const service = requiredValue(options.service, 'service')
  const packageAttr = requiredValue(options.packageAttr, 'packageAttr')
  const contractPath = resolve(
    repoRoot,
    options.contractPath ?? `.artifacts/${options.service}/manual-release-contract.json`,
  )

  if (registry !== defaultRegistry || !repository.startsWith('lab/')) {
    throw new Error(`Nix OCI image pushes must stay in ${defaultRegistry}/lab, got ${image}`)
  }

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
  const result = {
    service,
    image,
    tag,
    digest,
    reference: `${image}@${digest}`,
    sourceSha,
    packageAttr,
    contractPath,
  }
  writeReleaseContract(result, 'manual-script')
  return result
}
