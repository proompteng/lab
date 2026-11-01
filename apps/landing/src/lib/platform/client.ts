'use client'

import { z } from 'zod'

export class PlatformClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function readPlatformResponse(response: Response) {
  const value = z.json().parse(await response.json())
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(value)
    throw new PlatformClientError(
      response.status,
      error.success ? error.data.error : 'The request could not be completed.',
    )
  }
  return value
}
