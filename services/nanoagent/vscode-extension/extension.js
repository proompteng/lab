const vscode = require('vscode')
const path = require('node:path')

exports.activate = async function activate(context) {
  const workspaceRoot = process.env.TENGRI_WORKSPACE_ROOT
  if (!workspaceRoot) throw new Error('Tengri workspace is unavailable')
  const external = await vscode.env.asExternalUri(vscode.Uri.parse('http://127.0.0.1:13337'))
  const session = /^tengri-([a-z0-9]{24})\./.exec(external.authority)?.[1]
  if (!session) throw new Error('Tengri editor session is unavailable')
  let socket
  let disposed = false
  let reconnect
  const send = (value) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }
  const isDirty = () =>
    vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty)) ||
    vscode.workspace.textDocuments.some((document) => document.isDirty)
  const publish = () => send({ type: 'state', dirty: isDirty() })
  const open = async (request) => {
    if (
      typeof request.path !== 'string' ||
      !request.path.startsWith('/') ||
      request.path.length > 4096 ||
      request.path.includes('\0') ||
      request.path.includes('\r') ||
      request.path.includes('\n')
    ) {
      throw new Error('Invalid workspace file path')
    }
    const target = path.resolve(workspaceRoot, '.' + request.path)
    if (!target.startsWith(workspaceRoot + path.sep)) throw new Error('File is outside the workspace')
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
    await vscode.window.showTextDocument(document, { preview: false })
  }
  const connect = () => {
    if (disposed) return
    socket = new WebSocket(`ws://127.0.0.1:13338/?session=${session}`)
    socket.addEventListener('open', publish)
    socket.addEventListener('message', async (event) => {
      let request
      try {
        request = JSON.parse(String(event.data))
        if (request.type === 'state') {
          publish()
          return
        }
        if (typeof request.id !== 'string' || request.id.length > 128) return
        if (request.type === 'close') {
          const closed = await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((group) => group.tabs))
          send({ type: 'result', id: request.id, dirty: !closed || isDirty() })
          return
        } else if (request.type === 'open') await open(request)
        else if (request.type !== 'check') return
        send({ type: 'result', id: request.id, dirty: isDirty() })
      } catch (error) {
        send({ type: 'result', id: request?.id, error: error instanceof Error ? error.message : 'Could not open file' })
      }
    })
    socket.addEventListener('error', () => socket.close())
    socket.addEventListener('close', (event) => {
      if (event.reason === 'editor superseded') disposed = true
      if (!disposed) reconnect = setTimeout(connect, 1000)
    })
  }
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(publish),
    vscode.workspace.onDidChangeTextDocument(publish),
    vscode.workspace.onDidSaveTextDocument(publish),
    vscode.workspace.onDidCloseTextDocument(publish),
    {
      dispose() {
        disposed = true
        clearTimeout(reconnect)
        socket?.close()
      },
    },
  )
  connect()
}
