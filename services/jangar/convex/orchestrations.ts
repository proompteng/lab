import { v } from 'convex/values'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'

type OrchestrationDoc = {
  id: string
  topic: string
  repoUrl?: string
  status: string
  createdAt: number
  updatedAt: number
}

type TurnDoc = {
  index: number
  threadId?: string | null
  finalResponse: string
  items: unknown
  usage?: unknown
  createdAt: number
}

type WorkerDoc = {
  prUrl?: string
  branch?: string
  commitSha?: string
  notes?: string
}

const orchestrationArgs = {
  id: v.string(),
  topic: v.string(),
  repoUrl: v.optional(v.string()),
  status: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
}

const turnArgs = {
  index: v.number(),
  threadId: v.optional(v.union(v.string(), v.null())),
  finalResponse: v.string(),
  items: v.any(),
  usage: v.optional(v.any()),
  createdAt: v.number(),
}

const workerArgs = {
  prUrl: v.optional(v.string()),
  branch: v.optional(v.string()),
  commitSha: v.optional(v.string()),
  notes: v.optional(v.string()),
}

export const upsert = mutation({
  args: { state: v.object(orchestrationArgs) },
  handler: async (ctx: MutationCtx, { state }: { state: OrchestrationDoc }) => {
    const existing = await ctx.db
      .query('orchestrations')
      .withIndex('byOrchestrationId', (q) => q.eq('orchestrationId', state.id))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        topic: state.topic,
        repoUrl: state.repoUrl,
        status: state.status,
        updatedAt: state.updatedAt,
      })
      return
    }

    await ctx.db.insert('orchestrations', {
      orchestrationId: state.id,
      topic: state.topic,
      repoUrl: state.repoUrl,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    })
  },
})

export const appendTurn = mutation({
  args: { orchestrationId: v.string(), snapshot: v.object(turnArgs) },
  handler: async (ctx: MutationCtx, { orchestrationId, snapshot }: { orchestrationId: string; snapshot: TurnDoc }) => {
    const existing = await ctx.db
      .query('turns')
      .withIndex('byOrchestrationIdIndex', (q) => q.eq('orchestrationId', orchestrationId).eq('index', snapshot.index))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        threadId: snapshot.threadId ?? undefined,
        finalResponse: snapshot.finalResponse,
        items: snapshot.items,
        usage: snapshot.usage,
      })
      return
    }

    await ctx.db.insert('turns', {
      orchestrationId,
      index: snapshot.index,
      threadId: snapshot.threadId ?? undefined,
      finalResponse: snapshot.finalResponse,
      items: snapshot.items,
      usage: snapshot.usage,
      createdAt: snapshot.createdAt,
    })
  },
})

export const recordWorkerPr = mutation({
  args: { orchestrationId: v.string(), result: v.object(workerArgs) },
  handler: async (ctx: MutationCtx, { orchestrationId, result }: { orchestrationId: string; result: WorkerDoc }) => {
    await ctx.db.insert('worker_prs', {
      orchestrationId,
      prUrl: result.prUrl ?? undefined,
      branch: result.branch ?? undefined,
      commitSha: result.commitSha ?? undefined,
      notes: result.notes ?? undefined,
      createdAt: Date.now(),
    })
  },
})

export const getState = query({
  args: { orchestrationId: v.string() },
  handler: async (ctx: QueryCtx, { orchestrationId }: { orchestrationId: string }) => {
    const orchestration = await ctx.db
      .query('orchestrations')
      .withIndex('byOrchestrationId', (q) => q.eq('orchestrationId', orchestrationId))
      .unique()

    if (!orchestration) return null

    const turns = await ctx.db
      .query('turns')
      .withIndex('byOrchestrationIdIndex', (q) => q.eq('orchestrationId', orchestrationId))
      .order('asc')
      .collect()

    const workerPrs = await ctx.db
      .query('worker_prs')
      .withIndex('byOrchestrationIdCreated', (q) => q.eq('orchestrationId', orchestrationId))
      .order('asc')
      .collect()

    const typedTurns = turns as TurnDoc[]
    const typedWorkerPrs = workerPrs as WorkerDoc[]

    return {
      id: orchestration.orchestrationId,
      topic: orchestration.topic,
      repoUrl: orchestration.repoUrl ?? undefined,
      status: orchestration.status,
      turns: typedTurns.map((turn) => ({
        index: turn.index,
        threadId: turn.threadId ?? null,
        finalResponse: turn.finalResponse,
        items: turn.items,
        usage: turn.usage ?? null,
        createdAt: turn.createdAt,
      })),
      workerPRs: typedWorkerPrs.map((pr) => ({
        prUrl: pr.prUrl ?? undefined,
        branch: pr.branch ?? undefined,
        commitSha: pr.commitSha ?? undefined,
        notes: pr.notes ?? undefined,
      })),
      createdAt: orchestration.createdAt,
      updatedAt: orchestration.updatedAt,
    }
  },
})
