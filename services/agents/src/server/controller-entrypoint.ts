import { startAgentsControllerServer } from './control-plane'

if (import.meta.main) {
  await startAgentsControllerServer()
}
