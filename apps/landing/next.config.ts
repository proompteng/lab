import type { NextConfig } from 'next'

export function buildContentSecurityPolicy(development: boolean): string {
  const scriptSource = development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
  const developmentConnections = development
    ? ' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*'
    : ''
  const developmentFrames = development ? ' http://localhost:* http://127.0.0.1:* http://*.localhost:*' : ''

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://github.com",
    scriptSource,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    `connect-src 'self' https://tengri.proompteng.ai wss://tengri.proompteng.ai${developmentConnections}`,
    // Each preview receives an isolated one-level origin such as tengri-<session>.proompteng.ai.
    // CSP does not support partial-label wildcards, so keep the wildcard limited to frame-src.
    `frame-src 'self' https://tengri.proompteng.ai https://*.proompteng.ai${developmentFrames}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ')
}

const contentSecurityPolicy = buildContentSecurityPolicy(process.env.NODE_ENV !== 'production')

const nextConfig: NextConfig = {
  distDir: process.env.TENGRI_NEXT_DIST_DIR || '.next',
  output: 'standalone',
  experimental: {
    useTypeScriptCli: true,
  },
  transpilePackages: ['@proompteng/design'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}

export default nextConfig
