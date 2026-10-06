import { Schema } from 'effect'

const SendOptions = Schema.Struct({ to: Schema.String, message: Schema.String })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const activities = {
  async sendGreeting(input: unknown): Promise<string> {
    const { to, message } = Schema.decodeUnknownSync(SendOptions)(input)
    console.log(`[activity] sendGreeting start -> to=${to}, message="${message}"`)
    await sleep(50)
    const result = `Sent greeting to ${to}: ${message}`
    console.log(`[activity] sendGreeting done -> ${result}`)
    return result
  },

  async recordMetric(rawName: unknown, rawValue: unknown): Promise<{ name: string; value: number }> {
    const name = Schema.decodeUnknownSync(Schema.String)(rawName)
    const value = Schema.decodeUnknownSync(Schema.Number)(rawValue)
    console.log(`[activity] recordMetric start -> ${name}=${value}`)
    await sleep(10)
    const metric = { name, value }
    console.log('[activity] recordMetric done ->', metric)
    return metric
  },
}

export type ExampleActivities = typeof activities

export default activities
