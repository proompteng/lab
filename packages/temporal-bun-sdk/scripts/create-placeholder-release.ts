#!/usr/bin/env bun

import { execSync } from 'child_process'

const version = process.argv[2] || 'v1.0.0'
const tag = `temporal-libs-${version}`
const title = `Temporal Static Libraries ${version}`
const notes = `Temporal static libraries release ${version}.

**Note:** This is a placeholder release. Pre-built libraries will be added for:
- linux-arm64
- linux-x64  
- macos-arm64

To stage libraries locally:
1. Run \`bun run scripts/download-temporal-libs.ts download --version ${version}\`
2. Optionally validate with \`pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig\`
`

console.log(`Creating placeholder release: ${tag}`)

try {
  execSync(`gh release create "${tag}" --title "${title}" --notes "${notes}" --draft`, {
    stdio: 'inherit',
  })
  console.log(`✅ Draft release created: ${tag}`)
  console.log('Add artifacts and publish when ready')
} catch (error) {
  console.error('Failed to create release:', error)
  process.exit(1)
}
