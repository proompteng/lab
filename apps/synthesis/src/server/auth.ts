import { timingSafeEqual } from 'node:crypto'

const bearerPrefix = 'Bearer '

const constantTimeEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export const isAuthorized = (request: Request) => {
  if (process.env.SYNTHESIS_AUTH_DISABLED === '1') return true

  const expected = process.env.SYNTHESIS_API_TOKEN?.trim()
  if (!expected) return false

  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith(bearerPrefix)) return false

  return constantTimeEquals(header.slice(bearerPrefix.length).trim(), expected)
}

export const unauthorizedResponse = () =>
  new Response(JSON.stringify({ error: 'missing or invalid bearer token' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    },
  })

export const requireAuthorized = (request: Request) => (isAuthorized(request) ? null : unauthorizedResponse())
