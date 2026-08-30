#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type PackageJson = {
  readonly name?: string
  readonly version?: string
}

type NpmPackFile = {
  readonly path?: string
  readonly size?: number
}

type NpmPackEntry = {
  readonly id?: string
  readonly name?: string
  readonly version?: string
  readonly filename?: string
  readonly integrity?: string
  readonly shasum?: string
  readonly files?: readonly NpmPackFile[]
}

type ProductionReadiness = {
  readonly package?: {
    readonly name?: string
    readonly version?: string
  }
  readonly defaultChoice?: {
    readonly recommended?: boolean
    readonly blockers?: readonly string[]
  }
  readonly gates?: Record<string, { readonly passed?: boolean }>
}

type ReleaseProvenance = {
  readonly package?: {
    readonly name?: string
    readonly version?: string
  }
  readonly passed?: boolean
  readonly releaseProvenanceManifest?: string
  readonly readinessArtifacts?: readonly {
    readonly path?: string
    readonly present?: boolean
    readonly sizeBytes?: number | null
    readonly sha256?: string | null
  }[]
}

const packageRoot = join(import.meta.dir, '..')
const requiredPackedFiles = [
  'dist/production-readiness.json',
  'dist/agent-readiness.json',
  'dist/release-provenance.json',
] as const

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const parseNpmPackJson = (stdout: string): NpmPackEntry[] => {
  const firstJson = stdout.indexOf('[')
  const lastJson = stdout.lastIndexOf(']')
  if (firstJson < 0 || lastJson < firstJson) {
    throw new Error(`npm pack did not return JSON output:\n${stdout}`)
  }
  return JSON.parse(stdout.slice(firstJson, lastJson + 1)) as NpmPackEntry[]
}

const fileSize = async (path: string): Promise<number> => (await readFile(path)).byteLength

const run = async (
  command: readonly string[],
  cwd: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${stdout}\n${stderr}`)
  }
  return { stdout, stderr }
}

const runNpmPack = async (args: readonly string[], cwd: string): Promise<NpmPackEntry> => {
  const { stdout } = await run(['npm', 'pack', ...args, '--json', '--ignore-scripts'], cwd)
  const [pack] = parseNpmPackJson(stdout)
  if (!pack) {
    throw new Error('npm pack did not return a package entry')
  }
  return pack
}

const assertReadiness = (
  productionReadiness: ProductionReadiness,
  releaseProvenance: ReleaseProvenance,
  packageJson: PackageJson,
  defaultChoiceRequired: boolean,
) => {
  if (productionReadiness.package?.name !== packageJson.name) {
    throw new Error(
      `production-readiness package name ${productionReadiness.package?.name} does not match package.json`,
    )
  }
  if (productionReadiness.package?.version !== packageJson.version) {
    throw new Error(
      `production-readiness version ${productionReadiness.package?.version} does not match package.json ${packageJson.version}`,
    )
  }
  if (releaseProvenance.package?.name !== packageJson.name) {
    throw new Error(`release-provenance package name ${releaseProvenance.package?.name} does not match package.json`)
  }
  if (releaseProvenance.package?.version !== packageJson.version) {
    throw new Error(
      `release-provenance version ${releaseProvenance.package?.version} does not match package.json ${packageJson.version}`,
    )
  }
  if (releaseProvenance.releaseProvenanceManifest !== 'dist/release-provenance.json') {
    throw new Error(`release-provenance manifest path is ${releaseProvenance.releaseProvenanceManifest ?? 'missing'}`)
  }
  if (defaultChoiceRequired) {
    if (productionReadiness.defaultChoice?.recommended !== true) {
      throw new Error(
        `default-choice readiness is not recommended: ${(productionReadiness.defaultChoice?.blockers ?? []).join(' | ')}`,
      )
    }
    if (productionReadiness.gates?.releaseProvenanceEvidence?.passed !== true) {
      throw new Error('releaseProvenanceEvidence gate is not passing')
    }
    if (releaseProvenance.passed !== true) {
      throw new Error('release-provenance manifest is not passing')
    }
  }

  const readinessArtifacts = releaseProvenance.readinessArtifacts ?? []
  for (const path of ['dist/production-readiness.json', 'dist/agent-readiness.json']) {
    const artifact = readinessArtifacts.find((entry) => entry.path === path)
    if (!artifact?.present || !artifact.sha256 || artifact.sizeBytes === null) {
      throw new Error(`release-provenance readinessArtifacts missing hash for ${path}`)
    }
  }
}

const assertPackedMetadata = (pack: NpmPackEntry, packageJson: PackageJson) => {
  if (pack.name !== packageJson.name || pack.version !== packageJson.version) {
    throw new Error(`packed package ${pack.name}@${pack.version} does not match package.json`)
  }
  if (!pack.integrity || !pack.shasum || !pack.filename) {
    throw new Error('packed package is missing integrity, shasum, or filename metadata')
  }
}

const assertRequiredPackedFiles = async (pack: NpmPackEntry, root: string) => {
  const packedFiles = new Map((pack.files ?? []).map((file) => [file.path, file]))
  for (const path of requiredPackedFiles) {
    const packedFile = packedFiles.get(path)
    if (!packedFile) {
      throw new Error(`packed artifact missing ${path}`)
    }
    const currentSize = await fileSize(join(root, path))
    if (packedFile.size !== currentSize) {
      throw new Error(`packed artifact ${path} size ${packedFile.size ?? 'missing'} does not match ${currentSize}`)
    }
  }
}

const verifyPublishedPack = async (packageJson: PackageJson, spec: string) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'temporal-bun-sdk-pack-'))
  try {
    const pack = await runNpmPack([spec], tempDir)
    assertPackedMetadata(pack, packageJson)
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir)
    await run(['tar', '-xzf', join(tempDir, pack.filename ?? ''), '-C', extractDir], tempDir)
    const extractedPackageRoot = join(extractDir, 'package')
    await assertRequiredPackedFiles(pack, extractedPackageRoot)
    const productionReadiness = await readJson<ProductionReadiness>(
      join(extractedPackageRoot, 'dist', 'production-readiness.json'),
    )
    const releaseProvenance = await readJson<ReleaseProvenance>(
      join(extractedPackageRoot, 'dist', 'release-provenance.json'),
    )
    assertReadiness(productionReadiness, releaseProvenance, packageJson, true)
    console.log(
      `[temporal-bun-sdk] published readiness verified for ${pack.id ?? spec} (${pack.filename}; ${pack.integrity})`,
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

const main = async () => {
  const packageJson = await readJson<PackageJson>(join(packageRoot, 'package.json'))
  const publishedIndex = process.argv.findIndex((arg) => arg === '--npm' || arg === '--published')
  if (publishedIndex >= 0) {
    const spec = process.argv[publishedIndex + 1] ?? `${packageJson.name}@${packageJson.version}`
    await verifyPublishedPack(packageJson, spec)
    return
  }

  const productionReadinessPath = join(packageRoot, 'dist', 'production-readiness.json')
  const agentReadinessPath = join(packageRoot, 'dist', 'agent-readiness.json')
  const releaseProvenancePath = join(packageRoot, 'dist', 'release-provenance.json')

  for (const path of [productionReadinessPath, agentReadinessPath, releaseProvenancePath]) {
    if (!existsSync(path)) {
      throw new Error(`${path} missing; run verify:default-choice before packing`)
    }
  }

  const productionReadiness = await readJson<ProductionReadiness>(productionReadinessPath)
  const releaseProvenance = await readJson<ReleaseProvenance>(releaseProvenancePath)
  const defaultChoiceRequired = process.env.TEMPORAL_REQUIRE_DEFAULT_CHOICE === '1'
  assertReadiness(productionReadiness, releaseProvenance, packageJson, defaultChoiceRequired)

  const pack = await runNpmPack(['--dry-run'], packageRoot)
  assertPackedMetadata(pack, packageJson)
  await assertRequiredPackedFiles(pack, packageRoot)

  console.log(
    `[temporal-bun-sdk] packed readiness verified for ${pack.id ?? `${packageJson.name}@${packageJson.version}`} (${pack.filename})`,
  )
}

await main()
