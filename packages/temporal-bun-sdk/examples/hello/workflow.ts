import { proxyActivities } from '@temporalio/workflow'

const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'hello-tq'

const { greet } = proxyActivities<{ greet(name: string): Promise<string> }>({
  taskQueue,
  startToCloseTimeout: '1 minute',
})

export async function hello(name: string): Promise<string> {
  return await greet(name)
}
