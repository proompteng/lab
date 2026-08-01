import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'

type DependencyGraph = ReadonlyMap<string, readonly string[]>

const serviceRoot = resolve(import.meta.dir, '../../..')
const sourceRoot = resolve(serviceRoot, 'src')
const productionEntrypoints = [
  resolve(sourceRoot, 'cycle-readiness.ts'),
  resolve(sourceRoot, 'cycle-recovery.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-decision-binding.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-decisions.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-model.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-readiness-model.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-readiness.ts'),
  resolve(sourceRoot, 'cycle-runner/recovery-selection.ts'),
  resolve(sourceRoot, 'db/cycle-store/index.ts'),
]

const normalizePath = (file: string): string => file.replaceAll('\\', '/')

const sourcePath = (file: string): string => normalizePath(resolve(file))

const sourceDependencies = (
  file: string,
  imports: Readonly<Record<string, { imports: readonly { path: string }[] }>>,
  sourceFiles: ReadonlySet<string>,
): readonly string[] => {
  const dependencies = imports[file]?.imports ?? []
  return [
    ...new Set(
      dependencies.flatMap(({ path }) => {
        const base = path.startsWith('.')
          ? sourcePath(resolve(dirname(file), path))
          : path.startsWith('/')
            ? sourcePath(path)
            : undefined
        if (base === undefined) return []
        return [base, `${base}.ts`, `${base}/index.ts`].filter((candidate) => sourceFiles.has(candidate))
      }),
    ),
  ]
}

const sourceDependencyGraph = (metafile: Bun.BuildMetafile): DependencyGraph => {
  const sourceFiles = new Set(
    Object.keys(metafile.inputs)
      .map((file) => sourcePath(resolve(serviceRoot, file)))
      .filter((file) => file.startsWith(`${normalizePath(sourceRoot)}/`)),
  )
  const imports = Object.fromEntries(
    Object.entries(metafile.inputs).map(([file, input]) => [sourcePath(resolve(serviceRoot, file)), input]),
  )

  return new Map([...sourceFiles].map((file) => [file, sourceDependencies(file, imports, sourceFiles)]))
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
    if (component.length > 1 || graph.get(file)?.includes(file) === true) components.push(component)
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
  test('keeps cycle-store, readiness, and recovery modules outside import cycles', async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'bayn-cycle-architecture-'))
    try {
      const metafilePath = resolve(outputDirectory, 'metafile.json')
      const build = Bun.spawn(
        [
          process.execPath,
          'build',
          '--external=tigerbeetle-node',
          `--metafile=${metafilePath}`,
          `--outdir=${outputDirectory}`,
          '--target=node',
          ...productionEntrypoints,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ])

      expect(exitCode).toBe(0)
      if (exitCode !== 0) {
        throw new Error([stdout, stderr].filter((output) => output.length > 0).join('\n'))
      }

      const metafile = (await Bun.file(metafilePath).json()) as Bun.BuildMetafile
      const cycles = stronglyConnectedComponents(sourceDependencyGraph(metafile))
        .filter((component) => component.some(isCycleBoundary))
        .map((component) => component.map((file) => relative(sourceRoot, file)).sort())

      expect(cycles).toEqual([])
    } finally {
      await rm(outputDirectory, { force: true, recursive: true })
    }
  })
})
