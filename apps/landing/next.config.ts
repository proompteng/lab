import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    useTypeScriptCli: true,
  },
  transpilePackages: ['@proompteng/design'],
}

export default nextConfig
