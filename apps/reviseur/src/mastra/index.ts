import { createLogger } from '@mastra/core/logger'
import { Mastra } from '@mastra/core/mastra'
import { githubAgent } from './agents/github.ts'

export const mastra = new Mastra({
  agents: { githubAgent },
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
})
