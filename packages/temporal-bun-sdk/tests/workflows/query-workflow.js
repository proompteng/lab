import { defineQuery, defineSignal, setHandler, sleep } from '@temporalio/workflow'

const currentStateQuery = defineQuery('currentState')
const setStateSignal = defineSignal('setState')

export async function queryWorkflowSample(initialValue = 'unset') {
  let state = initialValue
  setHandler(currentStateQuery, () => state)
  setHandler(setStateSignal, (next) => {
    state = next
  })
  await sleep(2000)
  return state
}
