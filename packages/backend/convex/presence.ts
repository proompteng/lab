import { v } from 'convex/values'
import { makeFunctionReference } from 'convex/server'

import { internalMutation } from './_generated/server'

const RETIRED_SESSION_CLEANUP_BATCH_SIZE = 128
const pruneRetiredSessionsRef = makeFunctionReference<'mutation', Record<string, never>, { deleted: number }>(
  'presence:pruneRetiredSessions',
)

export const pruneRetiredSessions = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const sessions = await ctx.db.query('liveSessions').take(RETIRED_SESSION_CLEANUP_BATCH_SIZE)

    for (const session of sessions) {
      await ctx.db.delete(session._id)
    }

    if (sessions.length === RETIRED_SESSION_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, pruneRetiredSessionsRef)
    }

    return { deleted: sessions.length }
  },
})
