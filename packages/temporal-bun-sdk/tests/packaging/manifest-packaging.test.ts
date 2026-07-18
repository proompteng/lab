import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type TemporalSdkPackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: Record<string, string | Record<string, string>>
  bin?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
  keywords?: string[]
}

const packageRoot = join(import.meta.dir, '../..')

beforeAll(async () => {
  const child = Bun.spawn(['bun', 'scripts/collect-production-evidence.ts'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      TEMPORAL_PRODUCTION_EVIDENCE_ALLOW_INCOMPLETE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`collect-production-evidence failed:\n${stdout}\n${stderr}`)
  }
})

const loadPackageJson = async (): Promise<TemporalSdkPackageJson> => {
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(packageJsonRaw) as TemporalSdkPackageJson
}

const nativeArtifactPattern = /\.(?:node|dylib|so|a)$/
const ignoredScanDirectories = new Set(['.artifacts', 'coverage', 'node_modules'])

async function listPackageFiles(directory = packageRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredScanDirectories.has(entry.name)) {
      continue
    }

    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listPackageFiles(absolutePath)))
      continue
    }

    files.push(absolutePath)
  }

  return files
}

describe('temporal-bun-sdk packaging manifest', () => {
  test('avoids workspace protocol dependencies in published runtime deps', async () => {
    const packageJson = await loadPackageJson()
    const dependencies = packageJson.dependencies ?? {}

    for (const [dependencyName, version] of Object.entries(dependencies)) {
      expect(version.startsWith('workspace:')).toBeFalse()
      expect(dependencyName).not.toBe('@proompteng/otel')
    }
  })

  test('keeps typescript as runtime dependency for workflow-lint CLI path', async () => {
    const packageJson = await loadPackageJson()
    const dependencies = packageJson.dependencies ?? {}
    const devDependencies = packageJson.devDependencies ?? {}

    expect(dependencies.typescript).toBeDefined()
    expect(devDependencies.typescript).toBeUndefined()
  })

  test('publishes CLI bins from dist/src output paths', async () => {
    const packageJson = await loadPackageJson()
    const bins = packageJson.bin ?? {}

    expect(bins['temporal-bun']).toBe('./dist/src/bin/temporal-bun.js')
    expect(bins['temporal-bun-skill']).toBe('./dist/src/bin/temporal-bun-skill.js')
    expect(bins['temporal-bun-worker']).toBe('./dist/src/bin/start-worker.js')
  })

  test('declares only export targets backed by source modules', async () => {
    const packageJson = await loadPackageJson()
    const exports = packageJson.exports ?? {}

    for (const [subpath, target] of Object.entries(exports)) {
      const targets = typeof target === 'string' ? [target] : Object.values(target)
      for (const exportTarget of targets) {
        if (!exportTarget.startsWith('./dist/src/') || !exportTarget.endsWith('.js')) {
          continue
        }

        const sourcePath = exportTarget.replace('./dist/src/', './src/').replace(/\.js$/, '.ts')
        expect(existsSync(join(packageRoot, sourcePath)), `${subpath} -> ${sourcePath}`).toBeTrue()
      }
    }
  })

  test('exposes adoption metadata for npm and agent discovery', async () => {
    const packageJson = await loadPackageJson()
    const keywords = packageJson.keywords ?? []

    for (const keyword of [
      'bun',
      'bun-sdk',
      'temporal',
      'temporal-sdk',
      'temporalio',
      'workflow',
      'workflow-engine',
      'workflow-orchestration',
    ]) {
      expect(keywords).toContain(keyword)
    }
  })

  test('publishes only Bun TypeScript runtime assets', async () => {
    const packageJson = await loadPackageJson()

    expect(packageJson.files).toEqual(['dist', 'docs', 'skills', 'README.md'])
    expect(packageJson.files ?? []).not.toContain('dist/native')
  })

  test('does not depend on Temporal Node worker or native build tooling', async () => {
    const packageJson = await loadPackageJson()
    const dependencies = Object.assign({}, packageJson.dependencies, packageJson.devDependencies)
    const forbiddenDependencies = [
      '@temporalio/worker',
      '@temporalio/core-bridge',
      '@temporalio/client',
      'node-gyp',
      'node-addon-api',
      'node-gyp-build',
    ]

    for (const dependencyName of forbiddenDependencies) {
      expect(dependencies[dependencyName]).toBeUndefined()
    }
  })

  test('keeps native bridge artifacts out of the production package tree', async () => {
    expect(existsSync(join(packageRoot, 'bruke'))).toBeFalse()
    expect(existsSync(join(packageRoot, 'native'))).toBeFalse()

    const packageFiles = await listPackageFiles()
    const nativeArtifacts = packageFiles.filter((filePath) => nativeArtifactPattern.test(filePath))

    expect(nativeArtifacts).toEqual([])
  })

  test('includes published dist files in the native artifact scan', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'temporal-bun-sdk-package-scan-'))
    const distRoot = join(fixtureRoot, 'dist')
    const nativeArtifact = join(distRoot, 'native-addon.node')
    try {
      await mkdir(distRoot, { recursive: true })
      await writeFile(nativeArtifact, 'fixture', 'utf8')

      const packageFiles = await listPackageFiles(fixtureRoot)

      expect(packageFiles).toContain(nativeArtifact)
      expect(packageFiles.filter((filePath) => nativeArtifactPattern.test(filePath))).toEqual([nativeArtifact])
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('keeps the package Dockerfile aligned with the Bun TypeScript runtime', async () => {
    const dockerfile = await readFile(join(packageRoot, 'Dockerfile'), 'utf8')
    const forbiddenDockerfileFragments = [
      'zig',
      'node-gyp',
      'dist/native',
      'libs:download',
      'build:native',
      'temporalio-sdk-core',
    ]

    for (const fragment of forbiddenDockerfileFragments) {
      expect(dockerfile.toLowerCase()).not.toContain(fragment.toLowerCase())
    }
    expect(dockerfile).toContain('oven/bun:1.3.14')
    expect(dockerfile).toContain('bun run build')
  })

  test('exposes a production verification command for agents and CI', async () => {
    const packageJson = await loadPackageJson()

    expect(packageJson.scripts?.['evidence:production']).toBe('bun scripts/collect-production-evidence.ts')
    expect(packageJson.scripts?.['verify:production']).toBe(
      'bun run evidence:production && bun test tests/packaging/manifest-packaging.test.ts',
    )
    expect(packageJson.scripts?.['verify:default-choice']).toBe(
      'TEMPORAL_REQUIRE_DEFAULT_CHOICE=1 bun run evidence:production && bun test tests/packaging/manifest-packaging.test.ts',
    )
    expect(packageJson.scripts?.['verify:packed-readiness']).toBe('bun scripts/verify-packed-readiness.ts')
    expect(packageJson.scripts?.prepublishOnly).toBe(
      'bun run verify:default-choice && TEMPORAL_REQUIRE_DEFAULT_CHOICE=1 bun run verify:packed-readiness',
    )
    expect(packageJson.scripts?.prepack).toBe('bun run build && bun run verify:default-choice')
  })

  test('generates production and agent readiness evidence for published artifacts', async () => {
    const productionEvidence = JSON.parse(
      await readFile(join(packageRoot, 'dist', 'production-readiness.json'), 'utf8'),
    ) as {
      schemaVersion?: number
      package?: { name?: string; version?: string }
      packageBoundary?: {
        forbiddenDependencyHits?: string[]
        nativeArtifactHits?: string[]
        forbiddenPathHits?: string[]
      }
      evidence?: {
        replayCorpusReportPassed?: boolean
        replayCorpusCoverageTags?: string[]
        loadReportPassed?: boolean
        loadScenarioCoverage?: Record<string, number>
        asyncFuzzOperationCount?: number
        asyncFuzzOperationCoverage?: Record<string, number>
        productionUsageServiceCount?: number
        productionUsageServices?: Array<{ id?: string; passed?: boolean; missingRefs?: string[] }>
        productionUsageObservabilityRefs?: string[]
        productionUsageMissingRefs?: string[]
        adoptionSurface?: {
          passed?: boolean
          missingKeywords?: string[]
          missingCliBins?: string[]
          missingPackagedDocRefs?: string[]
          missingPublicDocRefs?: string[]
          missingSkillRefs?: string[]
          missingExampleRefs?: string[]
          missingRequiredScripts?: string[]
          readinessFiles?: string[]
          bootstrapCommand?: string
        }
      }
      gates?: Record<string, { passed?: boolean }>
      releaseProvenance?: {
        passed?: boolean
        purpose?: string | null
        package?: { name?: string; version?: string }
        git?: { localSha?: string | null; githubSha?: string | null; shaMatchesGithub?: boolean }
        githubActions?: { present?: boolean; runUrl?: string | null; runId?: string | null }
        npm?: { distTag?: string | null; dryRun?: string | null }
        artifactBundles?: Array<{ name?: string; runUrl?: string | null }>
        evidenceArtifacts?: Array<{ path?: string; present?: boolean; sizeBytes?: number | null; sha256?: string | null }>
        readinessArtifactTargets?: string[]
        releaseProvenanceManifest?: string
        missing?: string[]
      }
      semanticConcerns?: Array<{
        id?: string
        defaultChoiceRequired?: boolean
        gateRefs?: string[]
        evidenceRefs?: string[]
        missingEvidenceRefs?: string[]
        passed?: boolean
      }>
      defaultChoice?: {
        recommended?: boolean
        blockers?: string[]
        scope?: string
        supportModel?: string
        semanticConcernIds?: string[]
        minimumReplayFixtures?: number
        minimumAsyncFuzzOperations?: number
        minimumLoadWorkflows?: number
        minimumLoadPeakConcurrency?: number
        minimumProductionServices?: number
      }
      adoption?: {
        defaultUseCase?: string
        bootstrapCommand?: string
        verificationCommands?: string[]
        docs?: string[]
        readinessFiles?: string[]
        decisionRules?: string[]
        fallbackRule?: string
      }
    }
    const agentReadiness = JSON.parse(await readFile(join(packageRoot, 'dist', 'agent-readiness.json'), 'utf8')) as {
      schemaVersion?: number
      package?: { name?: string }
      recommended?: boolean
      status?: string
      defaultChoiceScope?: string
      supportModel?: string
      semanticConcerns?: Array<{
        id?: string
        defaultChoiceRequired?: boolean
        missingEvidenceRefs?: string[]
        passed?: boolean
      }>
      adoption?: {
        defaultUseCase?: string
        bootstrapCommand?: string
        verificationCommands?: string[]
        docs?: string[]
        readinessFiles?: string[]
        decisionRules?: string[]
        fallbackRule?: string
      }
      releaseProvenance?: {
        passed?: boolean
        purpose?: string | null
        runUrl?: string | null
        evidenceArtifactCount?: number
        readinessArtifactTargets?: string[]
        manifestFile?: string
        missing?: string[]
      }
      blockers?: string[]
      evidenceFile?: string
    }
    const releaseProvenance = JSON.parse(
      await readFile(join(packageRoot, 'dist', 'release-provenance.json'), 'utf8'),
    ) as {
      releaseProvenanceManifest?: string
      readinessArtifacts?: Array<{ path?: string; present?: boolean; sizeBytes?: number | null; sha256?: string | null }>
    }

    expect(productionEvidence.schemaVersion).toBe(1)
    expect(productionEvidence.package?.name).toBe('@proompteng/temporal-bun-sdk')
    expect(productionEvidence.packageBoundary?.forbiddenDependencyHits).toEqual([])
    expect(productionEvidence.packageBoundary?.nativeArtifactHits).toEqual([])
    expect(productionEvidence.packageBoundary?.forbiddenPathHits).toEqual([])
    expect(productionEvidence.gates?.noForbiddenDependencies?.passed).toBeTrue()
    expect(productionEvidence.gates?.noNativeArtifacts?.passed).toBeTrue()
    expect(productionEvidence.gates?.replayCorpusEvidence).toBeDefined()
    expect(productionEvidence.gates?.loadEvidence).toBeDefined()
    expect(productionEvidence.gates?.asyncFuzzEvidence).toBeDefined()
    expect(productionEvidence.gates?.productionUsageEvidence).toBeDefined()
    expect(productionEvidence.gates?.adoptionSurfaceEvidence).toBeDefined()
    expect(productionEvidence.gates?.releaseProvenanceEvidence).toBeDefined()
    expect(typeof productionEvidence.gates?.ciWorkflowCoverage?.passed).toBe('boolean')
    expect(typeof productionEvidence.gates?.productionUsageEvidence?.passed).toBe('boolean')
    expect(typeof productionEvidence.gates?.adoptionSurfaceEvidence?.passed).toBe('boolean')
    expect(typeof productionEvidence.gates?.releaseProvenanceEvidence?.passed).toBe('boolean')
    expect(typeof productionEvidence.evidence?.replayCorpusReportPassed).toBe('boolean')
    expect(typeof productionEvidence.evidence?.loadReportPassed).toBe('boolean')
    expect(Array.isArray(productionEvidence.evidence?.replayCorpusCoverageTags)).toBeTrue()
    expect(typeof productionEvidence.evidence?.asyncFuzzOperationCount).toBe('number')
    expect(typeof productionEvidence.evidence?.asyncFuzzOperationCoverage).toBe('object')
    expect(typeof productionEvidence.evidence?.loadScenarioCoverage).toBe('object')
    expect(productionEvidence.evidence?.productionUsageServiceCount).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(productionEvidence.evidence?.productionUsageServices)).toBeTrue()
    expect(Array.isArray(productionEvidence.evidence?.productionUsageObservabilityRefs)).toBeTrue()
    expect(productionEvidence.evidence?.productionUsageMissingRefs).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.passed).toBeTrue()
    expect(productionEvidence.evidence?.adoptionSurface?.missingKeywords).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingCliBins).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingPackagedDocRefs).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingPublicDocRefs).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingSkillRefs).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingExampleRefs).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.missingRequiredScripts).toEqual([])
    expect(productionEvidence.evidence?.adoptionSurface?.bootstrapCommand).toContain('@proompteng/temporal-bun-sdk')
    expect(productionEvidence.evidence?.adoptionSurface?.readinessFiles).toContain('dist/agent-readiness.json')
    expect(productionEvidence.adoption?.defaultUseCase).toContain('@proompteng/temporal-bun-sdk')
    expect(productionEvidence.adoption?.bootstrapCommand).toBe('bunx @proompteng/temporal-bun-sdk init my-worker')
    expect(productionEvidence.adoption?.verificationCommands).toContain(
      'bun run --filter @proompteng/temporal-bun-sdk verify:default-choice',
    )
    expect(productionEvidence.adoption?.docs).toContain('packages/temporal-bun-sdk/docs/adoption-readiness.md')
    expect(productionEvidence.adoption?.readinessFiles).toContain('dist/production-readiness.json')
    expect(productionEvidence.adoption?.readinessFiles).toContain('dist/release-provenance.json')
    expect(productionEvidence.releaseProvenance?.package?.name).toBe('@proompteng/temporal-bun-sdk')
    expect(productionEvidence.releaseProvenance?.releaseProvenanceManifest).toBe('dist/release-provenance.json')
    expect(productionEvidence.releaseProvenance?.readinessArtifactTargets).toContain('dist/production-readiness.json')
    expect(productionEvidence.releaseProvenance?.readinessArtifactTargets).toContain('dist/agent-readiness.json')
    expect(productionEvidence.releaseProvenance?.readinessArtifactTargets).toContain('dist/release-provenance.json')
    expect(productionEvidence.releaseProvenance?.evidenceArtifacts?.map((artifact) => artifact.path)).toContain(
      '.artifacts/replay-corpus/report.json',
    )
    expect(productionEvidence.releaseProvenance?.artifactBundles?.map((artifact) => artifact.name)).toContain(
      'production-readiness-artifacts',
    )
    expect(releaseProvenance.releaseProvenanceManifest).toBe('dist/release-provenance.json')
    expect(releaseProvenance.readinessArtifacts?.map((artifact) => artifact.path).sort()).toEqual([
      'dist/agent-readiness.json',
      'dist/production-readiness.json',
    ])
    for (const artifact of releaseProvenance.readinessArtifacts ?? []) {
      expect(artifact.present).toBeTrue()
      expect(artifact.sizeBytes ?? 0).toBeGreaterThan(0)
      expect(artifact.sha256?.length).toBe(64)
    }
    expect(Array.isArray(productionEvidence.defaultChoice?.blockers)).toBeTrue()
    expect(productionEvidence.defaultChoice?.scope).toContain('Bun-first Temporal')
    expect(productionEvidence.defaultChoice?.supportModel).toContain('Company/community SDK')
    expect(productionEvidence.defaultChoice?.minimumReplayFixtures).toBeGreaterThanOrEqual(25)
    expect(productionEvidence.defaultChoice?.minimumAsyncFuzzOperations).toBeGreaterThanOrEqual(64)
    expect(productionEvidence.defaultChoice?.minimumLoadWorkflows).toBeGreaterThanOrEqual(64)
    expect(productionEvidence.defaultChoice?.minimumLoadPeakConcurrency).toBeGreaterThanOrEqual(10)
    expect(productionEvidence.defaultChoice?.minimumProductionServices).toBeGreaterThanOrEqual(2)

    const semanticConcerns = productionEvidence.semanticConcerns ?? []
    expect(semanticConcerns.length).toBeGreaterThanOrEqual(9)
    const requiredSemanticConcerns = semanticConcerns.filter((concern) => concern.defaultChoiceRequired)
    expect(requiredSemanticConcerns.map((concern) => concern.id).sort()).toEqual(
      (productionEvidence.defaultChoice?.semanticConcernIds ?? []).sort(),
    )
    for (const concern of semanticConcerns) {
      expect(concern.id).toBeTruthy()
      expect(concern.evidenceRefs?.length ?? 0).toBeGreaterThan(0)
      if (concern.defaultChoiceRequired) {
        expect(concern.gateRefs?.length ?? 0).toBeGreaterThan(0)
      }
    }
    if (productionEvidence.defaultChoice?.recommended) {
      expect(productionEvidence.evidence?.replayCorpusReportPassed).toBeTrue()
      expect(productionEvidence.evidence?.loadReportPassed).toBeTrue()
      expect(productionEvidence.gates?.ciWorkflowCoverage?.passed).toBeTrue()
      expect(productionEvidence.gates?.productionUsageEvidence?.passed).toBeTrue()
      expect(productionEvidence.gates?.adoptionSurfaceEvidence?.passed).toBeTrue()
      expect(productionEvidence.gates?.releaseProvenanceEvidence?.passed).toBeTrue()
      expect(productionEvidence.releaseProvenance?.passed).toBeTrue()
      for (const concern of requiredSemanticConcerns) {
        expect(concern.missingEvidenceRefs).toEqual([])
        expect(concern.passed).toBeTrue()
      }
    } else {
      expect((productionEvidence.defaultChoice?.blockers ?? []).length).toBeGreaterThan(0)
    }

    expect(agentReadiness.schemaVersion).toBe(1)
    expect(agentReadiness.package?.name).toBe('@proompteng/temporal-bun-sdk')
    expect(agentReadiness.recommended).toBe(productionEvidence.defaultChoice?.recommended)
    expect(agentReadiness.status).toBe(agentReadiness.recommended ? 'recommended' : 'evidence-required')
    expect(agentReadiness.defaultChoiceScope).toBe(productionEvidence.defaultChoice?.scope)
    expect(agentReadiness.supportModel).toBe(productionEvidence.defaultChoice?.supportModel)
    expect(agentReadiness.semanticConcerns).toEqual(productionEvidence.semanticConcerns)
    expect(agentReadiness.adoption).toEqual(productionEvidence.adoption)
    expect(agentReadiness.releaseProvenance?.passed).toBe(productionEvidence.releaseProvenance?.passed)
    expect(agentReadiness.releaseProvenance?.manifestFile).toBe('dist/release-provenance.json')
    expect(agentReadiness.releaseProvenance?.readinessArtifactTargets).toEqual(
      productionEvidence.releaseProvenance?.readinessArtifactTargets,
    )
    expect(agentReadiness.evidenceFile).toBe('production-readiness.json')
    expect(agentReadiness.blockers).toEqual(productionEvidence.defaultChoice?.blockers)
  })

  test('keeps default-choice readiness tied to release provenance instead of soak evidence', async () => {
    const productionEvidence = JSON.parse(
      await readFile(join(packageRoot, 'dist', 'production-readiness.json'), 'utf8'),
    ) as {
      gates?: Record<string, { passed?: boolean }>
      defaultChoice?: {
        recommended?: boolean
        blockers?: string[]
      }
    }

    expect(productionEvidence.gates?.soakEvidence).toBeUndefined()
    expect(productionEvidence.gates?.longSoakWorkflowCoverage).toBeUndefined()
    expect(productionEvidence.defaultChoice?.blockers?.join('\n') ?? '').not.toContain('soak evidence')
    if (productionEvidence.defaultChoice?.recommended) {
      expect(productionEvidence.gates?.releaseProvenanceEvidence?.passed).toBeTrue()
    }
  })
})
