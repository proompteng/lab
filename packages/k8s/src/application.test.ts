import { describe, expect, it } from 'bun:test'
import { Chart } from 'cdk8s'

import { defineApplicationRegistry, type ApplicationDefinition } from './application'

const definition = (overrides: Partial<ApplicationDefinition> = {}): ApplicationDefinition => ({
  name: 'docs',
  namespace: 'docs',
  outputDir: 'argocd/applications/docs/generated',
  create: (scope) => new Chart(scope, 'docs'),
  ...overrides,
})

describe('defineApplicationRegistry', () => {
  it('registers explicit application definitions', () => {
    const registry = defineApplicationRegistry([definition()])

    expect(registry.get('docs').namespace).toBe('docs')
    expect(registry.applications.map(({ name }) => name)).toEqual(['docs'])
  })

  it('rejects duplicate names', () => {
    expect(() => defineApplicationRegistry([definition(), definition()])).toThrow('Duplicate application name')
  })

  it('rejects output directories outside the application boundary', () => {
    expect(() =>
      defineApplicationRegistry([definition({ outputDir: 'argocd/applications/analysis/generated' })]),
    ).toThrow('must generate into argocd/applications/docs/generated')
  })

  it('rejects unknown application names', () => {
    const registry = defineApplicationRegistry([definition()])

    expect(() => registry.get('missing')).toThrow("Unknown application 'missing'")
  })
})
