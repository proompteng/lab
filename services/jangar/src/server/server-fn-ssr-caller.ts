import { createClientRpc } from '@tanstack/start-client-core/client-rpc'

export async function getServerFnById(id: string, _opts?: { fromClient?: boolean }) {
  return createClientRpc(id)
}
