#!/usr/bin/env bun

import { $ } from 'bun'
import { buildImage } from './build-image'
import { ensureCli } from '../shared/cli'

const ensureResources = () => {
  ensureCli('kubectl')
  ensureCli('kn')
}

const defaultNamespace = 'graf'

const deploy = async () => {
  ensureResources()

  const { image } = await buildImage()

  console.log('Updating Graf Knative service...')
  await $`kn service update graf --namespace ${defaultNamespace} --image ${image} --wait`
}

if (import.meta.main) {
  deploy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
