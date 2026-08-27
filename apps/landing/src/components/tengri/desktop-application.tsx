'use client'

import type { TengriDesktopApplicationProps } from './desktop'
import { ChromeApp } from './chrome-app'
import { CodeEditor } from './code-editor'
import { FinderApp } from './finder-app'
import { SettingsApp } from './settings-app'
import { TerminalApp } from './terminal-app'

export function TengriDesktopApplication({
  active,
  agent,
  app,
  hasUnsavedChanges,
  onAgentChanged,
  onDirtyChange,
  onOpenFile,
  previewGatewayOrigin,
  registerWindowCloseHandler,
  selectedDirectory,
  selectedFile,
  user,
  windowId,
}: TengriDesktopApplicationProps) {
  if (app === 'finder')
    return <FinderApp active={active} agentId={agent.id} onOpenFile={onOpenFile} request={selectedDirectory} />
  if (app === 'chrome')
    return <ChromeApp active={active} agentId={agent.id} previewGatewayOrigin={previewGatewayOrigin} />
  if (app === 'code')
    return <CodeEditor active={active} agentId={agent.id} onDirtyChange={onDirtyChange} request={selectedFile} />
  if (app === 'terminal') {
    return (
      <TerminalApp agentId={agent.id} registerWindowCloseHandler={registerWindowCloseHandler} windowId={windowId} />
    )
  }
  return <SettingsApp agent={agent} hasUnsavedChanges={hasUnsavedChanges} onAgentChanged={onAgentChanged} user={user} />
}
