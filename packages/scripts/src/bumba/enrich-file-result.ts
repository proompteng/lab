export const resolveWorkflowResult = async (
  client: {
    workflow: {
      result: (handle: unknown) => Promise<unknown>
    }
  },
  startResult: {
    handle: unknown
  },
) => client.workflow.result(startResult.handle)
