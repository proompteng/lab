#!/usr/bin/env bun

import { type BuildImageOptions, buildTorghutImage, parseBuildImageArgs } from './image-builders'

export type { BuildImageOptions }

export const buildTechnicalAnalysisImage = async (options: BuildImageOptions = {}) => buildTorghutImage('ta', options)

if (import.meta.main) {
  buildTechnicalAnalysisImage(parseBuildImageArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
