import { Option, pipe, Result } from 'effect'

import type { SimulationFailure } from './model'
import { Pipeable } from '../pipeable'

type RecordAccessOperation = Extract<SimulationFailure, { readonly _tag: 'RecordAccessFailed' }>['operation']

const accessFailure = (
  operation: RecordAccessOperation,
  key: string,
  context: string,
  reason: Extract<SimulationFailure, { readonly _tag: 'RecordAccessFailed' }>['reason'],
  cause?: unknown,
): SimulationFailure => ({
  _tag: 'RecordAccessFailed',
  operation,
  key,
  context,
  reason,
  cause,
})

const optionalRecordValueDataFirst = <A>(
  values: Readonly<Record<string, A>>,
  key: string,
  operation: RecordAccessOperation,
  context: string,
): Result.Result<Option.Option<A>, SimulationFailure> =>
  pipe(
    Result.try({
      try: () => Object.getOwnPropertyDescriptor(values, key),
      catch: (cause) => accessFailure(operation, key, context, 'introspection-failed', cause),
    }),
    Result.flatMap((descriptor) => {
      if (descriptor === undefined) return Result.succeed(Option.none())
      if (descriptor.enumerable !== true || !('value' in descriptor)) {
        return Result.fail(accessFailure(operation, key, context, 'non-data-property'))
      }
      return Result.succeed(Option.some(descriptor.value as A))
    }),
  )

export const optionalRecordValue = Pipeable.generic<
  <A>(
    key: string,
    operation: RecordAccessOperation,
    context: string,
  ) => (values: Readonly<Record<string, A>>) => Result.Result<Option.Option<A>, SimulationFailure>,
  typeof optionalRecordValueDataFirst
>(4, optionalRecordValueDataFirst)
