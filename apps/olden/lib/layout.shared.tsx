import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

const baseConfig: BaseLayoutProps = {
  nav: {
    enabled: true,
    title: 'Olden Era Wiki',
    url: '/',
  },
  links: [
    {
      type: 'main',
      text: 'Wiki',
      url: '/docs',
      active: 'nested-url',
    },
    {
      type: 'main',
      text: 'Sources',
      url: '/docs/meta/sources',
      active: 'url',
    },
    {
      type: 'main',
      text: 'Official Wiki',
      url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page',
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
