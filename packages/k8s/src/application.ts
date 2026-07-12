import type { Chart } from 'cdk8s'
import type { Construct } from 'constructs'

const dnsLabelPattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/

export interface ApplicationDefinition {
  readonly name: string
  readonly namespace: string
  readonly outputDir: `argocd/applications/${string}/generated`
  readonly create: (scope: Construct) => Chart
}

export interface ApplicationRegistry {
  readonly applications: readonly ApplicationDefinition[]
  readonly get: (name: string) => ApplicationDefinition
}

export const defineApplication = <const T extends ApplicationDefinition>(definition: T): T => definition

export const defineApplicationRegistry = (definitions: readonly ApplicationDefinition[]): ApplicationRegistry => {
  const byName = new Map<string, ApplicationDefinition>()
  const outputDirectories = new Set<string>()

  for (const definition of definitions) {
    if (!dnsLabelPattern.test(definition.name)) {
      throw new Error(`Application name must be a DNS label: ${definition.name}`)
    }
    if (!dnsLabelPattern.test(definition.namespace)) {
      throw new Error(`Application namespace must be a DNS label: ${definition.namespace}`)
    }

    const expectedOutputDir = `argocd/applications/${definition.name}/generated`
    if (definition.outputDir !== expectedOutputDir) {
      throw new Error(
        `Application ${definition.name} must generate into ${expectedOutputDir}, got ${definition.outputDir}`,
      )
    }
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate application name: ${definition.name}`)
    }
    if (outputDirectories.has(definition.outputDir)) {
      throw new Error(`Duplicate application output directory: ${definition.outputDir}`)
    }

    byName.set(definition.name, Object.freeze(definition))
    outputDirectories.add(definition.outputDir)
  }

  const applications = Object.freeze([...byName.values()])

  return Object.freeze({
    applications,
    get(name: string) {
      const definition = byName.get(name)
      if (!definition) {
        const known = applications.map((application) => application.name).join(', ')
        throw new Error(`Unknown application '${name}'. Registered applications: ${known}`)
      }
      return definition
    },
  })
}
