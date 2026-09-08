import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JANGAR_RUNTIME_PROFILES } from '../src/server/runtime-profile'

type ModuleStat = {
  path: string
  loc: number
}

export type RouteKind = 'page' | 'handler' | 'redirect'

export type RouteStat = {
  boundary: string
  filePath: string
  routePath: string
  kind: RouteKind
}

type RouteBoundary = {
  name: string
  root: string
  description: string
  include: (relativePath: string) => boolean
}

type ControlPlaneSourceStat = {
  boundary: string
  filePath: string
  loc: number
}

type SourceBoundary = {
  name: string
  root: string
  description: string
  include: (relativePath: string) => boolean
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const serviceRoot = resolve(scriptDir, '..')
const repoRoot = resolve(serviceRoot, '..', '..')
const srcRoot = resolve(serviceRoot, 'src')
const agentsServiceRoot = resolve(repoRoot, 'services/agents')
const agentsSrcRoot = resolve(repoRoot, 'services/agents/src')
const agentsControlPlaneSourcePath = resolve(agentsSrcRoot, 'server/control-plane.ts')
const outputPath = resolve(repoRoot, 'docs/jangar/architecture-inventory.md')
const mode = process.argv.includes('--check') ? 'check' : 'write'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/
const GENERATED_FILE_PATTERN = /\.(?:gen|generated)\.tsx?$/
const FILE_ROUTE_PATTERN = /createFileRoute\(\s*(['"`])([^'"`]+)\1\s*\)/

const readSourceFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
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

const toRelativePath = (root: string, absolutePath: string) => relative(root, absolutePath).replaceAll('\\', '/')

export const extractFileRoutePath = (source: string): string | null => FILE_ROUTE_PATTERN.exec(source)?.[2] ?? null

export const extractRegisteredAgentsRouteFiles = (source: string): string[] => {
  const declaration = 'const routeSources: RouteSourceSpec[] = ['
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error('Agents control-plane routeSources declaration not found')

  const end = source.indexOf('\n]\n\nconst assessAgentRunIngestion', start)
  if (end < 0) throw new Error('Agents control-plane routeSources declaration is not terminated as expected')

  const block = source.slice(start + declaration.length, end)
  const files = [...block.matchAll(/\bfile:\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2]!)
  if (files.length === 0) throw new Error('Agents control-plane routeSources declaration has no route files')

  for (const file of files) {
    if (!file.startsWith('src/routes/')) {
      throw new Error(`Agents control-plane routeSources entry is outside src/routes: ${file}`)
    }
  }

  const duplicates = files.filter((file, index) => files.indexOf(file) !== index)
  if (duplicates.length > 0) {
    throw new Error(
      `Agents control-plane routeSources contains duplicate files: ${[...new Set(duplicates)].join(', ')}`,
    )
  }

  return files
}

export const normalizeRoutePath = (routePath: string) => {
  const trimmed = routePath.trim()
  if (trimmed === '/') return '/'

  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : '/'
}

export const isControlPlaneRoutePath = (routePath: string, boundary: string) => {
  if (boundary === 'Agents UI') return true

  const normalizedPath = normalizeRoutePath(routePath)
  return (
    normalizedPath.includes('/control-plane') ||
    normalizedPath === '/health' ||
    normalizedPath === '/ready' ||
    normalizedPath === '/api/health'
  )
}

const isJangarServerRoutePath = (relativePath: string) =>
  relativePath.startsWith('api/') ||
  relativePath.startsWith('openai/') ||
  /^(?:health|ready)\.tsx?$/.test(relativePath) ||
  relativePath === 'mcp.ts'

const isJangarControlPlaneSourcePath = (relativePath: string) =>
  relativePath === 'app.ts' ||
  relativePath.startsWith('control-plane') ||
  relativePath === 'torghut-simulation-control-plane.ts'

const isAgentsControlPlaneServerPath = (relativePath: string) =>
  relativePath.startsWith('agents-controller/') ||
  relativePath.startsWith('v1/control-plane-') ||
  relativePath === 'health.ts' ||
  relativePath === 'metrics.ts' ||
  relativePath === 'ready.ts' ||
  relativePath === 'start-runtime.ts' ||
  relativePath === 'orchestration-controller.ts' ||
  relativePath === 'supporting-primitives-controller.ts' ||
  relativePath.startsWith('control-plane')

const routeBoundaries: RouteBoundary[] = [
  {
    name: 'Jangar HTTP',
    root: resolve(srcRoot, 'routes'),
    description:
      '`services/jangar/src/server/app.ts` import globs (`api/**`, `openai/**`, `health.tsx`, `ready.tsx`, and `mcp.ts`)',
    include: isJangarServerRoutePath,
  },
  {
    name: 'Jangar UI',
    root: resolve(srcRoot, 'routes'),
    description: '`services/jangar/src/routes/**` TanStack file-route declarations',
    include: () => true,
  },
  {
    name: 'Agents HTTP',
    root: resolve(agentsSrcRoot, 'routes'),
    description: '`services/agents/src/server/control-plane.ts` routeSources under `services/agents/src/routes/**`',
    include: () => true,
  },
  {
    name: 'Agents UI',
    root: resolve(agentsSrcRoot, 'app-routes'),
    description: '`services/agents/src/app-routes/**` TanStack Start control-plane UI route declarations',
    include: () => true,
  },
]

const controlPlaneSourceBoundaries: SourceBoundary[] = [
  {
    name: 'Jangar control-plane server',
    root: resolve(srcRoot, 'server'),
    description: '`services/jangar/src/server/app.ts`, `control-plane*.ts`, and `torghut-simulation-control-plane.ts`',
    include: isJangarControlPlaneSourcePath,
  },
  {
    name: 'Jangar control-plane routes',
    root: resolve(srcRoot, 'routes'),
    description:
      '`services/jangar/src/routes/ready.tsx`, `torghut/control-plane*`, and `api/torghut/trading/control-plane/**`',
    include: (relativePath) =>
      relativePath === 'ready.tsx' ||
      relativePath.startsWith('torghut/control-plane') ||
      relativePath.startsWith('api/torghut/trading/control-plane/'),
  },
  {
    name: 'Agents control-plane server',
    root: resolve(agentsSrcRoot, 'server'),
    description:
      '`services/agents/src/server/control-plane*`, health/readiness/runtime bridge, controller, and versioned control-plane modules',
    include: isAgentsControlPlaneServerPath,
  },
  {
    name: 'Agents control-plane HTTP routes',
    root: resolve(agentsSrcRoot, 'routes'),
    description: '`services/agents/src/routes/v1/control-plane/**` registered HTTP handlers',
    include: (relativePath) => relativePath.startsWith('v1/control-plane/'),
  },
  {
    name: 'Agents control-plane UI routes',
    root: resolve(agentsSrcRoot, 'app-routes'),
    description: '`services/agents/src/app-routes/**` control-plane web entry and primitive routes',
    include: () => true,
  },
  {
    name: 'Agents control-plane UI modules',
    root: agentsSrcRoot,
    description: '`services/agents/src/components/control-plane/**` and `services/agents/src/control-plane/**`',
    include: (relativePath) =>
      relativePath.startsWith('components/control-plane/') || relativePath.startsWith('control-plane/'),
  },
]

const renderMarkdownTable = (
  rows: string[][],
  options: {
    align?: ('left' | 'right')[]
  } = {},
) => {
  if (rows.length === 0) return ''
  const align = options.align ?? rows[0]!.map(() => 'left')
  const widths = rows[0]!.map((_, columnIndex) =>
    rows.reduce((max, row) => Math.max(max, row[columnIndex]?.length ?? 0), 0),
  )

  const formatCell = (value: string, columnIndex: number) => {
    const width = widths[columnIndex] ?? value.length
    return align[columnIndex] === 'right' ? value.padStart(width) : value.padEnd(width)
  }

  const divider = widths.map((width, columnIndex) => {
    const dashCount = Math.max(3, width)
    if (align[columnIndex] === 'right') {
      return `${'-'.repeat(Math.max(3, dashCount - 1))}:`
    }
    return '-'.repeat(dashCount)
  })

  return [rows[0], divider, ...rows.slice(1)]
    .map((row) => `| ${row.map((cell, columnIndex) => formatCell(cell, columnIndex)).join(' | ')} |`)
    .join('\n')
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

export const classifyControlPlaneRouteSource = (source: string): 'page' | 'redirect' =>
  /\bthrow\s+redirect\s*\(/.test(source) || source.includes('ControlPlaneRedirect') || /<Navigate\b/.test(source)
    ? 'redirect'
    : 'page'

export const classifyRouteSource = (source: string, routePath: string): RouteKind => {
  if (classifyControlPlaneRouteSource(source) === 'redirect') return 'redirect'

  return /\bserver\s*:\s*\{/.test(source) || routePath.startsWith('/api/') || routePath.startsWith('/openai/')
    ? 'handler'
    : 'page'
}

export const readRoutes = async (): Promise<RouteStat[]> => {
  const routes: RouteStat[] = []
  const registeredAgentsRouteFiles = extractRegisteredAgentsRouteFiles(
    await readFile(agentsControlPlaneSourcePath, 'utf8'),
  ).map((file) => resolve(agentsServiceRoot, file))

  for (const boundary of routeBoundaries) {
    const files = boundary.name === 'Agents HTTP' ? registeredAgentsRouteFiles : await readSourceFiles(boundary.root)
    const boundaryRoutes = await Promise.all(
      files
        .filter((filePath) => boundary.include(toRelativePath(boundary.root, filePath)))
        .map(async (filePath) => {
          const source = await readFile(filePath, 'utf8')
          const declaredPath = extractFileRoutePath(source)
          if (!declaredPath) {
            if (boundary.name === 'Agents HTTP') {
              throw new Error(`Registered Agents route does not declare createFileRoute(...): ${toRepoPath(filePath)}`)
            }
            return null
          }

          const routePath = normalizeRoutePath(declaredPath)
          return {
            boundary: boundary.name,
            filePath: toRepoPath(filePath),
            routePath,
            kind: classifyRouteSource(source, routePath),
          } satisfies RouteStat
        }),
    )
    routes.push(...boundaryRoutes.filter((route): route is RouteStat => route !== null))
  }

  return routes.sort(
    (left, right) =>
      left.boundary.localeCompare(right.boundary) ||
      left.routePath.localeCompare(right.routePath) ||
      left.filePath.localeCompare(right.filePath),
  )
}

const readControlPlaneSources = async (): Promise<ControlPlaneSourceStat[]> => {
  const sources: ControlPlaneSourceStat[] = []

  for (const boundary of controlPlaneSourceBoundaries) {
    const files = await readSourceFiles(boundary.root)
    const boundarySources = await Promise.all(
      files
        .filter((filePath) => boundary.include(toRelativePath(boundary.root, filePath)))
        .map(async (filePath) => ({
          boundary: boundary.name,
          filePath: toRepoPath(filePath),
          loc: countLoc(await readFile(filePath, 'utf8')),
        })),
    )
    sources.push(...boundarySources)
  }

  return sources.sort(
    (left, right) => left.boundary.localeCompare(right.boundary) || left.filePath.localeCompare(right.filePath),
  )
}

const renderRuntimeProfiles = () => {
  const profiles = Object.values(JANGAR_RUNTIME_PROFILES)
  const rows = [
    ['Profile', '`serveClient`', 'Startup responsibilities'],
    ...profiles.map((profile) => {
      const enabledStartup = Object.entries(profile.startup)
        .filter(([, enabled]) => enabled)
        .map(([key]) => `\`${key}\``)
        .join(', ')
      return [`\`${profile.name}\``, `\`${profile.serveClient}\``, enabledStartup || 'none']
    }),
  ]
  return renderMarkdownTable(rows)
}

const routeKindCount = (routes: RouteStat[], kind: RouteKind) => routes.filter((route) => route.kind === kind).length

const renderRouteSurfaceSummary = (routes: RouteStat[]) => {
  const rows = [
    ['Surface', 'Source boundary', 'Route files', 'Pages', 'HTTP handlers', 'Redirects'],
    ...routeBoundaries.map((boundary) => {
      const boundaryRoutes = routes.filter((route) => route.boundary === boundary.name)
      return [
        boundary.name,
        boundary.description,
        `${boundaryRoutes.length}`,
        `${routeKindCount(boundaryRoutes, 'page')}`,
        `${routeKindCount(boundaryRoutes, 'handler')}`,
        `${routeKindCount(boundaryRoutes, 'redirect')}`,
      ]
    }),
  ]
  return renderMarkdownTable(rows, { align: ['left', 'left', 'right', 'right', 'right', 'right'] })
}

const renderTopModules = (modules: ModuleStat[]) => {
  const rows = [
    ['Rank', 'Module', 'LOC'],
    ...modules.map((module, index) => [`${index + 1}`, `\`${module.path}\``, `${module.loc}`]),
  ]
  return renderMarkdownTable(rows, { align: ['left', 'left', 'right'] })
}

const renderControlPlaneRoutes = (routes: RouteStat[]) => {
  const controlPlaneRoutes = routes.filter((route) => isControlPlaneRoutePath(route.routePath, route.boundary))
  const renderRouteTable = (items: RouteStat[]) => {
    if (items.length === 0) return '_None_'

    return renderMarkdownTable([
      ['Route', 'Kind', 'File'],
      ...items.map((route) => [`\`${route.routePath}\``, `\`${route.kind}\``, `\`${route.filePath}\``]),
    ])
  }

  return [
    `Summary: ${controlPlaneRoutes.length} route declarations, ${routeKindCount(controlPlaneRoutes, 'page')} pages, ${routeKindCount(controlPlaneRoutes, 'handler')} HTTP handlers, and ${routeKindCount(controlPlaneRoutes, 'redirect')} redirect-only stubs.`,
    '',
    'Routes are read from current `createFileRoute(...)` declarations. Agents UI routes are included because the Agents Start bundle is the control-plane web surface; direct `/health` and `/ready` handlers are represented in the source-boundary inventory below.',
    '',
    ...routeBoundaries.flatMap((boundary) => {
      const boundaryRoutes = controlPlaneRoutes.filter((route) => route.boundary === boundary.name)
      return [
        `#### ${boundary.name}`,
        '',
        `Boundary: ${boundary.description}`,
        '',
        renderRouteTable(boundaryRoutes),
        '',
      ]
    }),
  ]
    .join('\n')
    .trimEnd()
}

const renderControlPlaneSources = (sources: ControlPlaneSourceStat[]) => {
  const totalLoc = sources.reduce((total, source) => total + source.loc, 0)
  const renderSourceTable = (items: ControlPlaneSourceStat[]) => {
    if (items.length === 0) return '_None_'

    return renderMarkdownTable(
      [['File', 'LOC'], ...items.map((source) => [`\`${source.filePath}\``, `${source.loc}`])],
      { align: ['left', 'right'] },
    )
  }

  return [
    `Summary: ${sources.length} control-plane source files, ${totalLoc} LOC across ${controlPlaneSourceBoundaries.length} current boundaries.`,
    '',
    'Tests (`*.test.*`, `*.spec.*`) and generated (`*.gen.*`, `*.generated.*`) source are excluded from these structural counts.',
    '',
    ...controlPlaneSourceBoundaries.flatMap((boundary) => {
      const boundarySources = sources.filter((source) => source.boundary === boundary.name)
      return [
        `#### ${boundary.name}`,
        '',
        `Boundary: ${boundary.description}`,
        '',
        renderSourceTable(boundarySources),
        '',
      ]
    }),
  ]
    .join('\n')
    .trimEnd()
}

const renderDocument = async () => {
  const [topModules, routes, controlPlaneSources] = await Promise.all([
    readTopModules(),
    readRoutes(),
    readControlPlaneSources(),
  ])

  return [
    '# Jangar Architecture Inventory',
    '',
    'This file is generated by `bun run --cwd services/jangar docs:inventory:write`.',
    '',
    '## Runtime Profiles',
    '',
    renderRuntimeProfiles(),
    '',
    '## Route Boundaries',
    '',
    'The inventory keeps the Jangar HTTP registration boundary separate from its UI route tree and records both the Agents HTTP handlers and the Agents Start control-plane UI routes.',
    '',
    renderRouteSurfaceSummary(routes),
    '',
    '## Top 20 Largest Jangar App Modules',
    '',
    renderTopModules(topModules),
    '',
    '## Control-Plane Route Surface',
    '',
    renderControlPlaneRoutes(routes),
    '',
    '## Control-Plane Source Boundaries',
    '',
    renderControlPlaneSources(controlPlaneSources),
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

if (import.meta.main) {
  await main()
}
