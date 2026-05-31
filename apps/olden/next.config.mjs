import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()
const appDir = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  turbopack: {
    root: resolve(appDir, '../..'),
  },
}

export default withMDX(nextConfig)
