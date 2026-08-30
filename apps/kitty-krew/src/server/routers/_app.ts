/**
 * This file contains the root router of your tRPC-backend
 */
import { createCallerFactory, router } from '../trpc.ts'
import { podRouter } from './pod.ts'

export const appRouter = router({
  pod: podRouter,
})

export const createCaller = createCallerFactory(appRouter)

export type AppRouter = typeof appRouter
