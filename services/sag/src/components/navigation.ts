import { BookOpenTextIcon, ComputerTerminalIcon, ServerStack01Icon, SwarmIcon } from '@hugeicons/core-free-icons'

export const sidebarItems = [
  {
    title: 'Agents',
    url: '/agents',
    icon: ServerStack01Icon,
  },
  {
    title: 'Agent Runs',
    url: '/agent-runs',
    icon: ComputerTerminalIcon,
  },
  {
    title: 'Swarms',
    url: '/swarms',
    icon: SwarmIcon,
  },
  {
    title: 'Specs',
    url: '/specs',
    icon: BookOpenTextIcon,
  },
] as const
