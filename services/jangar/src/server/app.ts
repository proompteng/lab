import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJangarHttpRuntime, type JangarHttpRuntime, type JangarHttpRuntimeOptions } from './http-runtime'

import { getPrometheusMetricsPath, isPrometheusMetricsEnabled, renderPrometheusMetrics } from './metrics'

export type JangarRuntime = JangarHttpRuntime

const serverRouteModules = import.meta.glob([
  '../routes/api/**/*.{ts,tsx}',
  '../routes/openai/**/*.{ts,tsx}',
  '../routes/health.tsx',
  '../routes/ready.tsx',
  '../routes/mcp.ts',
  '!../routes/**/*.test.{ts,tsx}',
  '!../routes/**/*.spec.{ts,tsx}',
])
const serverRouteSources = import.meta.glob(
  [
    '../routes/api/**/*.{ts,tsx}',
    '../routes/openai/**/*.{ts,tsx}',
    '../routes/health.tsx',
    '../routes/ready.tsx',
    '../routes/mcp.ts',
    '!../routes/**/*.test.{ts,tsx}',
    '!../routes/**/*.spec.{ts,tsx}',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>

export const getClientOutputDirCandidates = ({
  cwd = process.cwd(),
  moduleUrl = import.meta.url,
}: {
  cwd?: string
  moduleUrl?: string
} = {}) =>
  Array.from(
    new Set([
      resolve(cwd, '.output/public'),
      resolve(fileURLToPath(new URL('../../.output/public/', moduleUrl))),
      resolve(fileURLToPath(new URL('../public/', moduleUrl))),
      resolve(fileURLToPath(new URL('../../public/', moduleUrl))),
    ]),
  )

export const createJangarRuntime = async (options: { serveClient?: boolean } = {}): Promise<JangarRuntime> =>
  createJangarHttpRuntime({
    routeModules: serverRouteModules as JangarHttpRuntimeOptions['routeModules'],
    routeSources: serverRouteSources,
    serveClient: options.serveClient,
    clientOutputDirCandidates: getClientOutputDirCandidates,
    clientMissingMessage: 'Client build output missing. Run `bun run build` for services/jangar.',
    metrics: {
      enabled: isPrometheusMetricsEnabled,
      path: getPrometheusMetricsPath,
      render: renderPrometheusMetrics,
    },
  })
