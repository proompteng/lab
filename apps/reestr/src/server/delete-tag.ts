import { createServerFn } from '@tanstack/react-start'

import { deleteTag } from '~/lib/registry'

type DeleteTagInput = {
  repository: string
  tag: string
}

export const deleteTagServerFn = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  const input = data as DeleteTagInput
  const result = await deleteTag(input.repository, input.tag)
  if (result.error) {
    throw new Error(result.error)
  }
})
