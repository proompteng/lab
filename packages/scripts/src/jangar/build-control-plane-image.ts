#!/usr/bin/env bun

import { buildImage } from './build-image'

const DEFAULT_REPOSITORY = 'lab/jangar-control-plane'
const DEFAULT_TARGET = 'control-plane'

buildImage({
  repository: process.env.JANGAR_CONTROL_PLANE_IMAGE_REPOSITORY ?? DEFAULT_REPOSITORY,
  target: process.env.JANGAR_CONTROL_PLANE_DOCKER_TARGET ?? DEFAULT_TARGET,
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
