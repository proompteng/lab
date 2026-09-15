import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowRegistry } from '../../src/workflow/registry'

describe('WorkflowRegistry', () => {
  test('register and retrieve definitions', () => {
    const registry = new WorkflowRegistry()
    const definition = defineWorkflow('echo', Schema.Array(Schema.String), ({ input }) => Effect.succeed(input))

    registry.register(definition)

    expect(registry.get('echo')).toBe(definition)
    expect(registry.list()).toEqual([definition])
  })

  test('registerMany accepts handler map and throws for invalid definitions', () => {
    const registry = new WorkflowRegistry()

    registry.registerMany({
      handlerOnly: ({ input }) => Effect.succeed(input),
    })

    expect(registry.get('handlerOnly').name).toBe('handlerOnly')
    expect(registry.get('handlerOnly').decodeArgumentsAsArray).toBe(true)

    expect(() => registry.registerMany({ broken: 123 as unknown as never })).toThrow(
      'Invalid workflow definition for broken',
    )
  })

  test('get throws for missing workflow types', () => {
    const registry = new WorkflowRegistry()
    expect(() => registry.get('missing')).toThrow('Workflow definition not found for type missing')
  })
})
