#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

type PackageJson = {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly files?: string[]
  readonly scripts?: Record<string, string>
}

type GateStatus = {
  readonly passed: boolean
  readonly detail: string
}

type ProductionEvidence = {
  readonly schemaVersion: 1
  readonly package: {
    readonly name: string
    readonly version: string
  }
  readonly generatedAt: string
  readonly git: {
    readonly sha: string | null
    readonly branch: string | null
  }
  readonly runtime: {
    readonly bunVersion: string
    readonly platform: NodeJS.Platform
    readonly arch: string
  }
  readonly packageBoundary: {
    readonly files: readonly string[]
    readonly forbiddenDependencies: readonly string[]
    readonly forbiddenDependencyHits: readonly string[]
    readonly nativeArtifactHits: readonly string[]
    readonly forbiddenPathHits: readonly string[]
  }
  readonly evidence: {
    readonly replayFixtureCount: number
    readonly replayCorpusFixtureCount: number
    readonly loadReportPresent: boolean
    readonly loadReportPath: string
    readonly asyncFuzzReportPresent: boolean
    readonly asyncFuzzReportPath: string
    readonly asyncFuzzSeedCount: number
    readonly soakReportPresent: boolean
    readonly soakReportPath: string
    readonly soakIterationCount: number
    readonly soakDurationMs: number
    readonly soakElapsedMs: number
    readonly docsHash: string
  }
  readonly gates: Record<string, GateStatus>
  readonly defaultChoice: {
    readonly recommended: boolean
    readonly minimumReplayFixtures: number
    readonly minimumAsyncFuzzSeeds: number
    readonly minimumSoakIterations: number
    readonly minimumSoakDurationMs: number
    readonly blockers: readonly string[]
  }
}

type AsyncFuzzReport = {
  readonly passed?: boolean
  readonly seedCount?: number
  readonly operationCount?: number
  readonly mismatchChecks?: number
  readonly elapsedMs?: number
}

type SoakReport = {
  readonly passed?: boolean
  readonly durationMs?: number
  readonly elapsedMs?: number
  readonly iterations?: readonly { readonly exitCode?: number }[]
}

type AgentReadiness = {
  readonly schemaVersion: 1
  readonly package: ProductionEvidence['package']
  readonly generatedAt: string
  readonly recommended: boolean
  readonly status: 'recommended' | 'evidence-required'
  readonly gates: ProductionEvidence['gates']
  readonly blockers: readonly string[]
  readonly evidenceFile: string
}

const packageRoot = join(import.meta.dir, '..')
const distDir = join(packageRoot, 'dist')
const productionEvidencePath = join(distDir, 'production-readiness.json')
const agentReadinessPath = join(distDir, 'agent-readiness.json')

const forbiddenDependencies = [
  '@temporalio/worker',
  '@temporalio/core-bridge',
  '@temporalio/client',
  'node-gyp',
  'node-addon-api',
  'node-gyp-build',
]

const forbiddenPaths = ['bruke', 'native', 'dist/native']
const nativeArtifactPattern = /\.(?:node|dylib|so|a)$/
const ignoredScanDirectories = new Set(['.artifacts', 'coverage', 'dist', 'node_modules'])

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const readIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const minimumReplayFixtures = readIntEnv('TEMPORAL_REPLAY_CORPUS_MIN_FIXTURES', 3)
const minimumAsyncFuzzSeeds = readIntEnv('TEMPORAL_ASYNC_FUZZ_MIN_SEEDS', 10_000)
const minimumSoakIterations = readIntEnv('TEMPORAL_SOAK_MIN_ITERATIONS', 1)
const minimumSoakDurationMs = readIntEnv('TEMPORAL_SOAK_MIN_DURATION_MS', 1_000)
const allowIncompleteEvidence = process.env.TEMPORAL_PRODUCTION_EVIDENCE_ALLOW_INCOMPLETE === '1'

const readOptionalJson = async <T>(path: string): Promise<T | null> => {
  if (!existsSync(path)) {
    return null
  }
  try {
    return await readJson<T>(path)
  } catch {
    return null
  }
}

const safeGitOutput = async (args: readonly string[]): Promise<string | null> => {
  const child = Bun.spawn(['git', ...args], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exitCode !== 0) {
    return null
  }
  const trimmed = stdout.trim()
  return trimmed.length > 0 ? trimmed : null
}

const listFiles = async (directory = packageRoot): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredScanDirectories.has(entry.name)) {
      continue
    }

    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)))
      continue
    }

    files.push(absolutePath)
  }

  return files
}

const countJsonFiles = async (directory: string): Promise<number> => {
  if (!existsSync(directory)) {
    return 0
  }
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
}

const countReplayCorpusFixtures = async (): Promise<number> => {
  const manifestPath = join(packageRoot, 'tests', 'replay', 'corpus', 'manifest.json')
  if (!existsSync(manifestPath)) {
    return 0
  }
  const manifest = await readJson<{ fixtures?: unknown[] }>(manifestPath)
  return Array.isArray(manifest.fixtures) ? manifest.fixtures.length : 0
}

const hashDocs = async (): Promise<string> => {
  const hash = createHash('sha256')
  const docsDir = join(packageRoot, 'docs')
  if (existsSync(docsDir)) {
    for (const file of (await listFiles(docsDir)).sort()) {
      hash.update(relative(packageRoot, file))
      hash.update(await readFile(file))
    }
  }
  const readmePath = join(packageRoot, 'README.md')
  if (existsSync(readmePath)) {
    hash.update('README.md')
    hash.update(await readFile(readmePath))
  }
  return hash.digest('hex')
}

const buildGate = (passed: boolean, detail: string): GateStatus => ({ passed, detail })

const main = async () => {
  const packageJson = await readJson<PackageJson>(join(packageRoot, 'package.json'))
  const dependencies = Object.assign({}, packageJson.dependencies, packageJson.devDependencies)
  const forbiddenDependencyHits = forbiddenDependencies.filter((dependency) => dependencies[dependency] !== undefined)
  const packageFiles = await listFiles()
  const relativeFiles = packageFiles.map((file) => relative(packageRoot, file))
  const nativeArtifactHits = relativeFiles.filter((file) => nativeArtifactPattern.test(file))
  const forbiddenPathHits = forbiddenPaths.filter((path) => existsSync(join(packageRoot, path)))
  const replayFixtureCount = await countJsonFiles(join(packageRoot, 'tests', 'replay', 'fixtures'))
  const replayCorpusFixtureCount = await countReplayCorpusFixtures()
  const loadReportPath = join(packageRoot, '.artifacts', 'worker-load', 'report.json')
  const loadReportPresent = existsSync(loadReportPath)
  const asyncFuzzReportPath = join(packageRoot, '.artifacts', 'async-fuzz', 'report.json')
  const asyncFuzzReport = await readOptionalJson<AsyncFuzzReport>(asyncFuzzReportPath)
  const asyncFuzzSeedCount = asyncFuzzReport?.seedCount ?? 0
  const asyncFuzzPassed = asyncFuzzReport?.passed === true
  const soakReportPath = join(packageRoot, '.artifacts', 'worker-soak', 'report.json')
  const soakReport = await readOptionalJson<SoakReport>(soakReportPath)
  const soakIterationCount = soakReport?.iterations?.length ?? 0
  const soakIterationsPassed = soakReport?.iterations?.every((entry) => entry.exitCode === 0) ?? false
  const soakDurationMs = soakReport?.durationMs ?? 0
  const soakElapsedMs = soakReport?.elapsedMs ?? 0
  const soakPassed = soakReport?.passed === true && soakIterationsPassed
  const docsHash = await hashDocs()

  const gates: Record<string, GateStatus> = {
    packageFiles: buildGate(
      JSON.stringify(packageJson.files ?? []) === JSON.stringify(['dist', 'docs', 'skills', 'README.md']),
      `files=${JSON.stringify(packageJson.files ?? [])}`,
    ),
    noForbiddenDependencies: buildGate(
      forbiddenDependencyHits.length === 0,
      forbiddenDependencyHits.length === 0 ? 'no forbidden dependencies' : forbiddenDependencyHits.join(', '),
    ),
    noNativeArtifacts: buildGate(
      nativeArtifactHits.length === 0,
      nativeArtifactHits.length === 0 ? 'no native artifacts' : nativeArtifactHits.join(', '),
    ),
    noForbiddenPaths: buildGate(
      forbiddenPathHits.length === 0,
      forbiddenPathHits.length === 0 ? 'no forbidden native paths' : forbiddenPathHits.join(', '),
    ),
    replayFixturesPresent: buildGate(replayFixtureCount > 0, `fixtures=${replayFixtureCount}`),
    loadReportPresent: buildGate(
      loadReportPresent,
      loadReportPresent ? relative(packageRoot, loadReportPath) : 'missing',
    ),
    asyncFuzzEvidence: buildGate(
      asyncFuzzPassed && asyncFuzzSeedCount >= minimumAsyncFuzzSeeds,
      asyncFuzzReport
        ? `seeds=${asyncFuzzSeedCount}; elapsedMs=${asyncFuzzReport.elapsedMs ?? 0}; path=${relative(packageRoot, asyncFuzzReportPath)}`
        : 'missing',
    ),
    soakEvidence: buildGate(
      soakPassed && soakIterationCount >= minimumSoakIterations && soakElapsedMs >= minimumSoakDurationMs,
      soakReport
        ? `iterations=${soakIterationCount}; durationMs=${soakDurationMs}; elapsedMs=${soakElapsedMs}; path=${relative(packageRoot, soakReportPath)}`
        : 'missing',
    ),
  }

  const blockers: string[] = []
  const replayEvidenceCount = Math.max(replayFixtureCount, replayCorpusFixtureCount)
  if (replayEvidenceCount < minimumReplayFixtures) {
    blockers.push(
      `replay corpus has ${replayEvidenceCount} fixtures; ${minimumReplayFixtures} required for default-choice readiness`,
    )
  }
  if (!gates.loadReportPresent.passed) {
    blockers.push('worker load evidence is missing')
  }
  if (!gates.asyncFuzzEvidence.passed) {
    blockers.push(`async fuzz evidence has ${asyncFuzzSeedCount} seeds; ${minimumAsyncFuzzSeeds} required`)
  }
  if (!gates.soakEvidence.passed) {
    blockers.push(
      `soak evidence has ${soakIterationCount} passing iterations and ${soakElapsedMs}ms elapsed; ${minimumSoakIterations} iterations and ${minimumSoakDurationMs}ms required`,
    )
  }

  const requiredBoundaryGates = [
    gates.packageFiles,
    gates.noForbiddenDependencies,
    gates.noNativeArtifacts,
    gates.noForbiddenPaths,
    gates.replayFixturesPresent,
    gates.loadReportPresent,
    gates.asyncFuzzEvidence,
    gates.soakEvidence,
  ]
  const boundaryReady = requiredBoundaryGates.every((gate) => gate.passed)
  const recommended = boundaryReady && blockers.length === 0

  const evidence: ProductionEvidence = {
    schemaVersion: 1,
    package: {
      name: packageJson.name ?? '@proompteng/temporal-bun-sdk',
      version: packageJson.version ?? '0.0.0',
    },
    generatedAt: new Date().toISOString(),
    git: {
      sha: await safeGitOutput(['rev-parse', 'HEAD']),
      branch: await safeGitOutput(['branch', '--show-current']),
    },
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    packageBoundary: {
      files: packageJson.files ?? [],
      forbiddenDependencies,
      forbiddenDependencyHits,
      nativeArtifactHits,
      forbiddenPathHits,
    },
    evidence: {
      replayFixtureCount,
      replayCorpusFixtureCount,
      loadReportPresent,
      loadReportPath: relative(packageRoot, loadReportPath),
      asyncFuzzReportPresent: asyncFuzzReport !== null,
      asyncFuzzReportPath: relative(packageRoot, asyncFuzzReportPath),
      asyncFuzzSeedCount,
      soakReportPresent: soakReport !== null,
      soakReportPath: relative(packageRoot, soakReportPath),
      soakIterationCount,
      soakDurationMs,
      soakElapsedMs,
      docsHash,
    },
    gates,
    defaultChoice: {
      recommended,
      minimumReplayFixtures,
      minimumAsyncFuzzSeeds,
      minimumSoakIterations,
      minimumSoakDurationMs,
      blockers,
    },
  }

  const agentReadiness: AgentReadiness = {
    schemaVersion: 1,
    package: evidence.package,
    generatedAt: evidence.generatedAt,
    recommended,
    status: recommended ? 'recommended' : 'evidence-required',
    gates,
    blockers,
    evidenceFile: 'production-readiness.json',
  }

  await mkdir(distDir, { recursive: true })
  await writeFile(productionEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await writeFile(agentReadinessPath, `${JSON.stringify(agentReadiness, null, 2)}\n`, 'utf8')
  console.log(`[temporal-bun-sdk] wrote ${relative(packageRoot, productionEvidencePath)}`)
  console.log(`[temporal-bun-sdk] wrote ${relative(packageRoot, agentReadinessPath)}`)

  if (!boundaryReady && !allowIncompleteEvidence) {
    process.exitCode = 1
  }
}

await main()
