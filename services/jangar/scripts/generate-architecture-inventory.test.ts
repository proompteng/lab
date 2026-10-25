import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  classifyControlPlaneRouteSource,
  classifyRouteSource,
  extractFileRoutePath,
  extractRegisteredAgentsRouteFiles,
  isControlPlaneRoutePath,
  normalizeRoutePath,
  readRoutes,
} from './generate-architecture-inventory'

describe('architecture inventory route classification', () => {
  it('recognizes server and client redirect stubs', () => {
    expect(classifyControlPlaneRouteSource('throw redirect({ to: "/" })')).toBe('redirect')
    expect(classifyControlPlaneRouteSource('return <ControlPlaneRedirect to="/" />')).toBe('redirect')
    expect(classifyControlPlaneRouteSource('return <Navigate to="/" replace />')).toBe('redirect')
  })

  it('keeps normal route content classified as a page', () => {
    expect(classifyControlPlaneRouteSource('return <main>Control plane</main>')).toBe('page')
  })

  it('recognizes route declarations without importing route modules', () => {
    expect(extractFileRoutePath("export const Route = createFileRoute('/v1/control-plane/status')({})")).toBe(
      '/v1/control-plane/status',
    )
    expect(extractFileRoutePath('export const Route = createRootRoute({})')).toBeNull()
  })

  it('derives the Agents HTTP inventory from the runtime registration list', async () => {
    const controlPlanePath = resolve(import.meta.dirname, '../../agents/src/server/control-plane.ts')
    const registered = extractRegisteredAgentsRouteFiles(await readFile(controlPlanePath, 'utf8'))
      .map((file) => `services/agents/${file}`)
      .sort()
    const inventoried = (await readRoutes())
      .filter((route) => route.boundary === 'Agents HTTP')
      .map((route) => route.filePath)
      .sort()

    expect(inventoried).toEqual(registered)
    expect(new Set(inventoried).size).toBe(inventoried.length)
  })

  it('rejects duplicate or out-of-bound Agents route registrations', () => {
    const wrap = (entries: string) =>
      `const routeSources: RouteSourceSpec[] = [\n${entries}\n]\n\nconst assessAgentRunIngestion = () => {}`

    expect(() =>
      extractRegisteredAgentsRouteFiles(
        wrap("{ file: 'src/routes/v1/status.ts' },\n{ file: 'src/routes/v1/status.ts' },"),
      ),
    ).toThrow(/duplicate files/)
    expect(() => extractRegisteredAgentsRouteFiles(wrap("{ file: 'src/server/health.ts' },"))).toThrow(
      /outside src\/routes/,
    )
  })

  it('normalizes file-route trailing slashes for inventory paths', () => {
    expect(normalizeRoutePath('/primitives/')).toBe('/primitives')
    expect(normalizeRoutePath('/')).toBe('/')
    expect(normalizeRoutePath(' /ready/ ')).toBe('/ready')
  })

  it('classifies server routes separately from UI pages', () => {
    expect(classifyRouteSource('server: { handlers: { GET: handler } }', '/v1/control-plane/status')).toBe('handler')
    expect(classifyRouteSource('return <main>Control plane</main>', '/torghut/control-plane')).toBe('page')
    expect(classifyRouteSource('throw redirect({ to: "/" })', '/library')).toBe('redirect')
  })

  it('identifies control-plane paths on each current route boundary', () => {
    expect(isControlPlaneRoutePath('/api/torghut/trading/control-plane/quant/health', 'Jangar HTTP')).toBe(true)
    expect(isControlPlaneRoutePath('/v1/control-plane/status', 'Agents HTTP')).toBe(true)
    expect(isControlPlaneRoutePath('/primitives', 'Agents UI')).toBe(true)
    expect(isControlPlaneRoutePath('/torghut/trading', 'Jangar UI')).toBe(false)
  })
})
