import { prepareJevRequest, type JevRequest } from './contract'
import type { JevInstructions } from './instructions-contract'

export const applyJevInstructions = (request: JevRequest, instructions: JevInstructions) =>
  prepareJevRequest({
    ...request,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [
        name,
        {
          ...question,
          instructions: name === 'action' ? instructions.entry : question.instructions,
        },
      ]),
    ),
  })
