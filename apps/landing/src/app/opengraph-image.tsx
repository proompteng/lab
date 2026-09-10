/* eslint-disable react/jsx-key */
import { ImageResponse } from 'next/og'

export const size = {
  width: 1200,
  height: 630,
}

export const contentType = 'image/png'

export default function OgImage() {
  const shellClasses =
    'flex h-full w-full items-center justify-center bg-[#0e0e10] text-white [font-size:64px] [letter-spacing:-0.02em] font-semibold'

  return new ImageResponse(
    <div
      {...({
        tw: shellClasses,
      } as React.HTMLAttributes<HTMLDivElement> & { tw: string })}
    >
      proompteng — ai infrastructure for agents
    </div>,
    {
      ...size,
    },
  )
}
