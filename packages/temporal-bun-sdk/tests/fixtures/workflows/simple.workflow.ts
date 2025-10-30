import { sleep } from '@temporalio/workflow'

export async function simpleWorkflow(name: string): Promise<string> {
  return `hello ${name}`
}

export async function timerWorkflow(delayMs: number): Promise<string> {
  await sleep(delayMs)
  return 'timer fired'
}

export async function binaryWorkflow(): Promise<Uint8Array> {
  return new Uint8Array([1, 2, 3])
}
