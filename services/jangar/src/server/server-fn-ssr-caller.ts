import { createClientRpc } from '@tanstack/react-start/client-rpc'

export async function getServerFnById(id: string, _opts?: { fromClient?: boolean }) {
  return createClientRpc(id)
}
