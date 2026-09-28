/* eslint-disable react/jsx-key */
import { ImageResponse } from 'next/og'

import { TENGRI_PRODUCT_IDENTITY } from '@/lib/tengri/product-identity'

export const size = {
  width: 1_200,
  height: 630,
}

export const contentType = 'image/png'

export default function TengriOpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        background:
          'radial-gradient(circle at 78% 18%, rgba(88, 120, 216, 0.5), transparent 38%), linear-gradient(145deg, #071121 0%, #11142b 55%, #160d2d 100%)',
        color: 'white',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        padding: '72px',
        width: '100%',
      }}
    >
      <div
        style={{
          alignItems: 'flex-start',
          background: 'rgba(31, 37, 54, 0.72)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          borderRadius: '36px',
          boxShadow: '0 40px 100px rgba(0, 0, 0, 0.42)',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px',
          width: '100%',
        }}
      >
        <div style={{ color: '#9bc3ff', display: 'flex', fontSize: 28, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Proompteng
        </div>
        <div style={{ display: 'flex', fontSize: 76, fontWeight: 700, letterSpacing: '-0.045em', marginTop: 18 }}>
          {TENGRI_PRODUCT_IDENTITY.name}
        </div>
        <div style={{ color: 'rgba(255, 255, 255, 0.68)', display: 'flex', fontSize: 30, marginTop: 20 }}>
          Private Firecracker workspace · Files · Code · Terminal · Codex
        </div>
      </div>
    </div>,
    size,
  )
}
