import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { App, YamlOutputType } from 'cdk8s'
import { parseAllDocuments, stringify } from 'yaml'

import type { ApplicationDefinition } from './application'
import { assertManifest, identityKey, resourceFilename, type KubernetesManifest } from './policy/manifest-assertions'

export const repoRoot = resolve(import.meta.dir, '../../..')

type PreparedOutput = {
  readonly directory: string
  readonly cleanup: () => void
}

const parseDocuments = (source: string, contents: string): unknown[] => {
  const documents = parseAllDocuments(contents)
  const errors = documents.flatMap((document) => document.errors)
  if (errors.length > 0) {
    throw new Error(`Invalid YAML in ${source}: ${errors.map((error) => error.message).join('; ')}`)
  }
  return documents.map((document) => document.toJS()).filter((document) => document !== null)
}

const listFiles = (directory: string, prefix = ''): string[] => {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name)
    const absolutePath = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(absolutePath, relativePath) : [relativePath]
  })
}

const compareDirectories = (expectedDirectory: string, actualDirectory: string): string[] => {
  const expectedFiles = listFiles(expectedDirectory).sort()
  const actualFiles = listFiles(actualDirectory).sort()
  const differences: string[] = []

  for (const file of expectedFiles.filter((candidate) => !actualFiles.includes(candidate))) {
    differences.push(`missing tracked file: ${file}`)
  }
  for (const file of actualFiles.filter((candidate) => !expectedFiles.includes(candidate))) {
    differences.push(`unexpected tracked file: ${file}`)
  }
  for (const file of expectedFiles.filter((candidate) => actualFiles.includes(candidate))) {
    const expected = readFileSync(join(expectedDirectory, file))
    const actual = readFileSync(join(actualDirectory, file))
    if (!expected.equals(actual)) differences.push(`changed file: ${file}`)
  }

  return differences
}

const prepareOutput = (definition: ApplicationDefinition): PreparedOutput => {
  const outputDirectory = resolve(repoRoot, definition.outputDir)
  const parentDirectory = dirname(outputDirectory)
  mkdirSync(parentDirectory, { recursive: true })

  const stagingRoot = mkdtempSync(join(parentDirectory, `.${basename(outputDirectory)}.stage-`))
  const rawDirectory = join(stagingRoot, 'raw')
  const preparedDirectory = join(stagingRoot, 'prepared')
  mkdirSync(rawDirectory)
  mkdirSync(preparedDirectory)

  try {
    const app = new App({
      outdir: rawDirectory,
      outputFileExtension: '.yaml',
      yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
      recordConstructMetadata: false,
    })
    definition.create(app)
    app.synth()

    const identities = new Set<string>()
    const outputFiles: string[] = []
    const rawFiles = listFiles(rawDirectory)
    if (rawFiles.length === 0) throw new Error(`Application ${definition.name} synthesized no resources`)

    for (const rawFile of rawFiles) {
      if (!rawFile.endsWith('.yaml')) throw new Error(`Unexpected synthesis artifact: ${rawFile}`)
      const rawPath = join(rawDirectory, rawFile)
      if (!statSync(rawPath).isFile()) throw new Error(`Unexpected synthesis entry: ${rawFile}`)

      const documents = parseDocuments(rawPath, readFileSync(rawPath, 'utf8'))
      if (documents.length !== 1) {
        throw new Error(`${rawFile} must contain exactly one Kubernetes document, got ${documents.length}`)
      }

      const { identity } = assertManifest(definition, documents[0])
      const key = identityKey(identity)
      if (identities.has(key)) throw new Error(`Duplicate resource identity: ${key}`)
      identities.add(key)

      const filename = resourceFilename(identity)
      if (outputFiles.includes(filename)) throw new Error(`Generated filename collision: ${filename}`)
      outputFiles.push(filename)
      copyFileSync(rawPath, join(preparedDirectory, filename))
    }

    outputFiles.sort()
    writeFileSync(
      join(preparedDirectory, 'kustomization.yaml'),
      stringify(
        {
          apiVersion: 'kustomize.config.k8s.io/v1beta1',
          kind: 'Kustomization',
          resources: outputFiles,
        },
        { lineWidth: 0 },
      ),
    )

    return {
      directory: preparedDirectory,
      cleanup: () => rmSync(stagingRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

const swapPreparedDirectory = (outputDirectory: string, preparedDirectory: string) => {
  const backupDirectory = `${outputDirectory}.backup-${process.pid}-${Date.now()}`
  const hadOutput = existsSync(outputDirectory)

  try {
    if (hadOutput) renameSync(outputDirectory, backupDirectory)
    renameSync(preparedDirectory, outputDirectory)
    rmSync(backupDirectory, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(outputDirectory)) rmSync(outputDirectory, { recursive: true, force: true })
    if (existsSync(backupDirectory)) renameSync(backupDirectory, outputDirectory)
    throw error
  }
}

const replaceOutput = (definition: ApplicationDefinition, prepared: PreparedOutput) => {
  const outputDirectory = resolve(repoRoot, definition.outputDir)
  try {
    swapPreparedDirectory(outputDirectory, prepared.directory)
  } finally {
    prepared.cleanup()
  }
}

export const synthesizeApplication = (definition: ApplicationDefinition) => {
  const prepared = prepareOutput(definition)
  replaceOutput(definition, prepared)
}

export const checkApplicationSynthesis = (definition: ApplicationDefinition) => {
  const prepared = prepareOutput(definition)
  try {
    const trackedDirectory = resolve(repoRoot, definition.outputDir)
    const differences = compareDirectories(prepared.directory, trackedDirectory)
    if (differences.length > 0) {
      throw new Error(`Generated output for ${definition.name} is stale:\n${differences.join('\n')}`)
    }
  } finally {
    prepared.cleanup()
  }
}

const loadManifestFiles = (directory: string): Array<{ readonly source: string; readonly contents: string }> =>
  listFiles(directory)
    .filter((file) => /\.ya?ml$/.test(file) && !/^kustomization\.ya?ml$/.test(basename(file)))
    .map((file) => ({ source: join(directory, file), contents: readFileSync(join(directory, file), 'utf8') }))

const runGit = (arguments_: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', repoRoot, ...arguments_], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${arguments_.join(' ')} failed`)
  }
  return new TextDecoder().decode(result.stdout)
}

const loadBaseline = (
  definition: ApplicationDefinition,
  baseline: string,
): Array<{ readonly source: string; readonly contents: string }> => {
  const localPath = resolve(repoRoot, baseline)
  if (existsSync(localPath)) {
    if (!statSync(localPath).isDirectory()) {
      return [{ source: localPath, contents: readFileSync(localPath, 'utf8') }]
    }
    return loadManifestFiles(localPath).filter(({ source }) => {
      const pathWithinBaseline = relative(localPath, source)
      const firstSegment = pathWithinBaseline.split(/[\\/]/)[0]
      return firstSegment !== 'generated' && !firstSegment.startsWith('.generated.')
    })
  }

  const separator = baseline.indexOf(':')
  const ref = separator === -1 ? baseline : baseline.slice(0, separator)
  const baselinePath =
    separator === -1 ? dirname(definition.outputDir) : baseline.slice(separator + 1).replace(/^\/+/, '')
  const files = runGit(['ls-tree', '-r', '--name-only', ref, '--', baselinePath])
    .split('\n')
    .filter((file) => /\.ya?ml$/.test(file) && !/^kustomization\.ya?ml$/.test(basename(file)))

  if (files.length === 0) throw new Error(`No Kubernetes YAML found at ${ref}:${baselinePath}`)
  return files.map((file) => ({ source: `${ref}:${file}`, contents: runGit(['show', `${ref}:${file}`]) }))
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

const manifestMap = (
  definition: ApplicationDefinition,
  files: Array<{ readonly source: string; readonly contents: string }>,
): Map<string, KubernetesManifest> => {
  const manifests = new Map<string, KubernetesManifest>()
  for (const file of files) {
    for (const document of parseDocuments(file.source, file.contents)) {
      if (
        typeof document === 'object' &&
        document !== null &&
        (document as { kind?: unknown }).kind === 'Kustomization'
      ) {
        continue
      }
      const { manifest, identity } = assertManifest(definition, document)
      const key = identityKey(identity)
      if (manifests.has(key)) throw new Error(`Duplicate resource identity in parity input: ${key}`)
      manifests.set(key, manifest)
    }
  }
  return manifests
}

export const assertApplicationParity = (definition: ApplicationDefinition, baseline: string) => {
  const prepared = prepareOutput(definition)
  try {
    const expected = manifestMap(definition, loadBaseline(definition, baseline))
    const actual = manifestMap(definition, loadManifestFiles(prepared.directory))
    const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort()
    const differences: string[] = []

    for (const key of keys) {
      if (!expected.has(key)) differences.push(`added resource: ${key}`)
      else if (!actual.has(key)) differences.push(`removed resource: ${key}`)
      else if (JSON.stringify(canonicalize(expected.get(key))) !== JSON.stringify(canonicalize(actual.get(key)))) {
        differences.push(`changed resource: ${key}`)
      }
    }

    if (differences.length > 0) {
      throw new Error(`Semantic parity failed for ${definition.name}:\n${differences.join('\n')}`)
    }
  } finally {
    prepared.cleanup()
  }
}

export const __private = {
  compareDirectories,
  listFiles,
  parseDocuments,
  relativeToRepo: (path: string) => relative(repoRoot, path),
  swapPreparedDirectory,
}
