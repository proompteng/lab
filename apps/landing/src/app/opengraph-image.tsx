/* eslint-disable react/jsx-key */
import { ImageResponse } from 'next/og'

export const size = {
  width: 1200,
  height: 630,
}

export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    <div
      style={{
        fontSize: 64,
        background: '#0e0e10',
        color: '#ffffff',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        letterSpacing: '-0.02em',
        fontWeight: 600,
      }}
    >
      proompteng — ai infrastructure for agents
    </div>,
    {
      ...size,
    },
  )
}
