import { EventSchemas, Inngest } from 'inngest'
import { getConfig } from './config'

const config = getConfig()

const schemas = new EventSchemas().fromRecord<{
  'khoshut/workflow.requested': {
    data: {
      message: string
    }
  }
}>()

export const inngest = new Inngest({
  id: config.appId,
  eventKey: config.eventKey,
  baseUrl: config.baseUrl,
  schemas,
})

export const khoshutWorkflow = inngest.createFunction(
  { id: 'khoshut-example-workflow' },
  { event: 'khoshut/workflow.requested' },
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
