export type EchoActivityInput = {
  message: string
}

export const echoActivity = async ({ message }: EchoActivityInput): Promise<string> => {
  return message
}

export const sleepActivity = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
