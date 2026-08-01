import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

type DependencyGraph = ReadonlyMap<string, readonly string[]>

const sourceRoot = resolve(import.meta.dir, '../..')

const sourceFilesUnder = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFilesUnder(file)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : []
  })

const resolveSourceImport = (from: string, specifier: string, sourceFiles: ReadonlySet<string>): string | undefined => {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (sourceFiles.has(candidate)) return candidate
  }
  return undefined
}

const sourceDependencies = (file: string, sourceFiles: ReadonlySet<string>): readonly string[] => {
  const source = readFileSync(file, 'utf8')
  const specifiers = [
    ...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g),
    ...source.matchAll(/\bimport\s+["'](\.[^"']+)["']/g),
  ].map((match) => match[1])
  return [...new Set(specifiers.flatMap((specifier) => (specifier === undefined ? [] : [specifier])))]
    .map((specifier) => resolveSourceImport(file, specifier, sourceFiles))
    .filter((dependency): dependency is string => dependency !== undefined)
}

const sourceDependencyGraph = (): DependencyGraph => {
  const sourceFiles = sourceFilesUnder(sourceRoot)
  const sourceFileSet = new Set(sourceFiles)
  return new Map(sourceFiles.map((file) => [file, sourceDependencies(file, sourceFileSet)]))
}

const stronglyConnectedComponents = (graph: DependencyGraph): readonly (readonly string[])[] => {
  let nextIndex = 0
  const stack: string[] = []
  const onStack = new Set<string>()
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const components: string[][] = []

  const visit = (file: string): void => {
    indices.set(file, nextIndex)
    lowLinks.set(file, nextIndex)
    nextIndex += 1
    stack.push(file)
    onStack.add(file)

    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? 0, lowLinks.get(dependency) ?? 0))
      } else if (onStack.has(dependency)) {
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? 0, indices.get(dependency) ?? 0))
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) return
    const component: string[] = []
    let current: string | undefined
    do {
      current = stack.pop()
      if (current === undefined) return
      onStack.delete(current)
      component.push(current)
    } while (current !== file)
    if (component.length > 1) components.push(component)
  }

  for (const file of graph.keys()) {
    if (!indices.has(file)) visit(file)
  }
  return components
}

const isCycleBoundary = (file: string): boolean => {
  const name = relative(sourceRoot, file)
  return (
    name.startsWith('db/cycle-store/') ||
    name === 'cycle-readiness.ts' ||
    name === 'cycle-recovery.ts' ||
    name.startsWith('cycle-runner/recovery-')
  )
}

describe('cycle-store architecture', () => {
  test('keeps cycle-store, readiness, and recovery modules outside import cycles', () => {
    const cycles = stronglyConnectedComponents(sourceDependencyGraph())
      .filter((component) => component.some(isCycleBoundary))
      .map((component) => component.map((file) => relative(sourceRoot, file)).sort())

    expect(cycles).toEqual([])
  })
})
