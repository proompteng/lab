import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type { WorkflowContext } from './context'

export type WorkflowSchema<I> = Schema.Schema<I>

const defaultWorkflowSchema = Schema.Array(Schema.Unknown) as Schema.Schema<readonly unknown[]>

export type WorkflowHandler<I, O> = (context: WorkflowContext<I>) => Effect.Effect<O, unknown, never>

export interface WorkflowDefinition<I, O> {
  readonly name: string
  readonly schema: WorkflowSchema<I>
  readonly handler: WorkflowHandler<I, O>
  readonly decodeArgumentsAsArray: boolean
}

export function defineWorkflow<I, O>(name: string, handler: WorkflowHandler<I, O>): WorkflowDefinition<I, O>
export function defineWorkflow<I, O>(
  name: string,
  schema: WorkflowSchema<I>,
  handler: WorkflowHandler<I, O>,
): WorkflowDefinition<I, O>
export function defineWorkflow<I, O>(
  name: string,
  schemaOrHandler: WorkflowSchema<I> | WorkflowHandler<I, O>,
  maybeHandler?: WorkflowHandler<I, O>,
): WorkflowDefinition<I, O> {
  const schema = Schema.isSchema(schemaOrHandler)
    ? (schemaOrHandler as WorkflowSchema<I>)
    : (defaultWorkflowSchema as unknown as WorkflowSchema<I>)
  const handler = Schema.isSchema(schemaOrHandler) ? maybeHandler : (schemaOrHandler as WorkflowHandler<I, O>)
  const decodeArgumentsAsArray = Schema.isSchema(schemaOrHandler) ? schema.ast._tag === 'TupleType' : true
  if (typeof handler !== 'function') {
    throw new Error(`Workflow "${name}" must provide a handler`)
  }
  return {
    name,
    schema,
    handler,
    decodeArgumentsAsArray,
  }
}

export type WorkflowDefinitions = ReadonlyArray<WorkflowDefinition<unknown, unknown>>
