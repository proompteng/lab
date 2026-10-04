import { createServerFn } from '@tanstack/react-start'

import { deleteTag } from './registry-client'

type DeleteTagInput = {
  repository: string
  tag: string
}

const deleteTagInputValidator = (input: DeleteTagInput) => input

export const deleteTagServerFn = createServerFn({ method: 'POST' })
  .inputValidator(deleteTagInputValidator)
  .handler(async ({ data }) => {
    const input = data
    const result = await deleteTag(input.repository, input.tag)
    if (result.error) {
      throw new Error(result.error)
    }
  })
