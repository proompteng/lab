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
): PipeableFunction<Parameters<DataFirst>[0], Tail<Parameters<DataFirst>>, ReturnType<DataFirst>> => {
  if (arity !== 1) return Function.dual(arity, body)

  const unaryBody = body as unknown as (self: Parameters<DataFirst>[0]) => ReturnType<DataFirst>
  return ((...arguments_: ReadonlyArray<Parameters<DataFirst>[0]>) =>
    arguments_.length === 0 ? unaryBody : unaryBody(arguments_[0])) as PipeableFunction<
    Parameters<DataFirst>[0],
    Tail<Parameters<DataFirst>>,
    ReturnType<DataFirst>
  >
}

const generic = <DataLast extends AnyFunction, DataFirst extends AnyFunction>(
  arity: Parameters<DataFirst>['length'],
  body: DataFirst,
): DataLast & DataFirst => Function.dual<DataLast, DataFirst>(arity, body)

const by = <DataLast extends AnyFunction, DataFirst extends AnyFunction>(
  isDataFirst: (arguments_: IArguments) => boolean,
  body: DataFirst,
): DataLast & DataFirst => Function.dual<DataLast, DataFirst>(isDataFirst, body)

export const Pipeable = { by, dual, generic } as const
