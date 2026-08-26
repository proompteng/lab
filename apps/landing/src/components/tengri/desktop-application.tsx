'use client'

import type { TengriDesktopApplicationProps } from './desktop'
import { ChromeApp } from './chrome-app'
import { CodeEditor } from './code-editor'
import { FinderApp } from './finder-app'
import { SettingsApp } from './settings-app'
import { TerminalApp } from './terminal-app'

export function TengriDesktopApplication({
  agent,
  app,
  onAgentChanged,
  onOpenFile,
  selectedFile,
  user,
}: TengriDesktopApplicationProps) {
  if (app === 'finder') return <FinderApp agentId={agent.id} onOpenFile={onOpenFile} />
  if (app === 'chrome') return <ChromeApp agentId={agent.id} />
  if (app === 'code') return <CodeEditor agentId={agent.id} request={selectedFile} />
  if (app === 'terminal') return <TerminalApp agentId={agent.id} />
  return <SettingsApp agent={agent} onAgentChanged={onAgentChanged} user={user} />
}
