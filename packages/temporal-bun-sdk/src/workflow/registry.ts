import * as Schema from 'effect/Schema'

import { defineWorkflow, type WorkflowDefinition, type WorkflowDefinitions, type WorkflowHandler } from './definition'

const defaultSchema = Schema.Array(Schema.Unknown) as Schema.Schema<readonly unknown[]>

export class WorkflowRegistry {
  #definitions = new Map<string, WorkflowDefinition<unknown, unknown>>()

  register<I, O>(definition: WorkflowDefinition<I, O>): void {
    if (!definition || typeof definition.name !== 'string' || definition.name.length === 0) {
      throw new Error('Workflow definition must declare a non-empty name')
    }
    this.#definitions.set(definition.name, definition as WorkflowDefinition<unknown, unknown>)
  }

  registerMany(
    definitions:
      | WorkflowDefinitions
      | Record<string, WorkflowDefinition<unknown, unknown> | WorkflowHandler<readonly unknown[], unknown>>,
  ): void {
    if (Array.isArray(definitions)) {
      for (const definition of definitions) {
        this.register(definition)
      }
      return
    }

    for (const [name, entry] of Object.entries(definitions)) {
      if (isWorkflowDefinition(entry)) {
        this.register(entry)
        continue
      }
      if (typeof entry === 'function') {
        this.register(defineWorkflow(name, defaultSchema, entry))
        continue
      }
      throw new Error(`Invalid workflow definition for ${name}`)
    }
  }

  get(name: string): WorkflowDefinition<unknown, unknown> {
    const definition = this.#definitions.get(name)
    if (!definition) {
      throw new Error(`Workflow definition not found for type ${name}`)
    }
    return definition
  }

  list(): WorkflowDefinition<unknown, unknown>[] {
    return Array.from(this.#definitions.values())
  }
}

const isWorkflowDefinition = (value: unknown): value is WorkflowDefinition<unknown, unknown> => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as WorkflowDefinition<unknown, unknown>
  return (
    typeof record.name === 'string' &&
    typeof record.handler === 'function' &&
    typeof record.decodeArgumentsAsArray === 'boolean'
  )
}
