export type FixedViewportSize = {
  width: number
  height: number
}

export type TerminalWindowOffset = {
  x: number
  y: number
}

export const resolveTerminalWindowCenter = (input: {
  fixedViewport: FixedViewportSize
  offset: TerminalWindowOffset
  fullscreen: boolean
  fullscreenOffsetY: number
}) => ({
  x: input.fixedViewport.width / 2 + (input.fullscreen ? 0 : input.offset.x),
  y: input.fixedViewport.height / 2 + (input.fullscreen ? input.fullscreenOffsetY : input.offset.y),
})
