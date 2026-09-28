import * as restate from '@restatedev/restate-sdk'
import { Effect } from 'effect'

import { decodeGreetingRequest, greetingMessage, type DurableStepKind } from './domain'

interface DurableMarker {
  readonly id: string
  readonly name: string
  readonly kind: DurableStepKind
  readonly recordedAt: string
}

const readGreetingRequest = (input: unknown) => {
  try {
    return decodeGreetingRequest(input)
  } catch (error) {
    throw new restate.TerminalError('invalid greeting request', {
      errorCode: 400,
      metadata: {
        cause: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

const recordMarker = (kind: DurableMarker['kind'], id: string, name: string): Effect.Effect<DurableMarker> =>
  Effect.sync(() => {
    const marker = {
      id,
      name,
      kind,
      recordedAt: new Date().toISOString(),
    } satisfies DurableMarker

    console.log(JSON.stringify({ service: 'restate-example', event: 'durable_marker_recorded', ...marker }))
    return marker
  })

export const greeter = restate.service({
  name: 'Greeter',
  handlers: {
    greet: async (ctx: restate.Context, input: unknown) => {
      const request = readGreetingRequest(input)
      const greetingId = ctx.rand.uuidv4()

      const notification = await ctx.run('record notification marker', () =>
        Effect.runPromise(recordMarker('notification', greetingId, request.name)),
      )

      await ctx.sleep({ milliseconds: 25 })

      const reminder = await ctx.run('record reminder marker', () =>
        Effect.runPromise(recordMarker('reminder', greetingId, request.name)),
      )

      return {
        message: greetingMessage(request.name),
        greetingId,
        durableSteps: [notification.kind, reminder.kind],
      }
    },
  },
})

const port = Number.parseInt(process.env.PORT ?? '9080', 10)

restate.serve({
  services: [greeter],
  port,
})

console.log(JSON.stringify({ service: 'restate-example', event: 'listening', port }))
