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

To build libraries locally, ensure you have:
1. Rust toolchain installed
2. Temporal SDK Core vendored (git submodule)
3. Run: \`cargo build --release\` in the vendor directory`

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
