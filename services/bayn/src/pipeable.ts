import { Function } from 'effect'

type AnyFunction = (...arguments_: ReadonlyArray<never>) => unknown
type Tail<Values extends ReadonlyArray<unknown>> = Values extends readonly [unknown, ...infer Rest] ? Rest : never

interface PipeableFunction<Self, Arguments extends ReadonlyArray<unknown>, Return> {
  (...arguments_: Arguments): (self: Self) => Return
  (self: Self, ...arguments_: Arguments): Return
}

const dual = <DataFirst extends AnyFunction>(
  arity: Parameters<DataFirst>['length'],
  body: DataFirst,
): PipeableFunction<Parameters<DataFirst>[0], Tail<Parameters<DataFirst>>, ReturnType<DataFirst>> =>
  Function.dual(arity, body)

export const Pipeable = { dual } as const
