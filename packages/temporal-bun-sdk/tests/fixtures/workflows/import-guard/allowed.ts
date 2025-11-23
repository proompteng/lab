import assert from 'node:assert'
import { URL } from 'node:url'
import { format } from 'node:util'

export const allowedHost = format('%s', new URL('https://example.com').hostname)
assert.ok(allowedHost)
