import { defineApplicationRegistry } from './application'
import { analysisApplication } from './apps/analysis/application'
import { docsApplication } from './apps/docs/application'

export const applicationRegistry = defineApplicationRegistry([docsApplication, analysisApplication])
