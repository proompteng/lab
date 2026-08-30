import { Schema } from 'effect'

export const GreetingRequestSchema = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1)),
})

export type GreetingRequest = typeof GreetingRequestSchema.Type

export const decodeGreetingRequest = (input: unknown): GreetingRequest =>
  Schema.decodeUnknownSync(GreetingRequestSchema)(input)

export const durableStepKinds = ['notification', 'reminder'] as const

export type DurableStepKind = (typeof durableStepKinds)[number]

export const greetingMessage = (name: string): string => `Hello, ${name} from Restate`
