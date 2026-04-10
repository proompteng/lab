import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JANGAR_RUNTIME_PROFILES } from '../src/server/runtime-profile'

type ModuleStat = {
  path: string
  loc: number
}

type ControlPlaneRouteStat = {
  filePath: string
  routePath: string
  kind: 'page' | 'redirect'
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const serviceRoot = resolve(scriptDir, '..')
const repoRoot = resolve(serviceRoot, '..', '..')
const srcRoot = resolve(serviceRoot, 'src')
const controlPlaneRoutesRoot = resolve(srcRoot, 'routes/control-plane')
const outputPath = resolve(repoRoot, 'docs/jangar/architecture-inventory.md')
const mode = process.argv.includes('--check') ? 'check' : 'write'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/
const GENERATED_FILE_PATTERN = /\.gen\.ts$/

const readSourceFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(root, entry.name)
      if (entry.isDirectory()) return readSourceFiles(entryPath)
      if (!entry.isFile()) return []
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return []
      if (TEST_FILE_PATTERN.test(entry.name)) return []
      if (GENERATED_FILE_PATTERN.test(entry.name)) return []
      return [entryPath]
    }),
  )
  return files.flat().sort()
}

const countLoc = (source: string) => source.split('\n').length

const toRepoPath = (absolutePath: string) => relative(repoRoot, absolutePath).replaceAll('\\', '/')

const toControlPlaneRoutePath = (absolutePath: string) => {
  const repoPath = toRepoPath(absolutePath)
  const relativePath = relative(controlPlaneRoutesRoot, absolutePath).replaceAll('\\', '/')
  const withoutExtension = relativePath.replace(/\.tsx?$/, '')
  const segments = withoutExtension.split('/').filter(Boolean)

  if (segments.at(-1) === 'index') {
    segments.pop()
  }

  return `/control-plane${segments.length > 0 ? `/${segments.join('/')}` : ''}`
}

const readTopModules = async (): Promise<ModuleStat[]> => {
  const files = await readSourceFiles(srcRoot)
  const modules = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf8')
      return {
        path: toRepoPath(filePath),
        loc: countLoc(source),
      } satisfies ModuleStat
    }),
  )

  return modules.sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path)).slice(0, 20)
}

const readControlPlaneRoutes = async (): Promise<ControlPlaneRouteStat[]> => {
  const files = await readSourceFiles(controlPlaneRoutesRoot)
  const routes = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf8')
      const kind = source.includes('throw redirect(') ? 'redirect' : 'page'
      return {
        filePath: toRepoPath(filePath),
        routePath: toControlPlaneRoutePath(filePath),
        kind,
      } satisfies ControlPlaneRouteStat
    }),
  )

  return routes.sort((left, right) => left.routePath.localeCompare(right.routePath))
}

const renderRuntimeProfiles = () => {
  const profiles = Object.values(JANGAR_RUNTIME_PROFILES)
  const lines = [
    '| Profile | `serveClient` | Startup responsibilities |',
    '| --- | --- | --- |',
    ...profiles.map((profile) => {
      const enabledStartup = Object.entries(profile.startup)
        .filter(([, enabled]) => enabled)
        .map(([key]) => `\`${key}\``)
        .join(', ')
      return `| \`${profile.name}\` | \`${profile.serveClient}\` | ${enabledStartup || 'none'} |`
    }),
  ]
  return lines.join('\n')
}

const renderTopModules = (modules: ModuleStat[]) => {
  const lines = [
    '| Rank | Module | LOC |',
    '| --- | --- | ---: |',
    ...modules.map((module, index) => `| ${index + 1} | \`${module.path}\` | ${module.loc} |`),
  ]
  return lines.join('\n')
}

const renderControlPlaneRoutes = (routes: ControlPlaneRouteStat[]) => {
  const supportedRoutes = routes.filter((route) => route.kind === 'page')
  const redirectRoutes = routes.filter((route) => route.kind === 'redirect')

  const renderRouteTable = (items: ControlPlaneRouteStat[]) => {
    if (items.length === 0) return '_None_'

    const lines = [
      '| Route | File |',
      '| --- | --- |',
      ...items.map((route) => `| \`${route.routePath}\` | \`${route.filePath}\` |`),
    ]
    return lines.join('\n')
  }

  return [
    `Summary: ${routes.length} route files, ${supportedRoutes.length} supported pages, ${redirectRoutes.length} redirect-only stubs.`,
    '',
    '#### Supported Pages',
    renderRouteTable(supportedRoutes),
    '',
    '#### Redirect-Only Stubs',
    renderRouteTable(redirectRoutes),
  ].join('\n')
}

const renderDocument = async () => {
  const [topModules, controlPlaneRoutes] = await Promise.all([readTopModules(), readControlPlaneRoutes()])

  return [
    '# Jangar Architecture Inventory',
    '',
    'This file is generated by `bun run --cwd services/jangar docs:inventory:write`.',
    '',
    '## Runtime Profiles',
    '',
    renderRuntimeProfiles(),
    '',
    '## Top 20 Largest App Modules',
    '',
    renderTopModules(topModules),
    '',
    '## Control-Plane Route Surface',
    '',
    renderControlPlaneRoutes(controlPlaneRoutes),
    '',
  ].join('\n')
}

const main = async () => {
  const nextDocument = await renderDocument()

  if (mode === 'check') {
    const currentDocument = await readFile(outputPath, 'utf8').catch(() => null)
    if (currentDocument !== nextDocument) {
      console.error(`[jangar] architecture inventory is stale: ${toRepoPath(outputPath)}`)
      console.error('[jangar] run `bun run --cwd services/jangar docs:inventory:write` and commit the result')
      process.exit(1)
    }
    return
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, nextDocument)
  console.log(`[jangar] wrote ${toRepoPath(outputPath)}`)
}

await main()
