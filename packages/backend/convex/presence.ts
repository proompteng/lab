import { v } from 'convex/values'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'

const MIN_TTL_MS = 15_000
const MAX_TTL_MS = 10 * 60_000
const EXPIRED_PRUNE_BATCH_SIZE = 128

export const track = mutation({
  args: {
    site: v.string(),
    sessionId: v.string(),
    visitorIdHash: v.string(),
    path: v.string(),
    event: v.union(v.literal('join'), v.literal('heartbeat'), v.literal('leave')),
    now: v.number(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    const ttlMs = clamp(args.ttlMs, MIN_TTL_MS, MAX_TTL_MS)
    await pruneExpiredSessions(ctx, args.site, args.now)

    const existing = await ctx.db
      .query('liveSessions')
      .withIndex('bySession', (q) => q.eq('sessionId', args.sessionId))
      .unique()

    if (args.event === 'leave') {
      if (existing) {
        await ctx.db.patch(existing._id, {
          lastSeenAt: args.now,
          expiresAt: args.now,
          updatedAt: args.now,
        })
      }

      return {
        onlineNow: await countOnlineVisitors(ctx, args.site, args.now),
        updatedAt: args.now,
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        site: args.site,
        visitorIdHash: args.visitorIdHash,
        path: args.path,
        lastSeenAt: args.now,
        expiresAt: args.now + ttlMs,
        updatedAt: args.now,
      })
    } else {
      await ctx.db.insert('liveSessions', {
        site: args.site,
        sessionId: args.sessionId,
        visitorIdHash: args.visitorIdHash,
        path: args.path,
        lastSeenAt: args.now,
        expiresAt: args.now + ttlMs,
        updatedAt: args.now,
      })
    }

    return {
      onlineNow: await countOnlineVisitors(ctx, args.site, args.now),
      updatedAt: args.now,
    }
  },
})

export const getOnlineNow = query({
  args: {
    site: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const onlineNow = await countOnlineVisitors(ctx, args.site, now)

    return {
      site: args.site,
      onlineNow,
      updatedAt: now,
    }
  },
})

async function countOnlineVisitors(ctx: QueryCtx | MutationCtx, site: string, now: number) {
  const activeSessions = await ctx.db
    .query('liveSessions')
    .withIndex('bySiteExpires', (q) => q.eq('site', site).gt('expiresAt', now))
    .collect()

  const uniqueVisitors = new Set(activeSessions.map((session) => session.visitorIdHash))
  return uniqueVisitors.size
}

async function pruneExpiredSessions(ctx: MutationCtx, site: string, now: number) {
  const expired = await ctx.db
    .query('liveSessions')
    .withIndex('bySiteExpires', (q) => q.eq('site', site).lte('expiresAt', now))
    .take(EXPIRED_PRUNE_BATCH_SIZE)

  for (const session of expired) {
    await ctx.db.delete(session._id)
  }
}

function clamp(value: number, min: number, max: number) {
  if (value < min) {
    return min
  }

  if (value > max) {
    return max
  }

  return value
}
