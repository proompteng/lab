import { describe, expect, it } from 'vitest'

import { classifyControlPlaneRouteSource } from './generate-architecture-inventory'

describe('architecture inventory route classification', () => {
  it('recognizes server and client redirect stubs', () => {
    expect(classifyControlPlaneRouteSource('throw redirect({ to: "/" })')).toBe('redirect')
    expect(classifyControlPlaneRouteSource('return <ControlPlaneRedirect to="/" />')).toBe('redirect')
    expect(classifyControlPlaneRouteSource('return <Navigate to="/" replace />')).toBe('redirect')
  })

  it('keeps normal route content classified as a page', () => {
    expect(classifyControlPlaneRouteSource('return <main>Control plane</main>')).toBe('page')
  })
})
