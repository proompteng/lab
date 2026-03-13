export class SymphonyError extends Error {
  readonly code: string
  readonly causeValue: unknown

  constructor(code: string, message: string, causeValue?: unknown) {
    super(message)
    this.name = 'SymphonyError'
    this.code = code
    this.causeValue = causeValue
  }
}

export const isSymphonyError = (value: unknown): value is SymphonyError => value instanceof SymphonyError

export const toError = (error: unknown): Error => {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}
