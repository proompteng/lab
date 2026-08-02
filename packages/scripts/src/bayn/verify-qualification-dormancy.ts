#!/usr/bin/env bun

import { appendFile, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: string
      readonly candidateOrdinal: number | null
    }
  | {
      readonly status: 'ready'
      readonly reason: 'qualification-eligible'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

export type QualificationDormancyResult =
  | { readonly ok: true; readonly decision: QualificationDormancyDecision }
  | { readonly ok: false; readonly issue: { readonly path: string; readonly reason: string } }

const trialHistoryRelativePath = 'services/bayn/src/candidate-development-trials/frozen-lineage.ts'
const lifecycleRelativePath = 'services/bayn/src/candidate-development-trials/qualification-dormancy.ts'
const packageRoot = resolve(import.meta.dir, '../../../..')
const baynNodeModules = resolve(packageRoot, 'services/bayn/node_modules')
const baynEffectLink = resolve(baynNodeModules, 'effect')
const lifecycleEffectVersion = '4.0.0-beta.102'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

interface CachedPackage {
  readonly root: string
  readonly manifest: PackageManifest
}

interface RuntimeLink {
  readonly path: string
  readonly parent: string | undefined
}

const packageManifest = async (packageRoot: string): Promise<PackageManifest | undefined> => {
  try {
    return JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return undefined
  }
}

const satisfies = (manifest: PackageManifest, name: string, range: string): boolean =>
  manifest.name === name && typeof manifest.version === 'string' && Bun.semver.satisfies(manifest.version, range)

const cachePackageDirectories = async (cacheRoot: string, name: string): Promise<readonly string[]> => {
  const separator = name.lastIndexOf('/')
  const parent = separator < 0 ? cacheRoot : resolve(cacheRoot, name.slice(0, separator))
  const leaf = separator < 0 ? name : name.slice(separator + 1)
  let entries: readonly string[]
  try {
    entries = await readdir(parent)
  } catch {
    return []
  }
  return entries.filter((entry) => entry.startsWith(`${leaf}@`)).map((entry) => resolve(parent, entry))
}

const cachedPackage = async (cacheRoot: string, name: string, range: string): Promise<CachedPackage | undefined> => {
  const candidates = await Promise.all(
    (await cachePackageDirectories(cacheRoot, name)).map(async (root) => {
      const manifest = await packageManifest(root)
      return manifest !== undefined && satisfies(manifest, name, range) ? { root, manifest } : undefined
    }),
  )
  return candidates
    .filter((candidate): candidate is CachedPackage => candidate !== undefined)
    .sort((left, right) => Bun.semver.order(String(right.manifest.version), String(left.manifest.version)))[0]
}

const lifecycleEffectPackageFromWorkspace = async (): Promise<CachedPackage | undefined> => {
  const candidates = [
    resolve(packageRoot, `node_modules/.bun/effect@${lifecycleEffectVersion}/node_modules/effect`),
    baynEffectLink,
    resolve(packageRoot, 'node_modules/effect'),
  ]
  for (const root of candidates) {
    const manifest = await packageManifest(root)
    if (manifest !== undefined && manifest.name === 'effect' && manifest.version === lifecycleEffectVersion) {
      return { root, manifest }
    }
  }
  return undefined
}

const lifecycleEffectPackageFromCache = async (): Promise<CachedPackage | undefined> => {
  const cacheRoot = resolve(homedir(), '.bun/install/cache')
  return cachedPackage(cacheRoot, 'effect', `=${lifecycleEffectVersion}`)
}

const lifecycleEffectPackage =
  (await lifecycleEffectPackageFromWorkspace()) ?? (await lifecycleEffectPackageFromCache())
if (lifecycleEffectPackage === undefined) {
  throw new Error('unable to resolve the Effect 4.0.0-beta.102 runtime for the Bayn lifecycle module')
}

const lifecycleEffectCacheRoot = resolve(homedir(), '.bun/install/cache')

const removeRuntimeLinks = async (links: readonly RuntimeLink[]): Promise<void> => {
  for (const link of [...links].reverse()) await rm(link.path, { force: true })
  for (const parent of [
    ...new Set(links.flatMap((link) => (link.parent === undefined ? [] : [link.parent]))),
  ].reverse()) {
    await rm(parent, { recursive: true, force: true })
  }
}

const linkCachedRuntimeDependencies = async (): Promise<readonly RuntimeLink[]> => {
  const links: RuntimeLink[] = []
  const visited = new Set<string>()
  const pending: CachedPackage[] = [lifecycleEffectPackage]

  try {
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined || visited.has(String(current.manifest.name))) continue
      visited.add(String(current.manifest.name))

      const dependencies = {
        ...current.manifest.dependencies,
        ...current.manifest.optionalDependencies,
      }
      for (const [name, range] of Object.entries(dependencies)) {
        if (visited.has(name)) continue
        const resolved = await cachedPackage(lifecycleEffectCacheRoot, name, range)
        if (resolved === undefined) {
          if (current.manifest.optionalDependencies?.[name] !== undefined) continue
          throw new Error(`unable to resolve cached lifecycle dependency ${name}@${range}`)
        }

        const linkPath = resolve(baynNodeModules, name)
        if (existsSync(linkPath)) {
          const existing = await packageManifest(linkPath)
          if (existing === undefined || !satisfies(existing, name, range)) {
            throw new Error(`conflicting lifecycle dependency ${name}@${range}`)
          }
          pending.push({ root: linkPath, manifest: existing })
          continue
        }

        const parent = dirname(linkPath)
        const newParent = !existsSync(parent)
        await mkdir(parent, { recursive: true })
        await symlink(resolved.root, linkPath)
        links.push({ path: linkPath, parent: newParent ? parent : undefined })
        pending.push(resolved)
      }
    }
    return links
  } catch (cause) {
    await removeRuntimeLinks(links)
    throw cause
  }
}

interface LifecycleModule {
  readonly decideQualificationDormancy: (value: unknown) => QualificationDormancyResult
}

const loadLifecycleModule = async (): Promise<LifecycleModule> => {
  const temporaryEffectLink = !existsSync(baynEffectLink)
  let dependencyLinks: readonly RuntimeLink[] = []
  if (temporaryEffectLink) {
    await mkdir(baynNodeModules, { recursive: true })
    await symlink(lifecycleEffectPackage.root, baynEffectLink)
  }

  try {
    if (lifecycleEffectPackage.root.startsWith(`${lifecycleEffectCacheRoot}/`)) {
      dependencyLinks = await linkCachedRuntimeDependencies()
    }
    return (await import(pathToFileURL(resolve(packageRoot, lifecycleRelativePath)).href)) as LifecycleModule
  } finally {
    await removeRuntimeLinks(dependencyLinks)
    if (temporaryEffectLink) await rm(baynEffectLink, { force: true })
  }
}

const lifecycleModule = await loadLifecycleModule()
const { decideQualificationDormancy } = lifecycleModule
export const evaluateQualificationDormancy = decideQualificationDormancy

interface FrozenLineageModule {
  readonly frozenCandidateDevelopmentTrialHistory: unknown
}

/**
 * The lifecycle module owns decoding and fail-closed state validation. The
 * adapter treats only the canonical `ready`/`qualification-eligible` result
 * as runnable; reviewed-only states remain dormant.
 */
export type QualificationLifecycleDecision = QualificationDormancyDecision

type QualificationLifecycleResult = QualificationDormancyResult

const decideQualificationLifecycle = (history: unknown): QualificationLifecycleResult =>
  decideQualificationDormancy(history)

const loadFrozenTrialHistory = async (repositoryRoot: string): Promise<unknown> => {
  const modulePath = resolve(repositoryRoot, trialHistoryRelativePath)
  const loaded = (await import(pathToFileURL(modulePath).href)) as FrozenLineageModule
  return loaded.frozenCandidateDevelopmentTrialHistory
}

export const verifyQualificationDormancy = async (repositoryRoot: string): Promise<QualificationLifecycleDecision> => {
  const result = decideQualificationLifecycle(await loadFrozenTrialHistory(repositoryRoot))
  if (!result.ok) throw new Error(`${result.issue.path}: ${result.issue.reason}`)
  return result.decision
}

export interface QualificationWorkflowOutputs {
  readonly eligible: 'true' | 'false'
  readonly dormant: 'true' | 'false'
  readonly reason: string
  readonly candidateOrdinal: string
}

export const qualificationWorkflowOutputs = (
  decision: QualificationLifecycleDecision,
): QualificationWorkflowOutputs => {
  const eligible = decision.status === 'ready' && decision.reason === 'qualification-eligible'
  return {
    eligible: eligible ? 'true' : 'false',
    dormant: eligible ? 'false' : 'true',
    reason: decision.reason,
    candidateOrdinal: decision.candidateOrdinal === null ? '' : String(decision.candidateOrdinal),
  }
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const run = async (): Promise<void> => {
  const decision = await verifyQualificationDormancy(argument('--repository-root'))
  const outputs = qualificationWorkflowOutputs(decision)
  await appendFile(
    argument('--github-output'),
    [
      `eligible=${outputs.eligible}`,
      `dormant=${outputs.dormant}`,
      `reason=${outputs.reason}`,
      `candidate_ordinal=${outputs.candidateOrdinal}`,
      '',
    ].join('\n'),
    'utf8',
  )
  process.stdout.write(`BAYN_QUALIFICATION_DORMANCY=${JSON.stringify(decision)}\n`)
}

if (import.meta.main) {
  await run().catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`qualification dormancy verification failed: ${message}\n`)
    process.exitCode = 1
  })
}
