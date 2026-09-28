import { createActor, createMachine } from 'xstate'

const agentsControllerLifecycleMachine = createMachine({
  id: 'agentsControllerLifecycle',
  initial: 'idle',
  states: {
    idle: {
      on: {
        START: 'starting',
        STOP: 'idle',
      },
    },
    starting: {
      on: {
        STARTED: 'running',
        FAILED: 'idle',
        STOP: 'idle',
      },
    },
    running: {
      on: {
        STOP: 'idle',
        START: 'running',
      },
    },
  },
})

export type AgentsControllerLifecycleActor = ReturnType<typeof createAgentsControllerLifecycleActor>
export type AgentsControllerLifecycleStatus = 'idle' | 'starting' | 'running'

const toStatus = (
  snapshot: ReturnType<AgentsControllerLifecycleActor['getSnapshot']>,
): AgentsControllerLifecycleStatus => {
  if (snapshot.matches('starting')) return 'starting'
  if (snapshot.matches('running')) return 'running'
  return 'idle'
}

export const createAgentsControllerLifecycleActor = () => {
  const actor = createActor(agentsControllerLifecycleMachine)
  actor.start()
  return actor
}

export const getAgentsControllerLifecycleStatus = (
  actor: AgentsControllerLifecycleActor,
): AgentsControllerLifecycleStatus => toStatus(actor.getSnapshot())

export const requestAgentsControllerStart = (actor: AgentsControllerLifecycleActor) => {
  if (getAgentsControllerLifecycleStatus(actor) !== 'idle') return false
  actor.send({ type: 'START' })
  return true
}

export const markAgentsControllerStarted = (actor: AgentsControllerLifecycleActor) => {
  if (getAgentsControllerLifecycleStatus(actor) !== 'starting') return
  actor.send({ type: 'STARTED' })
}

export const markAgentsControllerStartFailed = (actor: AgentsControllerLifecycleActor) => {
  if (getAgentsControllerLifecycleStatus(actor) !== 'starting') return
  actor.send({ type: 'FAILED' })
}

export const requestAgentsControllerStop = (actor: AgentsControllerLifecycleActor) => {
  actor.send({ type: 'STOP' })
}
