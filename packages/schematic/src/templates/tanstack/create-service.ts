import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execa } from 'execa'
import { dockerCompose, dockerfile, scriptsBuild, scriptsDeploy } from '../../docker'
import { buildWorkflow, ciWorkflow } from '../../github'
import {
  argoBaseKustomization,
  argoOverlay,
  argoRootKustomization,
  clusterDomainClaim,
  domainMapping,
  knativeService,
  postgres,
  redis,
  tailscaleService,
} from '../../kubernetes'
import { drizzleConfig, drizzleSchema } from './drizzle'
import type { GeneratedFile, TanstackServiceOptions } from './types'

type ScaffoldOverride = {
  scaffold?: (opts: TanstackServiceOptions) => Promise<GeneratedFile[]>
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const serviceBaseScripts: Record<string, string> = {
  dev: 'vite dev --host --port 3000',
  build: 'vite build',
  start: 'bun .output/server/index.mjs',
  lint: 'bunx oxfmt --check src',
  'lint:oxlint': 'oxlint --config ../../.oxlintrc.json .',
  'lint:oxlint:type': 'oxlint --config ../../.oxlintrc.json --type-aware --tsconfig ./tsconfig.json .',
  test: 'vitest run',
}

export const mergeTanstackServiceScripts = (
  pkg: Record<string, unknown>,
  options: { enablePostgres?: boolean } = {},
): Record<string, string> => {
  const existingScripts =
    pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, string>)
      : {}

  const scripts: Record<string, string> = {
    ...existingScripts,
    ...serviceBaseScripts,
  }

  if (options.enablePostgres) {
    scripts.generate = 'bunx drizzle-kit generate --config drizzle.config.ts'
    scripts.migrate = 'bunx drizzle-kit push --config drizzle.config.ts'
  }

  return scripts
}

const rootRouteTemplate = (
  name: string,
) => `import { HeadContent, Link, Scripts, createRootRoute } from '@tanstack/react-router'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: '${name} · service' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootLayout,
})

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-md px-3 py-2 ml-3 mt-3 inline-block"
        >
          Skip to content
        </a>
        <div className="border-b border-border/70 bg-card/60 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-3 font-semibold tracking-wide" preload="intent">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary text-sm uppercase">
                ${name.slice(0, 2).toUpperCase()}
              </span>
              <span className="text-lg">${name}</span>
            </Link>
          </div>
        </div>
        <main id="main" className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  )
}
`

const indexRouteTemplate = (
  name: string,
  description?: string,
) => `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="grid gap-6">
      <section className="rounded-2xl border border-border bg-card/70 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Welcome</p>
        <h1 className="mt-2 text-3xl font-semibold">${name}</h1>
        <p className="mt-3 text-muted-foreground">
          ${description ?? 'Start with a clean TanStack Start surface: add your routes in src/routes and wire data sources as needed.'}
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <h2 className="text-lg font-semibold">Example panel</h2>
            <p className="text-sm text-muted-foreground">Replace this block with your first feature or API surface.</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <h2 className="text-lg font-semibold">Routing hint</h2>
            <p className="text-sm text-muted-foreground">
              Create more routes under <code className="align-middle">src/routes</code> and they auto-register.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
`

const tsconfig = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["@types/node", "vite/client"],
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },
    "strict": true
  },
  "include": ["./src"]
}
`

const serviceReadme = (name: string, description?: string) => `# ${name}

${description ?? 'Starter TanStack Start service scaffolded via schematic.'}

## Local development
- bun install --frozen-lockfile
- bun run dev

## Quality
- bun run lint
- bun run test

### Database (if Postgres enabled)
- bun run generate # generate drizzle migrations
- bun run migrate # push migrations

## Build & preview
- bun run build
- bun run start # after build, runs the Nitro output

## Deploy
Use the generated scripts:
- bun run packages/scripts/src/${name}/build-image.ts
- bun run packages/scripts/src/${name}/deploy-service.ts
`

const collectFiles = async (root: string, prefix: string): Promise<GeneratedFile[]> => {
  const files: GeneratedFile[] = []
  const skipFiles = new Set(['bun.lock', '.cta.json', 'biome.json'])
  const skipDirs = new Set(['node_modules', '.vscode'])

  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        if (skipFiles.has(entry.name)) continue
        files.push({
          path: join(prefix, relative(root, fullPath)),
          contents: await readFile(fullPath, 'utf8'),
        })
      }
    }
  }

  await walk(root)
  return files
}

const scaffoldWithTanstackCli = async (opts: TanstackServiceOptions): Promise<GeneratedFile[]> => {
  const tempDir = await mkdtemp(join(tmpdir(), 'schematic-'))
  const targetDir = join(tempDir, opts.name)

  try {
    const args = [
      '@tanstack/start@latest',
      opts.name,
      '--',
      '--no-git',
      '--package-manager',
      'bun',
      '--tailwind',
      '--toolchain',
      'biome',
      '--deployment',
      'nitro',
      '--target-dir',
      targetDir,
    ]

    await execa('npm', ['create', ...args], {
      cwd: tempDir,
      stdio: 'pipe',
      env: { CI: '1', npm_config_yes: 'true' },
      timeout: 120_000,
    })

    await rm(join(targetDir, 'node_modules'), { recursive: true, force: true })
    await rm(join(targetDir, 'bun.lock'), { force: true })
    await rm(join(targetDir, '.cta.json'), { force: true })
    await rm(join(targetDir, 'biome.json'), { force: true })
    await rm(join(targetDir, '.vscode'), { recursive: true, force: true })

    await rm(join(targetDir, 'src', 'data'), { recursive: true, force: true })
    await rm(join(targetDir, 'src', 'routes', 'demo'), { recursive: true, force: true })
    await rm(join(targetDir, 'src', 'components'), { recursive: true, force: true })
    await rm(join(targetDir, 'src', 'logo.svg'), { force: true })

    const images = [
      'tanstack-circle-logo.png',
      'tanstack-word-logo-white.svg',
      'logo192.png',
      'logo512.png',
      'favicon.ico',
      'manifest.json',
    ]
    for (const image of images) {
      await rm(join(targetDir, 'public', image), { force: true })
    }

    await writeFile(join(targetDir, 'src', 'routes', '__root.tsx'), rootRouteTemplate(opts.name), 'utf8')
    await writeFile(
      join(targetDir, 'src', 'routes', 'index.tsx'),
      indexRouteTemplate(opts.name, opts.description),
      'utf8',
    )
    await writeFile(join(targetDir, 'tsconfig.json'), tsconfig, 'utf8')

    const pkgPath = join(targetDir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
    pkg.name = `@proompteng/${opts.name}`
    pkg.version = pkg.version ?? '0.1.0'
    pkg.private = true
    pkg.type = 'module'
    pkg.scripts = mergeTanstackServiceScripts(pkg, { enablePostgres: opts.enablePostgres })

    if (opts.enablePostgres) {
      const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {}
      pkg.dependencies = {
        ...deps,
        'drizzle-orm': deps['drizzle-orm'] ?? '^0.38.0',
        postgres: deps.postgres ?? '^3.4.5',
      }
      const devDeps = (pkg.devDependencies as Record<string, string> | undefined) ?? {}
      pkg.devDependencies = {
        ...devDeps,
        'drizzle-kit': devDeps['drizzle-kit'] ?? '^0.31.7',
      }
    }

    await writeFile(pkgPath, json(pkg), 'utf8')
    await writeFile(join(targetDir, 'README.md'), serviceReadme(opts.name, opts.description), 'utf8')

    if (opts.enablePostgres) {
      await mkdir(join(targetDir, 'src', 'db', 'schema'), { recursive: true })
      await writeFile(join(targetDir, 'drizzle.config.ts'), drizzleConfig(opts.name), 'utf8')
      await writeFile(join(targetDir, 'src', 'db', 'schema', 'app.ts'), drizzleSchema, 'utf8')
      await mkdir(join(targetDir, 'src', 'db', 'migrations'), { recursive: true })
    }

    const robotsPath = join(targetDir, 'public', 'robots.txt')
    try {
      await stat(robotsPath)
    } catch {
      await writeFile(robotsPath, 'User-agent: *\nAllow: /\n', 'utf8')
    }

    return await collectFiles(targetDir, join('services', opts.name))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export const buildTanstackStartService = async (
  opts: TanstackServiceOptions,
  overrides: ScaffoldOverride = {},
): Promise<GeneratedFile[]> => {
  const scaffold = overrides.scaffold ?? scaffoldWithTanstackCli
  const files: GeneratedFile[] = [...(await scaffold(opts))]

  if (opts.includeArgo ?? true) {
    files.push({
      path: join('argocd', 'applications', opts.name, 'kustomization.yaml'),
      contents: argoRootKustomization,
    })
    files.push({
      path: join('argocd', 'applications', opts.name, 'base', 'kustomization.yaml'),
      contents: argoBaseKustomization(opts, !!opts.enablePostgres, !!opts.enableRedis),
    })
    files.push({
      path: join('argocd', 'applications', opts.name, 'base', 'service.yaml'),
      contents: knativeService(opts),
    })
    if (opts.exposure === 'tailscale') {
      files.push({
        path: join('argocd', 'applications', opts.name, 'base', 'tailscale-service.yaml'),
        contents: tailscaleService(opts),
      })
    } else {
      files.push({
        path: join('argocd', 'applications', opts.name, 'base', 'domain-mapping.yaml'),
        contents: domainMapping(opts.name, opts.domain ?? `${opts.name}.proompteng.ai`, opts.namespace ?? opts.name),
      })
      files.push({
        path: join('argocd', 'applications', opts.name, 'base', 'cluster-domain-claim.yaml'),
        contents: clusterDomainClaim(opts.name, opts.domain ?? `${opts.name}.proompteng.ai`),
      })
    }
    files.push({
      path: join('argocd', 'applications', opts.name, 'overlays', 'cluster', 'kustomization.yaml'),
      contents: argoOverlay(opts),
    })
    if (opts.enablePostgres) {
      files.push({
        path: join('argocd', 'applications', opts.name, 'base', 'postgres.yaml'),
        contents: postgres(opts.name, opts.namespace),
      })
    }
    if (opts.enableRedis) {
      files.push({
        path: join('argocd', 'applications', opts.name, 'base', 'redis.yaml'),
        contents: redis(opts.name, opts.namespace),
      })
    }
  }

  const compose = dockerCompose(opts)
  if (compose) {
    files.push({ path: join('services', opts.name, 'docker-compose.yml'), contents: compose })
  }

  if (opts.enablePostgres) {
    files.push({ path: join('services', opts.name, 'drizzle.config.ts'), contents: drizzleConfig(opts.name) })
    files.push({ path: join('services', opts.name, 'src', 'db', 'schema', 'app.ts'), contents: drizzleSchema })
  }

  files.push({ path: join('services', opts.name, 'Dockerfile'), contents: dockerfile(opts.name) })

  if (opts.includeCi ?? true) {
    files.push({ path: join('.github', 'workflows', `${opts.name}-ci.yml`), contents: ciWorkflow(opts.name) })
    files.push({
      path: join('.github', 'workflows', `${opts.name}-build-push.yaml`),
      contents: buildWorkflow(opts.name),
    })
  }

  if (opts.includeScripts ?? true) {
    files.push({
      path: join('packages', 'scripts', 'src', opts.name, 'build-image.ts'),
      contents: scriptsBuild(opts.name),
      executable: true,
    })
    files.push({
      path: join('packages', 'scripts', 'src', opts.name, 'deploy-service.ts'),
      contents: scriptsDeploy(opts.name),
      executable: true,
    })
  }

  return files
}
