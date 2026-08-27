import { describe, expect, test } from 'bun:test'

import nextConfig, { buildContentSecurityPolicy } from '../../../next.config'

describe('Tengri browser security headers', () => {
  test('keeps development-only execution and loopback allowances out of production', () => {
    const productionPolicy = buildContentSecurityPolicy({ development: false })
    const developmentPolicy = buildContentSecurityPolicy({ development: true })

    expect(productionPolicy).not.toContain("'unsafe-eval'")
    expect(productionPolicy).not.toContain('http://localhost:')
    expect(productionPolicy).not.toContain('ws://127.0.0.1:')
    expect(productionPolicy).toContain('https://convex.proompteng.ai wss://convex.proompteng.ai')
    expect(productionPolicy).toContain('https://*.proompteng.ai')
    expect(productionPolicy).toContain('upgrade-insecure-requests')
    expect(developmentPolicy).toContain("'unsafe-eval'")
    expect(developmentPolicy).toContain('http://127.0.0.1:*')
    expect(developmentPolicy).not.toContain('upgrade-insecure-requests')
  })

  test('allows only the configured gateway, preview zone, and Convex origins', () => {
    const policy = buildContentSecurityPolicy({
      convexUrl: 'https://convex.example.test',
      development: false,
      previewFrameSource: 'https://*.preview.example.test',
      tengriPublicUrl: 'https://gateway.example.test',
    })

    expect(policy).toContain(
      "connect-src 'self' https://gateway.example.test wss://gateway.example.test https://convex.example.test wss://convex.example.test",
    )
    expect(policy).toContain("frame-src 'self' https://gateway.example.test https://*.preview.example.test")
    expect(policy).not.toContain('tengri.proompteng.ai')
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
  })

  test('permits generated production previews while rejecting malformed configured sources', () => {
    const policy = buildContentSecurityPolicy({
      convexUrl: 'javascript:alert(1)',
      development: false,
      previewFrameSource: 'https://preview.example.test; frame-src *',
      tengriPublicUrl: 'https://gateway.example.test/path',
    })

    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-src 'self'")
    expect(policy).not.toContain('tengri.proompteng.ai')
    expect(policy).not.toContain('convex.proompteng.ai')
    expect(policy).not.toContain('https://*.proompteng.ai')
    expect(policy).not.toContain('javascript:')
    expect(policy).not.toContain('frame-src *')
  })

  test('applies defense-in-depth headers to every route', async () => {
    expect(nextConfig.headers).toBeFunction()
    const rules = await nextConfig.headers?.()
    expect(rules).toHaveLength(1)
    expect(rules?.[0]?.source).toBe('/:path*')

    const headers = new Map(rules?.[0]?.headers.map(({ key, value }) => [key, value]))
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups')
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })
})
