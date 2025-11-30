import { join } from 'node:path'

export type TanstackServiceOptions = {
  name: string
  description?: string
  owner?: string
  domain?: string
  namespace?: string
  exposure?: 'external-dns' | 'tailscale'
  tailscaleHostname?: string
  imageRegistry: string
  imageRepository?: string
  imageTag?: string
  port?: number
  enablePostgres?: boolean
  enableRedis?: boolean
  includeCi?: boolean
  includeArgo?: boolean
  includeScripts?: boolean
}

export type GeneratedFile = {
  path: string
  contents: string
  executable?: boolean
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const defaultDeps = {
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  '@tanstack/react-router': '^1.140.0',
  '@tanstack/react-query': '^5.91.0',
  '@tanstack/react-query-devtools': '^5.91.0',
  '@tanstack/router-devtools': '^1.140.0',
  '@tanstack/router-core': '^1.140.0',
  zod: '^3.23.8',
  'class-variance-authority': '^0.7.1',
  'tailwind-merge': '^3.4.0',
  'tailwindcss-animate': '^1.0.7',
  'lucide-react': '^0.469.0',
  '@radix-ui/react-slot': '^1.2.4',
  '@radix-ui/react-toast': '^1.2.6',
}

const defaultDevDeps = {
  typescript: '^5.9.3',
  '@types/node': '^22.9.4',
  '@types/react': '^18.3.11',
  '@types/react-dom': '^18.3.0',
  vite: '^6.0.2',
  'vite-tsconfig-paths': '^5.1.1',
  '@vitejs/plugin-react': '^4.3.4',
  '@tanstack/router-vite-plugin': '^1.140.0',
  '@tailwindcss/vite': '^4.1.17',
  tailwindcss: '^4.1.17',
  vitest: '^2.1.4',
  '@testing-library/react': '^16.1.0',
  '@testing-library/jest-dom': '^6.6.3',
  'bun-types': '^1.1.20',
}

const uiButton = `import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  },
)
Button.displayName = 'Button'
`

const uiCard = `import * as React from 'react'
import { cn } from '@/lib/utils'

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('rounded-xl border bg-card text-card-foreground shadow', className)} {...props} />,
)
Card.displayName = 'Card'

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />,
)
CardHeader.displayName = 'CardHeader'

export const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  ),
)
CardTitle.displayName = 'CardTitle'

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />,
)
CardContent.displayName = 'CardContent'
`

const utils = `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
`

const appCss = `@import "tailwindcss";

:root {
  --background: 255 100% 100%;
  --foreground: 222 47% 11%;
  --card: 0 0% 100%;
  --card-foreground: 222 47% 11%;
  --popover: 0 0% 100%;
  --popover-foreground: 222 47% 11%;
  --primary: 221 83% 53%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96%;
  --secondary-foreground: 222 47% 11%;
  --muted: 210 40% 96%;
  --muted-foreground: 215 16% 47%;
  --accent: 210 40% 96%;
  --accent-foreground: 222 47% 11%;
  --destructive: 0 84% 60%;
  --destructive-foreground: 210 40% 98%;
  --border: 214 32% 91%;
  --input: 214 32% 91%;
  --ring: 221 83% 53%;
  --radius: 0.5rem;
}

@theme inline {
  --background: hsl(var(--background));
  --foreground: hsl(var(--foreground));
  --card: hsl(var(--card));
  --card-foreground: hsl(var(--card-foreground));
  --popover: hsl(var(--popover));
  --popover-foreground: hsl(var(--popover-foreground));
  --primary: hsl(var(--primary));
  --primary-foreground: hsl(var(--primary-foreground));
  --secondary: hsl(var(--secondary));
  --secondary-foreground: hsl(var(--secondary-foreground));
  --muted: hsl(var(--muted));
  --muted-foreground: hsl(var(--muted-foreground));
  --accent: hsl(var(--accent));
  --accent-foreground: hsl(var(--accent-foreground));
  --destructive: hsl(var(--destructive));
  --destructive-foreground: hsl(var(--destructive-foreground));
  --border: hsl(var(--border));
  --input: hsl(var(--input));
  --ring: hsl(var(--ring));
}

@custom-variant dark (&:is(.dark *));

@layer base {
  * {
    @apply border-border;
  }

  body {
    @apply min-h-screen bg-background text-foreground antialiased;
  }
}
`

const rootRoute = (name: string) => `import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/toaster'
import '@/app.css'

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="h-10 w-10 rounded-full bg-primary/10 text-primary grid place-items-center font-bold">{${JSON.stringify(
              name,
            )}.slice(0, 2).toUpperCase()}</span>
            <div>
              <p className="text-sm text-muted-foreground">Service</p>
              <p className="text-lg font-semibold">${name}</p>
            </div>
          </div>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link to="/" className="hover:text-foreground" preload="intent">
              Home
            </Link>
            <Link to="/health" className="hover:text-foreground" preload="intent">
              Health
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Outlet />
      </main>
      <Toaster />
    </div>
  ),
})
`

const indexRoute = `import { createRoute } from '@tanstack/react-router'
import { Route as RootRoute } from './__root'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm uppercase tracking-wide text-muted-foreground">Welcome</p>
        <h1 className="text-3xl font-semibold">TanStack Start starter</h1>
        <p className="max-w-2xl text-muted-foreground">
          This service ships with Tailwind CSS v4, shadcn/ui primitives, Knative-ready health endpoints, and optional
          Postgres/Redis integrations.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Next steps</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
            <li>Wire your API routes and connect to Postgres/Redis if enabled.</li>
            <li>Run <code className="rounded bg-muted px-2 py-1">bun dev</code> for local development.</li>
            <li>Use the build + deploy scripts under packages/scripts to publish a Knative revision.</li>
          </ul>
          <div className="mt-4 flex gap-3">
            <Button asChild>
              <a href="/health" className="no-underline">
                Check health endpoint
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href="https://tanstack.com/router/latest" className="no-underline" target="_blank" rel="noreferrer">
                TanStack Router docs
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  ),
})
`

const healthRoute = `import { createRoute } from '@tanstack/react-router'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: 'health',
  component: () => (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <p className="text-sm font-medium text-muted-foreground">Health</p>
      <pre className="mt-4 rounded-lg bg-muted p-4 text-sm">
        {JSON.stringify({ status: 'ok' }, null, 2)}
      </pre>
    </div>
  ),
})
`

const router = `import { QueryClient } from '@tanstack/react-query'
import { createBrowserHistory, createRouter } from '@tanstack/react-router'
import { Route as rootRoute } from './routes/__root'
import { Route as indexRoute } from './routes/_index'
import { Route as healthRoute } from './routes/health'

export type RouterContext = {
  queryClient: QueryClient
}

export const routeTree = rootRoute.addChildren([indexRoute, healthRoute])

export const createAppRouter = (queryClient = new QueryClient()) =>
  createRouter({
    routeTree,
    context: { queryClient },
    history: createBrowserHistory(),
    defaultPreload: 'intent',
  })

export const router = createAppRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
`

const entryClient = `import { StrictMode } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createAppRouter } from './router'

const queryClient = new QueryClient()
const clientRouter = createAppRouter(queryClient)

const rootElement = document.getElementById('app')
if (!rootElement) {
  throw new Error('Root element #app not found')
}

const render = async () => {
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={clientRouter} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

render()
`

const startConfig = `import { defineConfig } from '@tanstack/router-vite-plugin'

export default defineConfig({
  ssr: false,
  srcDir: './src',
})
`

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
    <title>TanStack Start service</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/entry-client.tsx"></script>
  </body>
</html>
`

const viteConfig = `import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tailwindcss(), tsconfigPaths(), react()],
  server: {
    port: 3000,
    host: true,
  },
  preview: {
    port: 3000,
    host: true,
  },
})
`

const tsconfig = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@types/node"],
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "resolveJsonModule": true,
    "allowJs": false,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/app/*"],
      "~/*": ["./src/*"]
    }
  },
  "include": ["./src"]
}
`

const dockerfile = (name: string) => `# syntax=docker/dockerfile:1.6
ARG BUN_VERSION=1.3.3
FROM oven/bun:${'$'}{BUN_VERSION} AS builder
WORKDIR /workspace

# Leverage workspace lockfile for reproducible installs
COPY bun.lock package.json tsconfig.base.json turbo.json tsconfig.json ./
COPY services/${name}/package.json ./services/${name}/package.json
COPY services/${name}/tsconfig.json ./services/${name}/tsconfig.json
RUN bun install --frozen-lockfile --filter @proompteng/${name}

COPY services/${name} ./services/${name}
RUN cd services/${name} && bun run build

FROM oven/bun:${'$'}{BUN_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /workspace/services/${name} ./
RUN bun install --production --frozen-lockfile --filter @proompteng/${name}

EXPOSE 3000
CMD ["bun", "run", "preview"]
`

const dockerCompose = (opts: TanstackServiceOptions) => {
  const services: string[] = []

  if (opts.enablePostgres) {
    services.push(`  db:
    image: postgres:16
    container_name: ${opts.name}-db
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped`)
  }

  if (opts.enableRedis) {
    services.push(`  redis:
    image: redis:7-alpine
    container_name: ${opts.name}-redis
    ports:
      - "6379:6379"
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped`)
  }

  if (services.length === 0) {
    return undefined
  }

  return `version: "3.9"

services:
${services.join('\n\n')}

volumes:
  db_data:
    driver: local
`
}

const serviceReadme = (name: string, description?: string) => `# ${name}

${description ?? 'TanStack Start + Tailwind v4 + shadcn/ui skeleton.'}

## Local development
- bun install --frozen-lockfile
- bun dev

### Optional: local dependencies
- docker compose -f services/${name}/docker-compose.yml up -d # starts Postgres/Redis if present

## Build & preview
- bun run build
- bun run preview

## Deploy
Use the generated scripts:
- bun run packages/scripts/src/${name}/build-image.ts
- bun run packages/scripts/src/${name}/deploy-service.ts
`

const knativeService = (opts: TanstackServiceOptions) => {
  const envLines: string[] = ['            - name: PORT', '              value: "3000"']
  if (opts.enablePostgres) {
    envLines.push(
      '            - name: DATABASE_URL',
      '              valueFrom:',
      '                secretKeyRef:',
      `                  name: ${opts.name}-db-superuser`,
      '                  key: uri',
    )
  }
  if (opts.enableRedis) {
    envLines.push(
      '            - name: REDIS_URL',
      '              valueFrom:',
      '                secretKeyRef:',
      `                  name: ${opts.name}-redis`,
      '                  key: url',
    )
  }

  const visibilityAnnotation =
    opts.exposure === 'tailscale' ? '    networking.knative.dev/visibility: cluster-local\n' : ''

  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${opts.name}
  namespace: ${opts.namespace ?? opts.name}
  labels:
    app.kubernetes.io/name: ${opts.name}
    app.kubernetes.io/component: web
    app.kubernetes.io/part-of: lab
  annotations:
${visibilityAnnotation}    autoscaling.knative.dev/minScale: "1"
    serving.knative.dev/rollout-duration: "10s"
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/target: "80"
    spec:
      containerConcurrency: 0
      timeoutSeconds: 60
      serviceAccountName: default
      containers:
        - name: ${opts.name}
          image: ${opts.name}
          imagePullPolicy: Always
          ports:
            - containerPort: ${opts.port ?? 3000}
              name: http1
          env:
${envLines.map((l) => `${l}`).join('\n')}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            seccompProfile:
              type: RuntimeDefault
          livenessProbe:
            httpGet:
              path: /health
          readinessProbe:
            httpGet:
              path: /health
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
            requests:
              cpu: 250m
              memory: 256Mi
`
}

const domainMapping = (name: string, domain?: string, namespace?: string) => `apiVersion: serving.knative.dev/v1beta1
kind: DomainMapping
metadata:
  name: ${domain ?? `${name}.proompteng.ai`}
  namespace: ${namespace ?? name}
spec:
  ref:
    name: ${name}
    kind: Service
    apiVersion: serving.knative.dev/v1
`

const clusterDomainClaim = (name: string, domain?: string) => `apiVersion: networking.internal.knative.dev/v1alpha1
kind: ClusterDomainClaim
metadata:
  name: ${domain ?? `${name}.proompteng.ai`}
spec:
  namespace: ${name}
`

const tailscaleService = (opts: TanstackServiceOptions) => `apiVersion: v1
kind: Service
metadata:
  name: ${opts.name}-tailscale
  namespace: ${opts.namespace ?? opts.name}
  annotations:
    tailscale.com/hostname: ${opts.tailscaleHostname ?? opts.name}
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    serving.knative.dev/service: ${opts.name}
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP
`

const argoBaseKustomization = (opts: TanstackServiceOptions, includePostgres: boolean, includeRedis: boolean) => {
  const resources = ['service.yaml']
  if (opts.exposure === 'tailscale') {
    resources.push('tailscale-service.yaml')
  } else {
    resources.push('domain-mapping.yaml', 'cluster-domain-claim.yaml')
  }
  if (includePostgres) resources.push('postgres.yaml')
  if (includeRedis) resources.push('redis.yaml')
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${opts.namespace ?? opts.name}
resources:
  - ${resources.join('\n  - ')}
`
}

const argoRootKustomization = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - base
  - overlays/cluster
`

const argoOverlay = (opts: TanstackServiceOptions) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
images:
  - name: ${opts.name}
    newName: ${opts.imageRegistry}/${opts.imageRepository ?? `lab/${opts.name}`}
    newTag: ${opts.imageTag ?? 'main'}
`

const postgres = (name: string, namespace?: string) => `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${name}-db
  namespace: ${namespace ?? name}
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  storage:
    size: 10Gi
  superuserSecret:
    name: ${name}-db-superuser
  enableSuperuserAccess: true
  monitoring:
    enablePodMonitor: true
---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}-db-superuser
  namespace: ${namespace ?? name}
type: Opaque
stringData:
  username: postgres
  password: change-me
  uri: postgresql://postgres:change-me@${name}-db-rw:5432/postgres
`

const redis = (name: string, namespace?: string) => `apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: Redis
metadata:
  name: ${name}-redis
  namespace: ${namespace ?? name}
spec:
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.15
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
  podSecurityContext:
    fsGroup: 1000
    fsGroupChangePolicy: Always
  redisExporter:
    enabled: true
    image: quay.io/opstree/redis-exporter:v1.78.0
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi
        storageClassName: longhorn
---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}-redis
  namespace: ${namespace ?? name}
type: Opaque
stringData:
  url: redis://${name}-redis:6379
`

const ciWorkflow = (name: string) => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const workflowExpr = '${{ github.workflow }}'
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const refExpr = '${{ github.ref }}'
  return `name: ${name}-ci

on:
  pull_request:
    paths:
      - 'services/${name}/**'
      - 'packages/scripts/src/${name}/**'
      - 'argocd/applications/${name}/**'
      - '.github/workflows/${name}-ci.yml'

concurrency:
  group: ${workflowExpr}-${refExpr}
  cancel-in-progress: true

jobs:
  lint-test-build:
    uses: ./.github/workflows/common-monorepo.yml
    with:
      install-command: bun install --frozen-lockfile
      lint-command: bunx biome check services/${name} packages/scripts/src/${name} argocd/applications/${name}
      test-command: cd services/${name} && bun test
      build-command: cd services/${name} && bun run build
`
}

const buildWorkflow = (name: string) => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const shaExpr = '${{ github.sha }}'
  return `name: ${name}-build-push

on:
  push:
    branches:
      - main
    paths:
      - 'services/${name}/**'
      - 'packages/scripts/src/${name}/**'
      - 'argocd/applications/${name}/**'
      - '.github/workflows/${name}-build-push.yaml'
  workflow_dispatch:

jobs:
  docker:
    uses: ./.github/workflows/docker-build-common.yaml
    with:
      image_name: ${name}
      dockerfile: services/${name}/Dockerfile
      context: .
      new_tag: ${shaExpr}
      platforms: linux/arm64
`
}

const scriptsBuild = (name: string) => `#!/usr/bin/env bun
import { resolve } from 'node:path'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'
import { repoRoot } from '../shared/cli'

const registry = process.env.IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.IMAGE_REPOSITORY ?? 'lab/${name}'
const tag = process.env.IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
const context = resolve(repoRoot, '.')
const dockerfile = resolve(repoRoot, 'services/${name}/Dockerfile')

await buildAndPushDockerImage({
  registry,
  repository,
  tag,
  context,
  dockerfile,
  platforms: ['linux/arm64'],
})

console.log('Built and pushed ' + registry + '/' + repository + ':' + tag)
`

const scriptsDeploy = (name: string) => `#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const registry = process.env.IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.IMAGE_REPOSITORY ?? 'lab/${name}'
const tag = process.env.IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])

const image = registry + '/' + repository + ':' + tag
const digest = (() => {
  try {
    return inspectImageDigest(image)
  } catch (error) {
    console.warn('Could not resolve digest, continuing with tag only', error)
    return undefined
  }
})()

const kustomizePath = resolve(repoRoot, 'argocd/applications/${name}/overlays/cluster/kustomization.yaml')
let kustomization = readFileSync(kustomizePath, 'utf8')
kustomization = kustomization.replace(/newTag: .*/g, 'newTag: ' + tag)
if (digest) {
  if (kustomization.includes('digest:')) {
    kustomization = kustomization.replace(/digest: .*/g, 'digest: ' + digest)
  } else {
    kustomization = kustomization.replace(/(newTag: .*)/g, '$1\\n    digest: ' + digest)
  }
}

writeFileSync(kustomizePath, kustomization)

await run('kubectl', ['apply', '-k', 'argocd/applications/${name}/overlays/cluster'], { cwd: repoRoot })
console.log('Updated kustomization and applied overlay for ${name}')
`

const componentsJson = `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": 
    "config": "",
    "css": "src/app/app.css",
    "baseColor": "zinc",
    "cssVariables": true,
    "prefix": "",
  "iconLibrary": "lucide",
  "aliases": 
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks",
  "registries": 
}
`

export const buildTanstackStartService = (opts: TanstackServiceOptions): GeneratedFile[] => {
  const name = opts.name
  const namespace = opts.namespace ?? name
  const exposure = opts.exposure ?? 'external-dns'
  const domain = opts.domain ?? `${name}.proompteng.ai`
  const files: GeneratedFile[] = []

  const pkg = {
    name: `@proompteng/${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'bun --bun vite dev --host --port 3000',
      build: 'bun --bun vite build',
      preview: 'bun --bun vite preview --host --port 3000',
      lint: 'bunx biome check .',
      test: 'vitest',
    },
    dependencies: defaultDeps,
    devDependencies: defaultDevDeps,
  }

  files.push({ path: join('services', name, 'package.json'), contents: json(pkg) })
  files.push({ path: join('services', name, 'tsconfig.json'), contents: tsconfig })
  files.push({ path: join('services', name, 'vite.config.ts'), contents: viteConfig })
  files.push({ path: join('services', name, 'start.config.ts'), contents: startConfig })
  files.push({ path: join('services', name, 'index.html'), contents: indexHtml })
  files.push({ path: join('services', name, 'src', 'router.tsx'), contents: router })
  files.push({ path: join('services', name, 'src', 'entry-client.tsx'), contents: entryClient })
  files.push({ path: join('services', name, 'src', 'app.css'), contents: appCss })
  files.push({ path: join('services', name, 'src', 'app.d.ts'), contents: "/// <reference types='vite/client' />\n" })
  files.push({ path: join('services', name, 'src', 'routes', '__root.tsx'), contents: rootRoute(name) })
  files.push({ path: join('services', name, 'src', 'routes', '_index.tsx'), contents: indexRoute })
  files.push({ path: join('services', name, 'src', 'routes', 'health.tsx'), contents: healthRoute })
  files.push({ path: join('services', name, 'src', 'components', 'ui', 'button.tsx'), contents: uiButton })
  files.push({ path: join('services', name, 'src', 'components', 'ui', 'card.tsx'), contents: uiCard })
  files.push({
    path: join('services', name, 'src', 'components', 'ui', 'toaster.tsx'),
    contents: `import * as React from 'react'
import { Toast, ToastAction, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from './toast-primitives'

export const Toaster = () => (
  <ToastProvider>
    <ToastViewport />
    <Toast>
      <div className="grid gap-1">
        <ToastTitle>Heads up</ToastTitle>
        <ToastDescription>Use this toaster for inline status.</ToastDescription>
      </div>
      <ToastAction altText="Dismiss">Close</ToastAction>
      <ToastClose />
    </Toast>
  </ToastProvider>
)
`,
  })
  files.push({
    path: join('services', name, 'src', 'components', 'ui', 'toast-primitives.tsx'),
    contents: `import * as React from 'react'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const ToastProvider = ToastPrimitive.Provider
const ToastViewport = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Viewport>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>>(
  ({ className, ...props }, ref) => (
    <ToastPrimitive.Viewport
      ref={ref}
      className={cn(
        'fixed top-0 right-0 z-[100] flex max-h-screen w-full max-w-sm flex-col gap-2 p-4 sm:top-auto sm:bottom-0 sm:right-0',
        className,
      )}
      {...props}
    />
  ),
)
ToastViewport.displayName = ToastPrimitive.Viewport.displayName

const toastVariants = cva(
  'group pointer-events-auto relative grid w-full items-center gap-1 overflow-hidden rounded-md border bg-background p-4 shadow-lg transition-all',
  {
    variants: {
      variant: {
        default: 'border border-border bg-background text-foreground',
        destructive: 'destructive group border-destructive/50 bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

const Toast = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Root>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>>(
  ({ className, variant, ...props }, ref) => (
    <ToastPrimitive.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
  ),
)
Toast.displayName = ToastPrimitive.Root.displayName

const ToastAction = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Action>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action>>(
  ({ className, ...props }, ref) => (
    <ToastPrimitive.Action
      ref={ref}
      className={cn('inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium', className)}
      {...props}
    />
  ),
)
ToastAction.displayName = ToastPrimitive.Action.displayName

const ToastClose = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Close>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>>(
  ({ className, ...props }, ref) => (
    <ToastPrimitive.Close
      ref={ref}
      className={cn('absolute right-1 top-1 rounded-md p-1 text-foreground/60 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring', className)}
      {...props}
    />
  ),
)
ToastClose.displayName = ToastPrimitive.Close.displayName

const ToastTitle = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Title>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>>(
  ({ className, ...props }, ref) => (
    <ToastPrimitive.Title ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
  ),
)
ToastTitle.displayName = ToastPrimitive.Title.displayName

const ToastDescription = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Description>, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>>(
  ({ className, ...props }, ref) => (
    <ToastPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
)
ToastDescription.displayName = ToastPrimitive.Description.displayName

export { Toast, ToastAction, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport }
`,
  })
  files.push({ path: join('services', name, 'src', 'lib', 'utils.ts'), contents: utils })
  files.push({ path: join('services', name, 'components.json'), contents: componentsJson })
  files.push({ path: join('services', name, 'Dockerfile'), contents: dockerfile(name) })
  files.push({ path: join('services', name, 'README.md'), contents: serviceReadme(name, opts.description) })
  const compose = dockerCompose(opts)
  if (compose) {
    files.push({ path: join('services', name, 'docker-compose.yml'), contents: compose })
  }

  if (opts.includeArgo ?? true) {
    files.push({ path: join('argocd', 'applications', name, 'kustomization.yaml'), contents: argoRootKustomization })
    files.push({
      path: join('argocd', 'applications', name, 'base', 'kustomization.yaml'),
      contents: argoBaseKustomization(opts, !!opts.enablePostgres, !!opts.enableRedis),
    })
    files.push({ path: join('argocd', 'applications', name, 'base', 'service.yaml'), contents: knativeService(opts) })
    if (exposure === 'tailscale') {
      files.push({
        path: join('argocd', 'applications', name, 'base', 'tailscale-service.yaml'),
        contents: tailscaleService(opts),
      })
    } else {
      files.push({
        path: join('argocd', 'applications', name, 'base', 'domain-mapping.yaml'),
        contents: domainMapping(name, domain, namespace),
      })
      files.push({
        path: join('argocd', 'applications', name, 'base', 'cluster-domain-claim.yaml'),
        contents: clusterDomainClaim(name, domain),
      })
    }
    files.push({
      path: join('argocd', 'applications', name, 'overlays', 'cluster', 'kustomization.yaml'),
      contents: argoOverlay(opts),
    })
    if (opts.enablePostgres) {
      files.push({
        path: join('argocd', 'applications', name, 'base', 'postgres.yaml'),
        contents: postgres(name, namespace),
      })
    }
    if (opts.enableRedis) {
      files.push({ path: join('argocd', 'applications', name, 'base', 'redis.yaml'), contents: redis(name, namespace) })
    }
  }

  if (opts.includeCi ?? true) {
    files.push({ path: join('.github', 'workflows', `${name}-ci.yml`), contents: ciWorkflow(name) })
    files.push({ path: join('.github', 'workflows', `${name}-build-push.yaml`), contents: buildWorkflow(name) })
  }

  if (opts.includeScripts ?? true) {
    files.push({
      path: join('packages', 'scripts', 'src', name, 'build-image.ts'),
      contents: scriptsBuild(name),
      executable: true,
    })
    files.push({
      path: join('packages', 'scripts', 'src', name, 'deploy-service.ts'),
      contents: scriptsDeploy(name),
      executable: true,
    })
  }

  return files
}
