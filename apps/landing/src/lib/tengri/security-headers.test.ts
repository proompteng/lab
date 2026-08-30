import { describe, expect, test } from 'bun:test'
import { unstable_doesMiddlewareMatch as doesProxyMatch } from 'next/experimental/testing/server'

import nextConfig from '../../../next.config'
import { config as proxyConfig, proxy } from '../../proxy'
import { buildContentSecurityPolicy } from './security-headers'

describe('Tengri browser security headers', () => {
  test('keeps development-only execution and loopback allowances out of production', () => {
    const productionPolicy = buildContentSecurityPolicy({ development: false })
    const developmentPolicy = buildContentSecurityPolicy({ development: true })

    expect(productionPolicy).not.toContain("'unsafe-eval'")
    expect(productionPolicy).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'")
    expect(productionPolicy).toContain('https://static.cloudflareinsights.com')
    expect(productionPolicy).toContain('https://cloudflareinsights.com')
    expect(productionPolicy).not.toContain('http://localhost:')
    expect(productionPolicy).not.toContain('ws://127.0.0.1:')
    expect(productionPolicy).toContain('https://convex.proompteng.ai wss://convex.proompteng.ai')
    expect(productionPolicy).toContain('https://*.proompteng.ai')
    expect(productionPolicy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")
    expect(productionPolicy).toContain("font-src 'self' data: https://fonts.gstatic.com")
    expect(productionPolicy).toContain('upgrade-insecure-requests')
    expect(developmentPolicy).toContain("'unsafe-eval'")
    expect(developmentPolicy).not.toContain("'wasm-unsafe-eval'")
    expect(developmentPolicy).not.toContain('cloudflareinsights.com')
    expect(developmentPolicy).toContain('http://127.0.0.1:*')
    expect(developmentPolicy).toContain('http://*.localhost:*')
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

  test('builds gateway directives from runtime environment on every request', () => {
    const originalPublicUrl = process.env.TENGRI_PUBLIC_URL
    try {
      process.env.TENGRI_PUBLIC_URL = 'https://first-gateway.example.test'
      const firstPolicy = proxy().headers.get('Content-Security-Policy')
      expect(firstPolicy).toContain('https://first-gateway.example.test')

      process.env.TENGRI_PUBLIC_URL = 'https://second-gateway.example.test'
      const secondPolicy = proxy().headers.get('Content-Security-Policy')
      expect(secondPolicy).toContain('https://second-gateway.example.test')
      expect(secondPolicy).not.toContain('https://first-gateway.example.test')
    } finally {
      if (originalPublicUrl === undefined) delete process.env.TENGRI_PUBLIC_URL
      else process.env.TENGRI_PUBLIC_URL = originalPublicUrl
    }
  })

  test('applies runtime CSP to application and API routes but not immutable assets', () => {
    expect(doesProxyMatch({ config: proxyConfig, nextConfig, url: '/' })).toBe(true)
    expect(doesProxyMatch({ config: proxyConfig, nextConfig, url: '/api/tengri' })).toBe(true)
    expect(doesProxyMatch({ config: proxyConfig, nextConfig, url: '/_next/static/chunk.js' })).toBe(false)
    expect(doesProxyMatch({ config: proxyConfig, nextConfig, url: '/favicon.ico' })).toBe(false)
  })

  test('applies static defense-in-depth headers to every route', async () => {
    expect(nextConfig.headers).toBeFunction()
    const rules = await nextConfig.headers?.()
    expect(rules).toHaveLength(1)
    expect(rules?.[0]?.source).toBe('/:path*')

    const headers = new Map(rules?.[0]?.headers.map(({ key, value }) => [key, value]))
    expect(headers.has('Content-Security-Policy')).toBe(false)
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups')
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })
})
