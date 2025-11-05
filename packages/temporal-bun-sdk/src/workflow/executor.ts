import { create } from '@bufbuild/protobuf'
import { Effect, Exit } from 'effect'
import * as Schema from 'effect/Schema'

import type { DataConverter } from '../common/payloads'
import { encodeValuesToPayloads } from '../common/payloads/converter'
import { encodeErrorToFailure, encodeFailurePayloads } from '../common/payloads/failure'
import {
  type Command,
  CommandSchema,
  CompleteWorkflowExecutionCommandAttributesSchema,
  FailWorkflowExecutionCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import { PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import type { WorkflowRegistry } from './registry'

export interface ExecuteWorkflowInput {
  readonly workflowType: string
  readonly arguments: unknown
}

export class WorkflowExecutor {
  #registry: WorkflowRegistry
  #dataConverter: DataConverter

  constructor(options: { registry: WorkflowRegistry; dataConverter: DataConverter }) {
    this.#registry = options.registry
    this.#dataConverter = options.dataConverter
  }

  async execute(input: ExecuteWorkflowInput): Promise<Command[]> {
    const definition = this.#registry.get(input.workflowType)

    const decodedEffect = Schema.decodeUnknown(definition.schema)(input.arguments)
    const workflowEffect = Effect.flatMap(
      decodedEffect,
      (parsed) => definition.handler({ input: parsed }) as Effect.Effect<unknown, unknown, never>,
    )

    const exit = await Effect.runPromiseExit(workflowEffect)

    if (Exit.isSuccess(exit)) {
      return await this.#buildCompleteCommands(exit.value)
    }

    return await this.#buildFailureCommands(exit.cause ?? new Error('Workflow failed'))
  }

  async #buildCompleteCommands(result: unknown): Promise<Command[]> {
    const payloads = await encodeValuesToPayloads(this.#dataConverter, result === undefined ? [] : [result])
    const completionAttributes = create(CompleteWorkflowExecutionCommandAttributesSchema, {
      result: payloads && payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    })

    return [
      create(CommandSchema, {
        commandType: CommandType.COMPLETE_WORKFLOW_EXECUTION,
        attributes: {
          case: 'completeWorkflowExecutionCommandAttributes',
          value: completionAttributes,
        },
      }),
    ]
  }

  async #buildFailureCommands(cause: unknown): Promise<Command[]> {
    const failure = await encodeErrorToFailure(this.#dataConverter, cause)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)

    const failAttributes = create(FailWorkflowExecutionCommandAttributesSchema, {
      failure: encoded,
    })

    return [
      create(CommandSchema, {
        commandType: CommandType.FAIL_WORKFLOW_EXECUTION,
        attributes: {
          case: 'failWorkflowExecutionCommandAttributes',
          value: failAttributes,
        },
      }),
    ]
  }
}
