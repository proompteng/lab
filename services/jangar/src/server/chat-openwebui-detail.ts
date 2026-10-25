import type { ChatConfig, OpenWebUIRenderRuntime } from './chat-config'
import { resolveOpenWebUIRenderRuntime } from './chat-config'
import { recordOpenWebUIDetailTurn, recordOpenWebUITextOnlyFallback } from './metrics'

let hasLoggedMissingOpenWebUIRenderRuntime = false

const isOpenWebUIDetailLinksRequested = (chatClientKind: string, config: ChatConfig) =>
  chatClientKind === 'openwebui' && config.openWebUIRichRenderEnabled

export type OpenWebUIDetailMode = {
  openWebUIDetailLinksEnabled: boolean
  experimentalJangarEventEnabled: boolean
  openWebUIRenderRuntime: OpenWebUIRenderRuntime | null
}

export const resolveOpenWebUIDetailMode = (
  chatClientKind: string,
  request: Request,
  config: ChatConfig,
): OpenWebUIDetailMode => {
  const requested = isOpenWebUIDetailLinksRequested(chatClientKind, config)
  const runtime = resolveOpenWebUIRenderRuntime(config)
  const enabled = requested && runtime !== null
  const requestedMode = request.headers.get('x-jangar-openwebui-render-mode')?.trim().toLowerCase()

  if (chatClientKind === 'openwebui') {
    recordOpenWebUIDetailTurn(enabled ? 'enabled' : requested ? 'text_only' : 'disabled')
  }
  if (requested && !runtime) {
    recordOpenWebUITextOnlyFallback('render_runtime_missing')
    if (!hasLoggedMissingOpenWebUIRenderRuntime) {
      hasLoggedMissingOpenWebUIRenderRuntime = true
      console.warn(
        '[chat] openwebui rich detail requested but JANGAR_OPENWEBUI_EXTERNAL_BASE_URL or signing secret is missing; falling back to text-only mode',
      )
    }
  }

  return {
    openWebUIDetailLinksEnabled: enabled,
    experimentalJangarEventEnabled: requested && requestedMode === 'rich-ui-v1',
    openWebUIRenderRuntime: runtime,
  }
}
