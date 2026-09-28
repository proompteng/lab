import { Inngest, eventType, staticSchema } from 'inngest'
import { getConfig } from './config'

const config = getConfig()

export const workflowRequestedEvent = eventType('khoshut/workflow.requested', {
  schema: staticSchema<{
    message: string
  }>(),
})

export const inngest = new Inngest({
  id: config.appId,
  eventKey: config.eventKey,
  baseUrl: config.baseUrl,
})

export const khoshutWorkflow = inngest.createFunction(
  { id: 'khoshut-example-workflow', triggers: [workflowRequestedEvent] },
  async ({ event, step }) => {
    const normalizedMessage = await step.run('normalize-message', async () => {
      const trimmed = event.data.message.trim()
      return trimmed.length > 0 ? trimmed.toLowerCase() : 'mend'
    })

    await step.sleep('short-delay', '2s')

    return step.run('compose-result', async () => ({
      originalMessage: event.data.message,
      normalizedMessage,
      response: `Khoshut processed: ${normalizedMessage}`,
      processedAt: new Date().toISOString(),
    }))
  },
)

export const functions = [khoshutWorkflow]
