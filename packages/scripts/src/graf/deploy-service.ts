#!/usr/bin/env bun

import { join } from 'node:path'
import { $ } from 'bun'
import { buildImage } from './build-image'
import { ensureCli, repoRoot, run } from '../shared/cli'

const ensureResources = () => {
  ensureCli('kubectl')
  ensureCli('kn')
}

const defaultNamespace = 'graf'

const deploy = async () => {
  ensureResources()

  const { image } = await buildImage()

  await run('kn', [
    'service',
    'replace',
    'graf',
    '--namespace',
    defaultNamespace,
    '--image',
    image,
    '--force',
    '--wait',
  ])
}

if (import.meta.main) {
  deploy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
