// Replaced @temporalio/workflow with native implementation

const currentStateQuery = defineQuery('currentState')

export async function queryWorkflowSample(initialValue = 'unset') {
  const state = initialValue
  setHandler(currentStateQuery, () => state)
  await sleep(2000)
  return state
}
