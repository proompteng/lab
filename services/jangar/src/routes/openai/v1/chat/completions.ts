import { createFileRoute } from '@tanstack/react-router'
import { handleChatCompletion } from '~/server/chat'

export const Route = createFileRoute('/openai/v1/chat/completions')({
  server: {
    handlers: {
      POST: async ({ request }) => chatCompletionsHandler(request),
    },
  },
})

export const chatCompletionsHandler = (request: Request) => handleChatCompletion(request)
