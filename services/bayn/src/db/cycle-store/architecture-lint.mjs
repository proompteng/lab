import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { API } from 'typescript/unstable/sync'

const lintDirectory = dirname(fileURLToPath(import.meta.url))
const serviceRoot = resolve(lintDirectory, '../../..')
const sourceRoot = resolve(serviceRoot, 'src')
const configFile = resolve(serviceRoot, 'tsconfig.json')

const normalizePath = (file) => resolve(file).replaceAll('\\', '/')
const sourceRootPrefix = `${normalizePath(sourceRoot)}/`
const sourceFiles = (program) =>
  new Set(
    program
      .getSourceFileNames()
      .map(normalizePath)
      .filter((file) => file.startsWith(sourceRootPrefix) && file.endsWith('.ts') && !file.endsWith('.test.ts')),
  )

const resolveSourceDependency = (file, specifier, files) => {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return undefined

  const base = normalizePath(resolve(dirname(file), specifier))
  const extensionlessBase = base.endsWith('.js') ? base.slice(0, -3) : base
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${extensionlessBase}.ts`,
    `${extensionlessBase}.tsx`,
    `${extensionlessBase}.mts`,
    `${extensionlessBase}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.mts`,
    `${base}/index.cts`,
  ].find((candidate) => files.has(candidate))
}

const sourceDependencyGraph = (program) => {
  const files = sourceFiles(program)
  return new Map(
    [...files].map((file) => [
      file,
      [
        ...new Set(
          (program.getSourceFile(file)?.imports ?? [])
            .map((specifier) => resolveSourceDependency(file, specifier.text, files))
            .filter((dependency) => dependency !== undefined),
        ),
      ],
    ]),
  )
}

const stronglyConnectedComponents = (graph) => {
  let nextIndex = 0
  const stack = []
  const onStack = new Set()
  const indices = new Map()
  const lowLinks = new Map()
  const components = []

  const visit = (file) => {
    indices.set(file, nextIndex)
    lowLinks.set(file, nextIndex)
    nextIndex += 1
    stack.push(file)
    onStack.add(file)

    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)))
      } else if (onStack.has(dependency)) {
        lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(dependency)))
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) return
    const component = []
    let current
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

const api = new API({ cwd: serviceRoot })
try {
  const snapshot = api.updateSnapshot({ openProjects: [configFile] })
  try {
    const project = snapshot
      .getProjects()
      .find((candidate) => normalizePath(candidate.configFileName) === normalizePath(configFile))
    if (project === undefined) throw new Error(`TypeScript project was not loaded from ${configFile}`)

    const cycles = stronglyConnectedComponents(sourceDependencyGraph(project.program)).map((component) =>
      component.map((file) => relative(sourceRoot, file).replaceAll('\\', '/')).sort(),
    )

    const result = { cycles }
    if (cycles.length > 0) {
      console.error(JSON.stringify(result, null, 2))
      process.exitCode = 1
    } else {
      console.log(JSON.stringify(result))
    }
  } finally {
    snapshot.dispose()
  }
} finally {
  api.close()
}
