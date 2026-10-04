import type { ReactNode } from 'react'

export const metadata = {
  description: 'Payload CMS for proompteng.ai',
  title: 'proompteng CMS',
  robots: {
    index: false,
    follow: false,
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
