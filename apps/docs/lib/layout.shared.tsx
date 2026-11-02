import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

const baseConfig: BaseLayoutProps = {
  nav: {
    enabled: true,
    title: 'proompteng',
    url: 'https://proompteng.ai',
  },
  links: [
    {
      type: 'main',
      text: 'Documentation',
      url: '/docs',
      active: 'nested-url',
    },
    {
      type: 'main',
      text: 'Visit proompteng.ai',
      url: 'https://proompteng.ai',
      external: true,
    },
  ],
  searchToggle: {
    enabled: true,
  },
  themeSwitch: {
    enabled: true,
    mode: 'light-dark-system',
  },
}

export function baseOptions(): BaseLayoutProps {
  return {
    ...baseConfig,
    links: [...(baseConfig.links ?? [])],
  }
}
