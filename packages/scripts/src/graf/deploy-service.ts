#!/usr/bin/env bun

import { updateKnativeServiceImage } from '../shared/kn'
import { buildImage } from './build-image'

const defaultNamespace = 'graf'

const deploy = async () => {
  const { image } = await buildImage()

  console.log('Updating Graf Knative service...')
  await updateKnativeServiceImage('graf', defaultNamespace, image)
}

if (import.meta.main) {
  deploy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
