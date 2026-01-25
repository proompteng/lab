import { defineEventHandler, toWebRequest } from 'h3'
import serverEntry from 'virtual:tanstack-start-server-entry'

export default defineEventHandler((event) => {
  const request = toWebRequest(event)
  return serverEntry.fetch(request)
})
