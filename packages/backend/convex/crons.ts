import { cronJobs, makeFunctionReference } from 'convex/server'

const crons = cronJobs()
const pruneRetiredSessions = makeFunctionReference<'mutation', Record<string, never>, { deleted: number }>(
  'presence:pruneRetiredSessions',
)

crons.hourly('delete retired live-presence sessions', { minuteUTC: 37 }, pruneRetiredSessions)

export default crons
