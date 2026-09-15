type SendOptions = {
  readonly to: string
  readonly message: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const activities = {
  async sendGreeting({ to, message }: SendOptions): Promise<string> {
    console.log(`[activity] sendGreeting start -> to=${to}, message="${message}"`)
    await sleep(50)
    const result = `Sent greeting to ${to}: ${message}`
    console.log(`[activity] sendGreeting done -> ${result}`)
    return result
  },

  async recordMetric(name: string, value: number): Promise<{ name: string; value: number }> {
    console.log(`[activity] recordMetric start -> ${name}=${value}`)
    await sleep(10)
    const metric = { name, value }
    console.log('[activity] recordMetric done ->', metric)
    return metric
  },
}

export type ExampleActivities = typeof activities

export default activities
