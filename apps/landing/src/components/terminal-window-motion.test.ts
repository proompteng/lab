import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolveTerminalWindowCenter } from './terminal-window-motion'

void describe('terminal window motion', () => {
  void test('uses the rendered fullscreen center when targeting the dock', () => {
    assert.deepEqual(
      resolveTerminalWindowCenter({
        fixedViewport: { width: 1280, height: 720 },
        offset: { x: 120, y: 80 },
        fullscreen: true,
        fullscreenOffsetY: 44 / 2 - 96 / 2,
      }),
      { x: 640, y: 334 },
    )
  })

  void test('keeps the dragged center for a normal window', () => {
    assert.deepEqual(
      resolveTerminalWindowCenter({
        fixedViewport: { width: 1320, height: 720 },
        offset: { x: 120, y: 80 },
        fullscreen: false,
        fullscreenOffsetY: 44 / 2 - 96 / 2,
      }),
      { x: 780, y: 440 },
    )
  })
})
