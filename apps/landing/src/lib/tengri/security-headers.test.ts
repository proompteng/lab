import { describe, expect, test } from 'bun:test'

import nextConfig, { buildContentSecurityPolicy } from '../../../next.config'

describe('Tengri browser security headers', () => {
  test('keeps development-only execution and loopback allowances out of production', () => {
    const productionPolicy = buildContentSecurityPolicy(false)
    const developmentPolicy = buildContentSecurityPolicy(true)

    expect(productionPolicy).not.toContain("'unsafe-eval'")
    expect(productionPolicy).not.toContain('http://localhost:')
    expect(productionPolicy).not.toContain('ws://127.0.0.1:')
    expect(productionPolicy).toContain('upgrade-insecure-requests')
    expect(developmentPolicy).toContain("'unsafe-eval'")
    expect(developmentPolicy).toContain('http://127.0.0.1:*')
    expect(developmentPolicy).not.toContain('upgrade-insecure-requests')
  })

  test('limits cross-origin connections and frames to the Tengri gateway', () => {
    const policy = buildContentSecurityPolicy(false)

    expect(policy).toContain("connect-src 'self' https://tengri.proompteng.ai wss://tengri.proompteng.ai")
    expect(policy).toContain("frame-src 'self' https://tengri.proompteng.ai")
    expect(policy).not.toContain('https://*.proompteng.ai')
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
  })

  test('applies defense-in-depth headers to every route', async () => {
    expect(nextConfig.headers).toBeFunction()
    const rules = await nextConfig.headers?.()
    expect(rules).toHaveLength(1)
    expect(rules?.[0]?.source).toBe('/:path*')

    const headers = new Map(rules?.[0]?.headers.map(({ key, value }) => [key, value]))
    expect(headers.get('Content-Security-Policy')).toBe(buildContentSecurityPolicy(true))
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups')
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })
})
