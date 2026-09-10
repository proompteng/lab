#!/usr/bin/env bun

import { type BuildImageOptions, __private, buildTorghutImage, parseBuildImageArgs } from './image-builders'

export type { BuildImageOptions }

export const buildImage = async (options: BuildImageOptions = {}) => buildTorghutImage('core', options)

if (import.meta.main) {
  buildImage(parseBuildImageArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export { __private }
