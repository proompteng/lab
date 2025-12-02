import { createFileRoute } from '@tanstack/react-router'
import { createChatCompletionHandler } from '~/services/chat-completion'

export const Route = createFileRoute('/openai/v1/chat/completions')({
  server: {
    handlers: {
      POST: createChatCompletionHandler('POST /openai/v1/chat/completions'),
    },
  },
})
