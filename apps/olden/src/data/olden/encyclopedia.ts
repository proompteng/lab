import type { EncyclopediaEntry } from './schema'

// Generated from public JSON-LD/link metadata on olden-era.com and heroes-olden-era.com on 2026-05-31.
// Keep descriptions short in UI and link back to source pages for provenance.

export const encyclopediaSourceMeta = [
  {
    page: 'heroes',
    url: 'https://www.olden-era.com/en/heroes',
    rows: 50,
  },
  {
    page: 'skills',
    url: 'https://www.olden-era.com/en/skills',
    rows: 90,
  },
  {
    page: 'laws',
    url: 'https://www.olden-era.com/en/laws',
    rows: 193,
  },
  {
    page: 'spells',
    url: 'https://www.olden-era.com/en/spells',
    rows: 94,
  },
  {
    page: 'classes',
    url: 'https://www.olden-era.com/en/classes',
    rows: 12,
  },
  {
    page: 'factions',
    url: 'https://www.olden-era.com/en/factions',
    rows: 7,
  },
  {
    page: 'artefacts',
    url: 'https://www.olden-era.com/en/artefacts',
    rows: 151,
  },
  {
    page: 'building',
    url: 'https://heroes-olden-era.com/en/building',
    rows: 200,
  },
  {
    page: 'objects-neutral',
    url: 'https://www.olden-era.com/en/objects-neutral',
    rows: 62,
  },
  {
    page: 'objects-combat',
    url: 'https://www.olden-era.com/en/objects-combat',
    rows: 25,
  },
  {
    page: 'resources',
    url: 'https://www.olden-era.com/en/resources',
    rows: 7,
  },
] as const

export const heroEntries = [
  {
    id: 'niev',
    name: 'Niev',
    description:
      'Niev — hive faction specialty: Creatures in her army deal +10% basic attack Damage, plus an additional 1% for every 2 hero level(s). Additionally, they deal +1% Ranged and Long Reach Damage for every 2 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/niev',
    image: 'https://i.ibb.co/n8CDPFd9/niev.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_offence',
    },
  },
  {
    id: 'maelstrom',
    name: 'Maelstrom',
    description:
      'Maelstrom — hive faction specialty: Reaver growth in your cities increases by 1. Under his command, Reavers gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Reavers lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/maelstrom',
    image: 'https://i.ibb.co/SXK6Knyt/maelstrom.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_insight',
    },
  },
  {
    id: 'nor',
    name: 'Nor',
    description:
      'Nor — hive faction specialty: When leveling up, he gains 1 additional attribute point(s) for every 2 hero level(s). He gains +5% XP for every 2 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/nor',
    image: 'https://i.ibb.co/7tMHTjdf/nor.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_battlecraft',
    },
  },
  {
    id: 'zora-the-self-founded',
    name: 'Zoran, the Self‑Founded',
    description:
      'Zoran, the Self‑Founded — hive faction specialty: Waurms growth in your cities increases by 1. Under his command, Waurmos gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Waurmos lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/zora_the_self_founded',
    image: 'https://i.ibb.co/Xf3p7DqX/zora-the-self-founded.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_nightshade_magic',
    },
  },
  {
    id: 'curson-duke-of-rage',
    name: 'Curson, Duke of Rage',
    description:
      'Curson, Duke of Rage — hive faction specialty: His Heroic Strike deals +10 Damage, plus 5 more for every 6 hero level(s). Additionally, it reduces the target’s Initiative by 1 until the battle end. This effect is stackable.',
    url: 'https://www.olden-era.com/en/heroes/curson_duke_of_rage',
    image: 'https://i.ibb.co/tMK4wVSn/curson-duke-of-rage.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_combat',
    },
  },
  {
    id: 'tavi',
    name: 'Tavi',
    description:
      'Tavi — hive faction specialty: Her summoned Fire Larva stacks have +4% health, plus another 1% for every 2 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/tavi',
    image: 'https://i.ibb.co/1fBmbPf8/tavi.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'advanced_summon_swarm',
    },
  },
  {
    id: 'lo',
    name: 'Lo',
    description:
      'Lo — hive faction specialty: Locust growth in your cities increases by 1. Under her command, Locusts gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Locusts lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/lo',
    image: 'https://i.ibb.co/Kp0DRThk/lo.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_avatar, basic_defence',
    },
  },
  {
    id: 'goldentongue',
    name: 'Goldentongue',
    description:
      'Goldentongue — hive faction specialty: Friendly creatures have +1 Morale. They also have a higher chance of triggering the positive Morale effect: +2% chance per Morale point. For every 4 levels, this bonus increases by 1%.',
    url: 'https://www.olden-era.com/en/heroes/goldentongue',
    image: 'https://i.ibb.co/GfXpGVMN/goldentongue.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_leadership',
    },
  },
  {
    id: 'abigor-duke-of-battle',
    name: 'Abigor, Duke of Battle',
    description:
      'Abigor, Duke of Battle — hive faction specialty: In the Tactics Phase, he has +1 hex to the creature placement range. Creatures in his army gain 1 Initiative for every 6 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/abigor_duke_of_battle',
    image: 'https://i.ibb.co/8gxkNsjW/abigor-duke-of-battle.webp',
    properties: {
      Faction: 'hive',
      Class: 'enforcer',
      'Starting Skills': 'basic_summon_swarm, basic_tactics',
    },
  },
  {
    id: 'fleu',
    name: 'Fleu',
    description:
      'Fleu — hive faction specialty: She has +5% Movement points for every 8 hero level(s). Moves significantly more efficiently on roads.',
    url: 'https://www.olden-era.com/en/heroes/fleu',
    image: 'https://i.ibb.co/VWvPjxxB/fleu.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_logistics',
    },
  },
  {
    id: 'xirr',
    name: 'Xirr',
    description:
      'Xirr — hive faction specialty: He is immune to negative effects in battles and on the global map. His creatures take –10% Magic Damage, and an additional –2% for every 3 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/xirr',
    image: 'https://i.ibb.co/7dN6MNY8/xirr.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_resistance',
    },
  },
  {
    id: 'bathym-duke-of-jewels',
    name: 'Bathym, Duke of Jewels',
    description:
      'Bathym, Duke of Jewels — hive faction specialty: He produces +1 Crystals per day, plus another +1 for every 5 hero level(s). Increases the amount of Crystals found on the map by 100%.',
    url: 'https://www.olden-era.com/en/heroes/bathym_duke_of_jewels',
    image: 'https://i.ibb.co/N2r7QNSL/bathym-duke-of-jewels.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_economy',
    },
  },
  {
    id: 'leira',
    name: 'Leira',
    description:
      'Leira — hive faction specialty: Hornet growth in your cities increases by 1. Under her command, Hornets gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Hornets lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/leira',
    image: 'https://i.ibb.co/C54Gggvq/leira.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_battle_magic',
    },
  },
  {
    id: 'groo',
    name: 'Groo',
    description:
      'Groo — hive faction specialty: Hive Queen growth in your cities increases by 1. Under his command, Hive Queens gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Hive Queens lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/groo',
    image: 'https://i.ibb.co/Df8TRV9k/groo.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_intelligence',
    },
  },
  {
    id: 'mila',
    name: 'Mila',
    description:
      'Mila — hive faction specialty: She starts with the “Masterful Haste” spell. This version of the spell affects all friendly creatures. While casting this spell, effective Spell Power is increased by 1 for every 3 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/mila',
    image: 'https://i.ibb.co/Fk4BqNBf/mila.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_daylight_magic',
    },
  },
  {
    id: 'oriax',
    name: 'Oriax',
    description:
      'Oriax — hive faction specialty: She starts with the “Masterful Blink” spell. This version of the spell can target enemy creatures. The cost of this spell is reduced by 1 mana for every 3 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/oriax',
    image: 'https://i.ibb.co/Rk38m81P/oriax.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_summon_avatar',
    },
  },
  {
    id: 'khariseth',
    name: 'Khariseth',
    description:
      'Khariseth — hive faction specialty: They receive +1 level to all Primal spells, plus another +1 for every 10 hero levels. Casting Primal spells does not prevent them from using other spells of the same Magic School. Enemy hero cannot cast Primal spells.',
    url: 'https://www.olden-era.com/en/heroes/khariseth',
    image: 'https://i.ibb.co/FqVSvNBL/khariseth.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_primal_magic',
    },
  },
  {
    id: 'pauper',
    name: 'Pauper',
    description:
      'Pauper — hive faction specialty: Friendly creatures have +1 Speed, plus an additional 1 for every 8 hero level(s).',
    url: 'https://www.olden-era.com/en/heroes/pauper',
    image: 'https://i.ibb.co/1YtMQrzb/pauper.webp',
    properties: {
      Faction: 'hive',
      Class: 'herald',
      'Starting Skills': 'basic_summon_swarm, basic_battle_magic',
    },
  },
  {
    id: 'eith',
    name: 'Eith',
    description:
      'Eith — sylvan faction specialty: His movement takes no terrain penalties. He also has +1 Sight Radius, plus an additional +1 for every 5 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/eith',
    image: 'https://i.ibb.co/DTJ6qbf/eith.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_scouting',
    },
  },
  {
    id: 'gorel-spearhead',
    name: 'Gorel Spearhead',
    description:
      'Gorel Spearhead — sylvan faction specialty: Creatures in his army deal +10% basic attack damage, plus an additional +1% for every 2 hero levels. Additionally, they deal +1% Ranged and Long Reach damage for every 2 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/gorel_spearhead',
    image: 'https://i.ibb.co/9kZgMrhc/gorel-spearhead.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_offence',
    },
  },
  {
    id: 'gingertail',
    name: 'Gingertail',
    description:
      'Gingertail — sylvan faction specialty: Faun growth in your cities increases by 1. Under her command, Fauns gain +1 Speed, +1 Initiative, and +20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Fauns lose an equal amount of Attack and Defense.',
    url: 'https://www.olden-era.com/en/heroes/gingertail',
    image: 'https://i.ibb.co/sv9tn6tB/gingertail.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_battlecraft',
    },
  },
  {
    id: 'old-piligrim',
    name: 'Old Piligrim',
    description:
      'Old Piligrim — sylvan faction specialty: He starts with the "Masterful Guillotine" spell. This version of the spell deals damage that increases twice as fast when cast on the same target. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/old_piligrim',
    image: 'https://i.ibb.co/whbynJ7c/old-piligrim.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_battle_magic',
    },
  },
  {
    id: 'octavia',
    name: 'Octavia',
    description:
      'Octavia — sylvan faction specialty: She has +1 Luck. Creatures under her command have an increased chance of triggering a Lucky Strike: +2% chance per Luck point. For every 4 hero levels, this bonus increases by an additional 1%.',
    url: 'https://www.olden-era.com/en/heroes/octavia',
    image: 'https://i.ibb.co/Fb7bBs3j/octavia.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_luck',
    },
  },
  {
    id: 'mreowa',
    name: 'Mreowa',
    description:
      'Mreowa — sylvan faction specialty: She produces +1 Crystal per day, plus an additional +1 for every 5 hero levels. Increases the amount of Crystals found on the map by 100%.',
    url: 'https://www.olden-era.com/en/heroes/mreowa',
    image: 'https://i.ibb.co/Txb9YZR2/mreowa.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_sorcery',
    },
  },
  {
    id: 'faleor',
    name: 'Faleor',
    description:
      'Faleor — sylvan faction specialty: He starts with the "Masterful Fireball" spell. This version of the spell hits a larger area. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/faleor',
    image: 'https://i.ibb.co/mV8JCPRf/faleor.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'advanced_murmuring',
    },
  },
  {
    id: 'alluring-sh-a',
    name: "Alluring Sh'a",
    description:
      "Alluring Sh'a — sylvan faction specialty: Retains the army when fleeing from battle against neutral squads. +5% Persuasion Power when using Diplomacy, plus an additional +1% for every 4 hero levels.",
    url: 'https://www.olden-era.com/en/heroes/alluring_sh_a',
    image: 'https://i.ibb.co/j9yKz16v/alluring-sh-a.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_diplomacy',
    },
  },
  {
    id: 'aunt-daliar',
    name: 'Autn Daliar',
    description:
      'Autn Daliar — sylvan faction specialty: When leveling up, she gains 1 additional attribute point for every 2 hero levels. She gains +5% XP for every 2 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/aunt_daliar',
    image: 'https://i.ibb.co/k2t8LPGH/aunt-daliar.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'warden',
      'Starting Skills': 'basic_murmuring, basic_insight',
    },
  },
  {
    id: 'vatawna',
    name: 'Vatawna',
    description:
      'Vatawna — sylvan faction specialty: +1 spell slot for each Global Map spell. Her maximum mana increases by 10%, plus an additional 5% for every 5 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/vatawna',
    image: 'https://i.ibb.co/wZzqCJPW/vatawna.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_intelligence',
    },
  },
  {
    id: 'elder-tss-kish',
    name: "Elder Tss'kish",
    description:
      "Elder Tss'kish — sylvan faction specialty: Herbomancer growth in your cities increases by 1. Under his command, Herbomancers gain +1 Speed, +1 Initiative, and +20% HP. Their Attack and Defense increase by 1 for every 3 hero levels, and enemy Herbomancers lose an equal amount of Attack and Defense.",
    url: 'https://www.olden-era.com/en/heroes/elder_tss_kish',
    image: 'https://i.ibb.co/rfGL7qfL/elder-tss-kish.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_thaumaturgy',
    },
  },
  {
    id: 'aeliniel',
    name: 'Aeliniel',
    description:
      'Aeliniel — sylvan faction specialty: She starts with the "Masterful Firewall" spell. This version of the spell stays active for +1 additional round. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/aeliniel',
    image: 'https://i.ibb.co/tWqsnBs/aeliniel.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_primal_magic',
    },
  },
  {
    id: 'glacia',
    name: 'Glacia',
    description:
      'Glacia — sylvan faction specialty: She starts with the "Masterful Ice Bolt" spell. The Initiative penalty of this version of the spell is twice as strong. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/glacia',
    image: 'https://i.ibb.co/1YqngRtb/glacia.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_primal_magic',
    },
  },
  {
    id: 'vim',
    name: 'Vim',
    description:
      'Vim — sylvan faction specialty: He starts with the "Masterful Cave In" spell. The obstacles created by this version of the spell must be damaged 1 additional time to be destroyed. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/vim',
    image: 'https://i.ibb.co/pvMVd2n6/vim.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_primal_magic',
    },
  },
  {
    id: 'halon',
    name: 'Halon',
    description:
      'Halon — sylvan faction specialty: He starts with the "Masterful Chain Lightning" spell. This version of the spell loses half as much damage when jumping between targets. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/halon',
    image: 'https://i.ibb.co/mFHYSQn0/halon.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_primal_magic',
    },
  },
  {
    id: 'echolily',
    name: 'Echolily',
    description:
      'Echolily — sylvan faction specialty: She starts with the "Masterful Mirror Copy" spell. This version of the spell can target enemy creatures. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/echolily',
    image: 'https://i.ibb.co/4R6tPwHg/echolily.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_arcane_magic',
    },
  },
  {
    id: 'sullie',
    name: 'Sullie',
    description:
      'Sullie — sylvan faction specialty: Her summoned Avatar is immune to Magic Damage. When casting Summon Avatar, its effective Spell Power is increased by 1 for every 3 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/sullie',
    image: 'https://i.ibb.co/7xwkQn6p/sullie.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_summon_avatar',
    },
  },
  {
    id: 'the-minstrel',
    name: 'The Minstrel',
    description:
      'The Minstrel — sylvan faction specialty: At the beginning of each round, he generates +2 Focus Points, plus an additional +1 for every 3 hero levels. The enemy loses the same amount of Focus Points.',
    url: 'https://www.olden-era.com/en/heroes/the_minstrel',
    image: 'https://i.ibb.co/4ZxSq0Qh/the-minstrel.webp',
    properties: {
      Faction: 'sylvan',
      Class: 'druid',
      'Starting Skills': 'basic_murmuring, basic_sorcery',
    },
  },
  {
    id: 'enatee',
    name: 'Enatee',
    description:
      'Enatee — dungeon faction specialty: Slitering Menace - Medusae growth in your cities increases by 1. Under her command, Medusae gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defence increase by 1 for every 3 hero levels, and enemy Medusae lose an equal amount of Attack and Defence.',
    url: 'https://www.olden-era.com/en/heroes/enatee',
    image: 'https://i.ibb.co/PZPMVCt8/enatee.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_defence',
    },
  },
  {
    id: 'tellaris-the-betrayed',
    name: 'Tellaris the Betrayed',
    description:
      'Tellaris the Betrayed — dungeon faction specialty: With One Eye - Open Starts with the “Masterful Early Start” spell. This version of the spell cannot be dispelled by any means. While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels..',
    url: 'https://www.olden-era.com/en/heroes/tellaris_the_betrayed',
    image: 'https://i.ibb.co/Q5LPxqN/tellaris-the-betrayed.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_battlecraft',
    },
  },
  {
    id: 'stinger',
    name: 'Stinger',
    description:
      "Stinger — dungeon faction specialty: Venomous Strike - Her Heroic Strike deals +40 Damage, plus 5 more for every 3 hero levels. Additionally, poisons the target until the end of the next round, dealing [25 × (1 ＋ hero's Level × 0.1)] Magic Damage.",
    url: 'https://www.olden-era.com/en/heroes/stinger',
    image: 'https://i.ibb.co/TXq328k/stinger.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'advanced_triumvirates_strength',
    },
  },
  {
    id: 'kieran',
    name: 'Kieran',
    description:
      'Kieran — dungeon faction specialty: The Blind Folk - Troglodytes growth in your cities increases by 1. Under his command, Troglodytes gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defence increase by 1 for every 3 hero levels, and enemy Troglodytes lose an equal amount of Attack and Defence.',
    url: 'https://www.olden-era.com/en/heroes/kieran',
    image: 'https://i.ibb.co/s9hwxVBV/kieran.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_tactics',
    },
  },
  {
    id: 'mouaren',
    name: 'Mouaren',
    description:
      'Mouaren — dungeon faction specialty: Spy - Infiltrators growth in your cities increases by 1. Under his command, Infiltrators gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defence increase by 1 for every 3 hero levels, and enemy Infiltrators lose an equal amount of Attack and Defence.',
    url: 'https://www.olden-era.com/en/heroes/mouaren',
    image: 'https://i.ibb.co/bjRPG3zy/mouaren.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_scouting',
    },
  },
  {
    id: 'devir-son-of-devir',
    name: 'Devir, son of Devir',
    description:
      "Devir, son of Devir — dungeon faction specialty: Balthazar's Lair - Minotaurs growth in your cities increases by 1. Under his command, Minotaurs gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defence increase by 1 for every 3 hero levels, and enemy Minotaurs lose an equal amount of Attack and Defence.",
    url: 'https://www.olden-era.com/en/heroes/devir_son_of_devir',
    image: 'https://i.ibb.co/35RNzQrd/devir-son-of-devir.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_leadership',
    },
  },
  {
    id: 'creta-daughter-of-navarr',
    name: 'Creta, daughter of Navarr',
    description:
      'Creta, daughter of Navarr — dungeon faction specialty: Creta, daughter of NavarrGem Seeker - Produces 1 Gem per day, +1 more for every 5 hero levels. Increases the amount of Gems found on the map by 100%.',
    url: 'https://www.olden-era.com/en/heroes/creta_daughter_of_navarr',
    image: 'https://i.ibb.co/ymWXMTwR/creta-daughter-of-navarr.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_economy',
    },
  },
  {
    id: 'rhea',
    name: 'Rhea',
    description:
      'Rhea — dungeon faction specialty: Four-Leaf Horseshoe - +1 Luck. For each point of Luck, creatures have +2% chance to deal a critical strike. For every 4 levels, +1% to this bonus.',
    url: 'https://www.olden-era.com/en/heroes/rhea',
    image: 'https://i.ibb.co/wFpqsX7w/rhea.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_luck',
    },
  },
  {
    id: 'gleard-the-grey',
    name: 'Gleard the Grey',
    description:
      'Gleard the Grey — dungeon faction specialty: Arcane Dominion - Receives +1 level to all Arcane spells, plus 1 more for every 10 hero levels and can use it in battle without limits. Enemy hero cannot cast Arcane spells.',
    url: 'https://www.olden-era.com/en/heroes/gleard_the_grey',
    image: 'https://i.ibb.co/Qjq1rrGF/gleard-the-grey.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'overlord',
      'Starting Skills': 'basic_triumvirates_strength, basic_arcane_magic',
    },
  },
  {
    id: 'kelarr-son-of-navarr',
    name: 'Kelarr, son of Navarr',
    description:
      'Kelarr, son of Navarr — dungeon faction specialty: Wish to Learn - Gains 25% XP, plus 5% for every 2 hero levels. When leveling up, gains 1 additional attribute point(s) for every 2 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/kelarr_son_of_navarr',
    image: 'https://i.ibb.co/N6jpKbz5/kelarr-son-of-navarr.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'warlock',
      'Starting Skills': 'basic_triumvirates_strength, basic_insight',
    },
  },
  {
    id: 'zakron-the-great',
    name: 'Zakron the Great',
    description:
      "Zakron the Great — dungeon faction specialty: Spellweaver - Deals +10% Damage with spells, plus 1% more for every 2 hero levels. The Damage from the enemy hero's spells is reduced by the same value.",
    url: 'https://www.olden-era.com/en/heroes/zakron_the_great',
    image: 'https://i.ibb.co/PGxzrZGJ/zakron-the-great.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'warlock',
      'Starting Skills': 'basic_triumvirates_strength, basic_sorcery',
    },
  },
  {
    id: 'sister-deira',
    name: 'Sister Deira',
    description:
      "Sister Deira — dungeon faction specialty: Mask of the Sun - Starts with the “Masterful Arina's Chosen” spell. This version of the spell gives the target +1 action point(s). While casting this spell, effective Spell Power is increased by 1 for every 3 hero levels.",
    url: 'https://www.olden-era.com/en/heroes/sister_deira',
    image: 'https://i.ibb.co/SD7zdtCj/sister-deira.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'warlock',
      'Starting Skills': 'basic_triumvirates_strength, basic_thaumaturgy',
    },
  },
  {
    id: 'motley',
    name: 'Motley',
    description:
      'Motley — dungeon faction specialty: Danse Macabre - Onyx Dancers growth in your cities increases by 1. Under her command, Onyx Dancers gain 1 Speed, 1 Initiative, and 20% HP. Their Attack and Defence increase by 1 for every 3 hero levels, and enemy Onyx Dancers lose an equal amount of Attack and Defence.',
    url: 'https://www.olden-era.com/en/heroes/motley',
    image: 'https://i.ibb.co/dwwgGcLV/motley.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'warlock',
      'Starting Skills': 'basic_triumvirates_strength, basic_luck',
    },
  },
  {
    id: 'ylwari',
    name: 'Ylwari',
    description:
      'Ylwari — dungeon faction specialty: Charismatic - Keeps her army when fleeing from battle with neutral squads. +5% Persuasion Power when using Diplomacy, plus 1% more for every 4 hero levels.',
    url: 'https://www.olden-era.com/en/heroes/ylwari',
    image: 'https://i.ibb.co/W4L0wfvN/ylwari.webp',
    properties: {
      Faction: 'dungeon',
      Class: 'warlock',
      'Starting Skills': 'basic_triumvirates_strength, basic_diplomacy',
    },
  },
] satisfies EncyclopediaEntry[]

export const skillEntries = [
  {
    id: 'basic-murmuring',
    name: 'Basic Murmuring',
    description: 'Basic Murmuring — murmuring skill Generates 1 Focus Charge(s) at the start of every battle.',
    url: 'https://www.olden-era.com/en/skills/basic_murmuring',
    image: 'https://www.olden-era.com/img/skills/basic_murmuring.webp',
    properties: {
      'Base Skill / Category': 'murmuring',
    },
  },
  {
    id: 'advanced-murmuring',
    name: 'Advanced Murmuring',
    description: 'Advanced Murmuring — murmuring skill Generates 2 Focus Charge(s) at the start of every battle.',
    url: 'https://www.olden-era.com/en/skills/advanced_murmuring',
    image: 'https://www.olden-era.com/img/skills/advanced_murmuring.webp',
    properties: {
      'Base Skill / Category': 'murmuring',
    },
  },
  {
    id: 'expert-murmuring',
    name: 'Expert Murmuring',
    description: 'Expert Murmuring — murmuring skill Generates 3 Focus Charge(s) at the start of every battle.',
    url: 'https://www.olden-era.com/en/skills/expert_murmuring',
    image: 'https://www.olden-era.com/img/skills/expert_murmuring.webp',
    properties: {
      'Base Skill / Category': 'murmuring',
    },
  },
  {
    id: 'basic-summon-swarm',
    name: 'Basic Summon Swarm',
    description:
      'Basic Summon Swarm — summon_swarm skill Once per round, lays eggs on the battlefield. At the start of next round, they spawn a stack of Fire Larvae. The stack has 8% of the total HP of all Hive Spawns in its army, and the strength of its abilities scales with the hero’s level.',
    url: 'https://www.olden-era.com/en/skills/basic_summon_swarm',
    image: 'https://www.olden-era.com/img/skills/basic_summon_swarm.webp',
    properties: {
      'Base Skill / Category': 'summon_swarm',
    },
  },
  {
    id: 'advanced-summon-swarm',
    name: 'Advanced Summon Swarm',
    description:
      'Advanced Summon Swarm — summon_swarm skill Once per round, lays eggs on the battlefield. At the start of next round, they spawn a stack of Fire Larvae. The stack has 12% of the total HP of all Hive Spawns in its army, and the strength of its abilities scales with the hero’s level.',
    url: 'https://www.olden-era.com/en/skills/advanced_summon_swarm',
    image: 'https://www.olden-era.com/img/skills/advanced_summon_swarm.webp',
    properties: {
      'Base Skill / Category': 'summon_swarm',
    },
  },
  {
    id: 'expert-summon-swarm',
    name: 'Expert Summon Swarm',
    description:
      'Expert Summon Swarm — summon_swarm skill Once per round, lays eggs on the battlefield. At the start of next round, they spawn a stack of Fire Larvae. The stack has 16% of the total HP of all Hive Spawns in its army, and the strength of its abilities scales with the hero’s level.',
    url: 'https://www.olden-era.com/en/skills/expert_summon_swarm',
    image: 'https://www.olden-era.com/img/skills/expert_summon_swarm.webp',
    properties: {
      'Base Skill / Category': 'summon_swarm',
    },
  },
  {
    id: 'basic-combat',
    name: 'Basic Combat',
    description: 'Basic Combat — combat skill Heroic Strike deals +10 basic Damage.',
    url: 'https://www.olden-era.com/en/skills/basic_combat',
    image: 'https://www.olden-era.com/img/skills/basic_combat.webp',
    properties: {
      'Base Skill / Category': 'combat',
    },
  },
  {
    id: 'advanced-combat',
    name: 'Advanced Combat',
    description: 'Advanced Combat — combat skill Heroic Strike deals +15 basic Damage.',
    url: 'https://www.olden-era.com/en/skills/advanced_combat',
    image: 'https://www.olden-era.com/img/skills/advanced_combat.webp',
    properties: {
      'Base Skill / Category': 'combat',
    },
  },
  {
    id: 'expert-combat',
    name: 'Expert Combat',
    description: 'Expert Combat — combat skill Heroic Strike deals +20 basic Damage.',
    url: 'https://www.olden-era.com/en/skills/expert_combat',
    image: 'https://www.olden-era.com/img/skills/expert_combat.webp',
    properties: {
      'Base Skill / Category': 'combat',
    },
  },
  {
    id: 'basic-triumvirates-strength',
    name: 'Basic Triumvirate’s Strength',
    description:
      'Basic Triumvirate’s Strength — triumvirates_strength skill Once per round, the hero can activate one of the three Stances in battle. The active Stance grants the hero +<current_skill_faction_dungeon> to the Stance’s corresponding attribute.',
    url: 'https://www.olden-era.com/en/skills/basic_triumvirates_strength',
    image: 'https://www.olden-era.com/img/skills/basic_triumvirates_strength.webp',
    properties: {
      'Base Skill / Category': 'triumvirates_strength',
    },
  },
  {
    id: 'advanced-triumvirates-strength',
    name: 'Advanced Triumvirate’s Strength',
    description:
      'Advanced Triumvirate’s Strength — triumvirates_strength skill Once per round, the hero can activate one of the three Stances in battle. The active Stance grants the hero +<current_skill_faction_dungeon> to the Stance’s corresponding attribute.',
    url: 'https://www.olden-era.com/en/skills/advanced_triumvirates_strength',
    image: 'https://www.olden-era.com/img/skills/advanced_triumvirates_strength.webp',
    properties: {
      'Base Skill / Category': 'triumvirates_strength',
    },
  },
  {
    id: 'expert-triumvirates-strength',
    name: 'Expert Triumvirate’s Strength',
    description:
      'Expert Triumvirate’s Strength — triumvirates_strength skill Once per round, the hero can activate one of the three Stances in battle. The active Stance grants the hero +<current_skill_faction_dungeon> to the Stance’s corresponding attribute.',
    url: 'https://www.olden-era.com/en/skills/expert_triumvirates_strength',
    image: 'https://www.olden-era.com/img/skills/expert_triumvirates_strength.webp',
    properties: {
      'Base Skill / Category': 'triumvirates_strength',
    },
  },
  {
    id: 'basic-necromancy',
    name: 'Basic Necromancy',
    description:
      'Basic Necromancy — necromancy skill After winning a battle, transforms 10% of the strongest enemy stack into friendly Undead of the same tier. This requires Necromantic Energy, which stores up to 1000 and refills each week or when the hero has no stack of that tier in their army.',
    url: 'https://www.olden-era.com/en/skills/basic_necromancy',
    image: 'https://www.olden-era.com/img/skills/basic_necromancy.webp',
    properties: {
      'Base Skill / Category': 'necromancy',
    },
  },
  {
    id: 'advanced-necromancy',
    name: 'Advanced Necromancy',
    description:
      'Advanced Necromancy — necromancy skill After winning a battle, transforms 15% of the strongest enemy stack into friendly Undead of the same tier. This requires Necromantic Energy, which stores up to 1250 and refills each week or when the hero has no stack of that tier in their army.',
    url: 'https://www.olden-era.com/en/skills/advanced_necromancy',
    image: 'https://www.olden-era.com/img/skills/advanced_necromancy.webp',
    properties: {
      'Base Skill / Category': 'necromancy',
    },
  },
  {
    id: 'expert-necromancy',
    name: 'Expert Necromancy',
    description:
      'Expert Necromancy — necromancy skill After winning a battle, transforms 20% of the strongest enemy stack into friendly Undead of the same tier. This requires Necromantic Energy, which stores up to 1500 and refills each week or when the hero has no stack of that tier in their army.',
    url: 'https://www.olden-era.com/en/skills/expert_necromancy',
    image: 'https://www.olden-era.com/img/skills/expert_necromancy.webp',
    properties: {
      'Base Skill / Category': 'necromancy',
    },
  },
  {
    id: 'basic-abyssal-communion',
    name: 'Basic Abyssal Communion',
    description:
      'Basic Abyssal Communion — abyssal_communion skill After each battle victory, the hero increases their Communion level by 1 (up to a max. of 4).  Each level increases the number of friendly Schism units by 3% until the end of the battle. Each morning, all heroes’ Communion level is halved.',
    url: 'https://www.olden-era.com/en/skills/basic_abyssal_communion',
    image: 'https://www.olden-era.com/img/skills/basic_abyssal_communion.webp',
    properties: {
      'Base Skill / Category': 'abyssal_communion',
    },
  },
  {
    id: 'advanced-abyssal-communion',
    name: 'Advanced Abyssal Communion',
    description:
      'Advanced Abyssal Communion — abyssal_communion skill After each battle victory, the hero increases their Communion level by 1 (up to a max. of 5).  Each level increases the number of friendly Schism units by 3% until the end of the battle. Each morning, all heroes’ Communion level is halved.',
    url: 'https://www.olden-era.com/en/skills/advanced_abyssal_communion',
    image: 'https://www.olden-era.com/img/skills/advanced_abyssal_communion.webp',
    properties: {
      'Base Skill / Category': 'abyssal_communion',
    },
  },
  {
    id: 'expert-abyssal-communion',
    name: 'Expert Abyssal Communion',
    description:
      'Expert Abyssal Communion — abyssal_communion skill After each battle victory, the hero increases their Communion level by 1 (up to a max. of 6).  Each level increases the number of friendly Schism units by 3% until the end of the battle. Each morning, all heroes’ Communion level is halved.',
    url: 'https://www.olden-era.com/en/skills/expert_abyssal_communion',
    image: 'https://www.olden-era.com/img/skills/expert_abyssal_communion.webp',
    properties: {
      'Base Skill / Category': 'abyssal_communion',
    },
  },
  {
    id: 'basic-ascension',
    name: 'Basic Righteousness',
    description:
      'Basic Righteousness — ascension skill All who fall in battle do so in the hero’s name! Whenever a friendly creature dies or kills an enemy, the hero’s Attack, Defense, Spell Power and Knowledge increase by 1 for two rounds. This effect is stackable.',
    url: 'https://www.olden-era.com/en/skills/basic_ascension',
    image: 'https://www.olden-era.com/img/skills/basic_ascension.webp',
    properties: {
      'Base Skill / Category': 'ascension',
    },
  },
  {
    id: 'advanced-ascension',
    name: 'Advanced Righteousness',
    description:
      'Advanced Righteousness — ascension skill All who fall in battle do so in the hero’s name! Whenever a friendly creature dies or kills an enemy, the hero’s Attack, Defense, Spell Power and Knowledge increase by 1 for three rounds. This effect is stackable.',
    url: 'https://www.olden-era.com/en/skills/advanced_ascension',
    image: 'https://www.olden-era.com/img/skills/advanced_ascension.webp',
    properties: {
      'Base Skill / Category': 'ascension',
    },
  },
  {
    id: 'expert-ascension',
    name: 'Expert Righteousness',
    description:
      'Expert Righteousness — ascension skill All who fall in battle do so in the hero’s name! Whenever a friendly creature dies or kills an enemy, the hero’s Attack, Defense, Spell Power and Knowledge increase by 1 for four rounds. This effect is stackable.',
    url: 'https://www.olden-era.com/en/skills/expert_ascension',
    image: 'https://www.olden-era.com/img/skills/expert_ascension.webp',
    properties: {
      'Base Skill / Category': 'ascension',
    },
  },
  {
    id: 'basic-economy',
    name: 'Basic Economy',
    description: 'Basic Economy — economy skill +500 Gold daily.',
    url: 'https://www.olden-era.com/en/skills/basic_economy',
    image: 'https://www.olden-era.com/img/skills/basic_economy.webp',
    properties: {
      'Base Skill / Category': 'economy',
    },
  },
  {
    id: 'advanced-economy',
    name: 'Advanced Economy',
    description: 'Advanced Economy — economy skill +750 Gold daily.',
    url: 'https://www.olden-era.com/en/skills/advanced_economy',
    image: 'https://www.olden-era.com/img/skills/advanced_economy.webp',
    properties: {
      'Base Skill / Category': 'economy',
    },
  },
  {
    id: 'expert-economy',
    name: 'Expert Economy',
    description: 'Expert Economy — economy skill +1000 Gold daily.',
    url: 'https://www.olden-era.com/en/skills/expert_economy',
    image: 'https://www.olden-era.com/img/skills/expert_economy.webp',
    properties: {
      'Base Skill / Category': 'economy',
    },
  },
  {
    id: 'basic-insight',
    name: 'Basic Insight',
    description: 'Basic Insight — insight skill The hero gains +20% more XP.',
    url: 'https://www.olden-era.com/en/skills/basic_insight',
    image: 'https://www.olden-era.com/img/skills/basic_insight.webp',
    properties: {
      'Base Skill / Category': 'insight',
    },
  },
  {
    id: 'advanced-insight',
    name: 'Advanced Insight',
    description: 'Advanced Insight — insight skill The hero gains +30% more XP.',
    url: 'https://www.olden-era.com/en/skills/advanced_insight',
    image: 'https://www.olden-era.com/img/skills/advanced_insight.webp',
    properties: {
      'Base Skill / Category': 'insight',
    },
  },
  {
    id: 'expert-insight',
    name: 'Expert Insight',
    description: 'Expert Insight — insight skill The hero gains +40% more XP.',
    url: 'https://www.olden-era.com/en/skills/expert_insight',
    image: 'https://www.olden-era.com/img/skills/expert_insight.webp',
    properties: {
      'Base Skill / Category': 'insight',
    },
  },
  {
    id: 'basic-scouting',
    name: 'Basic Scouting',
    description: 'Basic Scouting — scouting skill The hero gains 1 sight radius.',
    url: 'https://www.olden-era.com/en/skills/basic_scouting',
    image: 'https://www.olden-era.com/img/skills/basic_scouting.webp',
    properties: {
      'Base Skill / Category': 'scouting',
    },
  },
  {
    id: 'advanced-scouting',
    name: 'Advanced Scouting',
    description: 'Advanced Scouting — scouting skill The hero gains 2 sight radius.',
    url: 'https://www.olden-era.com/en/skills/advanced_scouting',
    image: 'https://www.olden-era.com/img/skills/advanced_scouting.webp',
    properties: {
      'Base Skill / Category': 'scouting',
    },
  },
  {
    id: 'expert-scouting',
    name: 'Expert Scouting',
    description: 'Expert Scouting — scouting skill The hero gains 3 sight radius.',
    url: 'https://www.olden-era.com/en/skills/expert_scouting',
    image: 'https://www.olden-era.com/img/skills/expert_scouting.webp',
    properties: {
      'Base Skill / Category': 'scouting',
    },
  },
  {
    id: 'basic-logistics',
    name: 'Basic Logistics',
    description: 'Basic Logistics — logistics skill +10% Movement points on the global map.',
    url: 'https://www.olden-era.com/en/skills/basic_logistics',
    image: 'https://www.olden-era.com/img/skills/basic_logistics.webp',
    properties: {
      'Base Skill / Category': 'logistics',
    },
  },
  {
    id: 'advanced-logistics',
    name: 'Advanced Logistics',
    description: 'Advanced Logistics — logistics skill +15% Movement points on the global map.',
    url: 'https://www.olden-era.com/en/skills/advanced_logistics',
    image: 'https://www.olden-era.com/img/skills/advanced_logistics.webp',
    properties: {
      'Base Skill / Category': 'logistics',
    },
  },
  {
    id: 'expert-logistics',
    name: 'Expert Logistics',
    description: 'Expert Logistics — logistics skill +20% Movement points on the global map.',
    url: 'https://www.olden-era.com/en/skills/expert_logistics',
    image: 'https://www.olden-era.com/img/skills/expert_logistics.webp',
    properties: {
      'Base Skill / Category': 'logistics',
    },
  },
  {
    id: 'basic-diplomacy',
    name: 'Basic Diplomacy',
    description:
      'Basic Diplomacy — diplomacy skill Provides a chance of neutral squads offering to join the hero’s army for Gold instead of fighting them.',
    url: 'https://www.olden-era.com/en/skills/basic_diplomacy',
    image: 'https://www.olden-era.com/img/skills/basic_diplomacy.webp',
    properties: {
      'Base Skill / Category': 'diplomacy',
    },
  },
  {
    id: 'advanced-diplomacy',
    name: 'Advanced Diplomacy',
    description:
      'Advanced Diplomacy — diplomacy skill Provides a chance of neutral squads offering to join the hero’s army for Gold instead of fighting them. +25% Persuasion Power in Diplomacy.',
    url: 'https://www.olden-era.com/en/skills/advanced_diplomacy',
    image: 'https://www.olden-era.com/img/skills/advanced_diplomacy.webp',
    properties: {
      'Base Skill / Category': 'diplomacy',
    },
  },
  {
    id: 'expert-diplomacy',
    name: 'Expert Diplomacy',
    description:
      'Expert Diplomacy — diplomacy skill Provides a chance of neutral squads offering to join the hero’s army for Gold instead of fighting them. +50% Persuasion Power in Diplomacy.',
    url: 'https://www.olden-era.com/en/skills/expert_diplomacy',
    image: 'https://www.olden-era.com/img/skills/expert_diplomacy.webp',
    properties: {
      'Base Skill / Category': 'diplomacy',
    },
  },
  {
    id: 'basic-primal-magic',
    name: 'Basic Primal Magic',
    description: 'Basic Primal Magic — primal_magic skill The hero can learn tier‑5 Primal spells.',
    url: 'https://www.olden-era.com/en/skills/basic_primal_magic',
    image: 'https://www.olden-era.com/img/skills/basic_primal_magic.webp',
    properties: {
      'Base Skill / Category': 'primal_magic',
    },
  },
  {
    id: 'advanced-primal-magic',
    name: 'Advanced Primal Magic',
    description:
      'Advanced Primal Magic — primal_magic skill The hero can learn tier‑5 Primal spells. Primal spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/advanced_primal_magic',
    image: 'https://www.olden-era.com/img/skills/advanced_primal_magic.webp',
    properties: {
      'Base Skill / Category': 'primal_magic',
    },
  },
  {
    id: 'expert-primal-magic',
    name: 'Expert Primal Magic',
    description:
      'Expert Primal Magic — primal_magic skill The hero can learn tier‑5 Primal spells, and can learn Primal spells unlocked in the Observatory, without visiting a Mage Guild. Primal spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/expert_primal_magic',
    image: 'https://www.olden-era.com/img/skills/expert_primal_magic.webp',
    properties: {
      'Base Skill / Category': 'primal_magic',
    },
  },
  {
    id: 'basic-nightshade-magic',
    name: 'Basic Nightshade Magic',
    description: 'Basic Nightshade Magic — nightshade_magic skill The hero can learn tier‑5 Nightshade spells.',
    url: 'https://www.olden-era.com/en/skills/basic_nightshade_magic',
    image: 'https://www.olden-era.com/img/skills/basic_nightshade_magic.webp',
    properties: {
      'Base Skill / Category': 'nightshade_magic',
    },
  },
  {
    id: 'advanced-nightshade-magic',
    name: 'Advanced Nightshade Magic',
    description:
      'Advanced Nightshade Magic — nightshade_magic skill The hero can learn tier‑5 Nightshade spells. Nightshade spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/advanced_nightshade_magic',
    image: 'https://www.olden-era.com/img/skills/advanced_nightshade_magic.webp',
    properties: {
      'Base Skill / Category': 'nightshade_magic',
    },
  },
  {
    id: 'expert-nightshade-magic',
    name: 'Expert Nightshade Magic',
    description:
      'Expert Nightshade Magic — nightshade_magic skill The hero can learn tier‑5 Nightshade spells, and can learn Nightshade spells unlocked in the Observatory, without visiting a Mage Guild. Nightshade spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/expert_nightshade_magic',
    image: 'https://www.olden-era.com/img/skills/expert_nightshade_magic.webp',
    properties: {
      'Base Skill / Category': 'nightshade_magic',
    },
  },
  {
    id: 'basic-daylight-magic',
    name: 'Basic Daylight Magic',
    description: 'Basic Daylight Magic — daylight_magic skill The hero can learn tier‑5 Daylight spells.',
    url: 'https://www.olden-era.com/en/skills/basic_daylight_magic',
    image: 'https://www.olden-era.com/img/skills/basic_daylight_magic.webp',
    properties: {
      'Base Skill / Category': 'daylight_magic',
    },
  },
  {
    id: 'advanced-daylight-magic',
    name: 'Advanced Daylight Magic',
    description:
      'Advanced Daylight Magic — daylight_magic skill The hero can learn tier‑5 Daylight spells. Daylight spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/advanced_daylight_magic',
    image: 'https://www.olden-era.com/img/skills/advanced_daylight_magic.webp',
    properties: {
      'Base Skill / Category': 'daylight_magic',
    },
  },
  {
    id: 'expert-daylight-magic',
    name: 'Expert Daylight Magic',
    description:
      'Expert Daylight Magic — daylight_magic skill The hero can learn tier‑5 Daylight spells, and can learn Daylight spells unlocked in the Observatory, without visiting a Mage Guild. Daylight spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/expert_daylight_magic',
    image: 'https://www.olden-era.com/img/skills/expert_daylight_magic.webp',
    properties: {
      'Base Skill / Category': 'daylight_magic',
    },
  },
  {
    id: 'basic-arcane-magic',
    name: 'Basic Arcane Magic',
    description: 'Basic Arcane Magic — arcane_magic skill The hero can learn tier‑5 Arcane spells.',
    url: 'https://www.olden-era.com/en/skills/basic_arcane_magic',
    image: 'https://www.olden-era.com/img/skills/basic_arcane_magic.webp',
    properties: {
      'Base Skill / Category': 'arcane_magic',
    },
  },
  {
    id: 'advanced-arcane-magic',
    name: 'Advanced Arcane Magic',
    description:
      'Advanced Arcane Magic — arcane_magic skill The hero can learn tier‑5 Arcane spells. Arcane spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/advanced_arcane_magic',
    image: 'https://www.olden-era.com/img/skills/advanced_arcane_magic.webp',
    properties: {
      'Base Skill / Category': 'arcane_magic',
    },
  },
  {
    id: 'expert-arcane-magic',
    name: 'Expert Arcane Magic',
    description:
      'Expert Arcane Magic — arcane_magic skill The hero can learn tier‑5 Arcane spells, and can learn Arcane spells unlocked in the Observatory, without visiting a Mage Guild. Arcane spells gain +1 level(s).',
    url: 'https://www.olden-era.com/en/skills/expert_arcane_magic',
    image: 'https://www.olden-era.com/img/skills/expert_arcane_magic.webp',
    properties: {
      'Base Skill / Category': 'arcane_magic',
    },
  },
  {
    id: 'basic-thaumaturgy',
    name: 'Basic Thaumaturgy',
    description:
      'Basic Thaumaturgy — thaumaturgy skill The hero can use the Spellbook one more time per battle round, but only to cast a spell of a Magic School that hasn’t been used this round. Spells cost +100% mana for each use after the first.',
    url: 'https://www.olden-era.com/en/skills/basic_thaumaturgy',
    image: 'https://www.olden-era.com/img/skills/basic_thaumaturgy.webp',
    properties: {
      'Base Skill / Category': 'thaumaturgy',
    },
  },
  {
    id: 'advanced-thaumaturgy',
    name: 'Advanced Thaumaturgy',
    description:
      'Advanced Thaumaturgy — thaumaturgy skill The hero can use the Spellbook one more time per battle round, but only to cast a spell of a Magic School that hasn’t been used this round. Spells cost +75% mana for each use after the first.',
    url: 'https://www.olden-era.com/en/skills/advanced_thaumaturgy',
    image: 'https://www.olden-era.com/img/skills/advanced_thaumaturgy.webp',
    properties: {
      'Base Skill / Category': 'thaumaturgy',
    },
  },
  {
    id: 'expert-thaumaturgy',
    name: 'Expert Thaumaturgy',
    description:
      'Expert Thaumaturgy — thaumaturgy skill The hero can use the Spellbook one more time per battle round, but only to cast a spell of a Magic School that hasn’t been used this round. Spells cost +50% mana for each use after the first.',
    url: 'https://www.olden-era.com/en/skills/expert_thaumaturgy',
    image: 'https://www.olden-era.com/img/skills/expert_thaumaturgy.webp',
    properties: {
      'Base Skill / Category': 'thaumaturgy',
    },
  },
  {
    id: 'basic-sorcery',
    name: 'Basic Sorcery',
    description: 'Basic Sorcery — sorcery skill +10% Magic Damage dealt.',
    url: 'https://www.olden-era.com/en/skills/basic_sorcery',
    image: 'https://www.olden-era.com/img/skills/basic_sorcery.webp',
    properties: {
      'Base Skill / Category': 'sorcery',
    },
  },
  {
    id: 'advanced-sorcery',
    name: 'Advanced Sorcery',
    description: 'Advanced Sorcery — sorcery skill +20% Magic Damage dealt.',
    url: 'https://www.olden-era.com/en/skills/advanced_sorcery',
    image: 'https://www.olden-era.com/img/skills/advanced_sorcery.webp',
    properties: {
      'Base Skill / Category': 'sorcery',
    },
  },
  {
    id: 'expert-sorcery',
    name: 'Expert Sorcery',
    description: 'Expert Sorcery — sorcery skill +30% Magic Damage dealt.',
    url: 'https://www.olden-era.com/en/skills/expert_sorcery',
    image: 'https://www.olden-era.com/img/skills/expert_sorcery.webp',
    properties: {
      'Base Skill / Category': 'sorcery',
    },
  },
  {
    id: 'basic-battle-magic',
    name: 'Basic Battle Magic',
    description:
      'Basic Battle Magic — battle_magic skill Friendly creatures’ Attack and Defense increase by 15% of the hero’s Spell Power and Knowledge respectively.',
    url: 'https://www.olden-era.com/en/skills/basic_battle_magic',
    image: 'https://www.olden-era.com/img/skills/basic_battle_magic.webp',
    properties: {
      'Base Skill / Category': 'battle_magic',
    },
  },
  {
    id: 'advanced-battle-magic',
    name: 'Advanced Battle Magic',
    description:
      'Advanced Battle Magic — battle_magic skill Friendly creatures’ Attack and Defense increase by 25% of the hero’s Spell Power and Knowledge respectively.',
    url: 'https://www.olden-era.com/en/skills/advanced_battle_magic',
    image: 'https://www.olden-era.com/img/skills/advanced_battle_magic.webp',
    properties: {
      'Base Skill / Category': 'battle_magic',
    },
  },
  {
    id: 'expert-battle-magic',
    name: 'Expert Battle Magic',
    description:
      'Expert Battle Magic — battle_magic skill Friendly creatures’ Attack and Defense increase by 35% of the hero’s Spell Power and Knowledge respectively.',
    url: 'https://www.olden-era.com/en/skills/expert_battle_magic',
    image: 'https://www.olden-era.com/img/skills/expert_battle_magic.webp',
    properties: {
      'Base Skill / Category': 'battle_magic',
    },
  },
  {
    id: 'basic-intelligence',
    name: 'Basic Wisdom',
    description:
      'Basic Wisdom — intelligence skill The hero can learn up to tier‑3 spells without knowing the corresponding Magic School skill.',
    url: 'https://www.olden-era.com/en/skills/basic_intelligence',
    image: 'https://www.olden-era.com/img/skills/basic_intelligence.webp',
    properties: {
      'Base Skill / Category': 'intelligence',
    },
  },
  {
    id: 'advanced-intelligence',
    name: 'Advanced Wisdom',
    description:
      'Advanced Wisdom — intelligence skill The hero can learn up to tier‑4 spells without knowing the corresponding Magic School skill.',
    url: 'https://www.olden-era.com/en/skills/advanced_intelligence',
    image: 'https://www.olden-era.com/img/skills/advanced_intelligence.webp',
    properties: {
      'Base Skill / Category': 'intelligence',
    },
  },
  {
    id: 'expert-intelligence',
    name: 'Expert Wisdom',
    description:
      'Expert Wisdom — intelligence skill The hero can learn up to tier‑5 spells without knowing the corresponding Magic School skill.',
    url: 'https://www.olden-era.com/en/skills/expert_intelligence',
    image: 'https://www.olden-era.com/img/skills/expert_intelligence.webp',
    properties: {
      'Base Skill / Category': 'intelligence',
    },
  },
  {
    id: 'basic-summon-avatar',
    name: 'Basic Summon Avatar',
    description:
      'Basic Summon Avatar — summon_avatar skill Grants a new battle spell. It summons an Avatar that scales with the hero’s Spell Power and Knowledge.',
    url: 'https://www.olden-era.com/en/skills/basic_summon_avatar',
    image: 'https://www.olden-era.com/img/skills/basic_summon_avatar.webp',
    properties: {
      'Base Skill / Category': 'summon_avatar',
    },
  },
  {
    id: 'advanced-summon-avatar',
    name: 'Advanced Summon Avatar',
    description:
      'Advanced Summon Avatar — summon_avatar skill Grants a new battle spell. It summons an Avatar that scales more strongly with the hero’s Spell Power and Knowledge.',
    url: 'https://www.olden-era.com/en/skills/advanced_summon_avatar',
    image: 'https://www.olden-era.com/img/skills/advanced_summon_avatar.webp',
    properties: {
      'Base Skill / Category': 'summon_avatar',
    },
  },
  {
    id: 'expert-summon-avatar',
    name: 'Expert Summon Avatar',
    description:
      'Expert Summon Avatar — summon_avatar skill Grants a new battle spell. It summons an Avatar that scales even more strongly with the hero’s Spell Power and Knowledge.',
    url: 'https://www.olden-era.com/en/skills/expert_summon_avatar',
    image: 'https://www.olden-era.com/img/skills/expert_summon_avatar.webp',
    properties: {
      'Base Skill / Category': 'summon_avatar',
    },
  },
  {
    id: 'basic-offence',
    name: 'Basic Offense',
    description: 'Basic Offense — offence skill Friendly creatures’ basic attacks deal +15% Damage.',
    url: 'https://www.olden-era.com/en/skills/basic_offence',
    image: 'https://www.olden-era.com/img/skills/basic_offence.webp',
    properties: {
      'Base Skill / Category': 'offence',
    },
  },
  {
    id: 'advanced-offence',
    name: 'Advanced Offense',
    description: 'Advanced Offense — offence skill Friendly creatures’ basic attacks deal +20% Damage.',
    url: 'https://www.olden-era.com/en/skills/advanced_offence',
    image: 'https://www.olden-era.com/img/skills/advanced_offence.webp',
    properties: {
      'Base Skill / Category': 'offence',
    },
  },
  {
    id: 'expert-offence',
    name: 'Expert Offense',
    description: 'Expert Offense — offence skill Friendly creatures’ basic attacks deal +25% Damage.',
    url: 'https://www.olden-era.com/en/skills/expert_offence',
    image: 'https://www.olden-era.com/img/skills/expert_offence.webp',
    properties: {
      'Base Skill / Category': 'offence',
    },
  },
  {
    id: 'basic-defence',
    name: 'Basic Defense',
    description: 'Basic Defense — defence skill Friendly creatures take –15% Damage from basic attacks.',
    url: 'https://www.olden-era.com/en/skills/basic_defence',
    image: 'https://www.olden-era.com/img/skills/basic_defence.webp',
    properties: {
      'Base Skill / Category': 'defence',
    },
  },
  {
    id: 'advanced-defence',
    name: 'Advanced Defense',
    description: 'Advanced Defense — defence skill Friendly creatures take –20% Damage from basic attacks.',
    url: 'https://www.olden-era.com/en/skills/advanced_defence',
    image: 'https://www.olden-era.com/img/skills/advanced_defence.webp',
    properties: {
      'Base Skill / Category': 'defence',
    },
  },
  {
    id: 'expert-defence',
    name: 'Expert Defense',
    description: 'Expert Defense — defence skill Friendly creatures take –25% Damage from basic attacks.',
    url: 'https://www.olden-era.com/en/skills/expert_defence',
    image: 'https://www.olden-era.com/img/skills/expert_defence.webp',
    properties: {
      'Base Skill / Category': 'defence',
    },
  },
  {
    id: 'basic-battlecraft',
    name: 'Basic Battlecraft',
    description:
      'Basic Battlecraft — battlecraft skill When a friendly creature waits on their turn, they gain +20% Attack until the end of the round. When they skip turn, they gain +20% Defense until the end of the round.',
    url: 'https://www.olden-era.com/en/skills/basic_battlecraft',
    image: 'https://www.olden-era.com/img/skills/basic_battlecraft.webp',
    properties: {
      'Base Skill / Category': 'battlecraft',
    },
  },
  {
    id: 'advanced-battlecraft',
    name: 'Advanced Battlecraft',
    description:
      'Advanced Battlecraft — battlecraft skill When a friendly creature waits on their turn, they gain +30% Attack until the end of the round. When they skip turn, they gain +30% Defense until the end of the round.',
    url: 'https://www.olden-era.com/en/skills/advanced_battlecraft',
    image: 'https://www.olden-era.com/img/skills/advanced_battlecraft.webp',
    properties: {
      'Base Skill / Category': 'battlecraft',
    },
  },
  {
    id: 'expert-battlecraft',
    name: 'Expert Battlecraft',
    description:
      'Expert Battlecraft — battlecraft skill When a friendly creature waits on their turn, they gain +40% Attack until the end of the round. When they skip turn, they gain +40% Defense until the end of the round.',
    url: 'https://www.olden-era.com/en/skills/expert_battlecraft',
    image: 'https://www.olden-era.com/img/skills/expert_battlecraft.webp',
    properties: {
      'Base Skill / Category': 'battlecraft',
    },
  },
  {
    id: 'basic-leadership',
    name: 'Basic Leadership',
    description: 'Basic Leadership — leadership skill The hero gains 1 Morale.',
    url: 'https://www.olden-era.com/en/skills/basic_leadership',
    image: 'https://www.olden-era.com/img/skills/basic_leadership.webp',
    properties: {
      'Base Skill / Category': 'leadership',
    },
  },
  {
    id: 'advanced-leadership',
    name: 'Advanced Leadership',
    description: 'Advanced Leadership — leadership skill The hero gains 2 Morale.',
    url: 'https://www.olden-era.com/en/skills/advanced_leadership',
    image: 'https://www.olden-era.com/img/skills/advanced_leadership.webp',
    properties: {
      'Base Skill / Category': 'leadership',
    },
  },
  {
    id: 'expert-leadership',
    name: 'Expert Leadership',
    description: 'Expert Leadership — leadership skill The hero gains 3 Morale.',
    url: 'https://www.olden-era.com/en/skills/expert_leadership',
    image: 'https://www.olden-era.com/img/skills/expert_leadership.webp',
    properties: {
      'Base Skill / Category': 'leadership',
    },
  },
  {
    id: 'basic-luck',
    name: 'Basic Luck',
    description: 'Basic Luck — luck skill The hero gains 1 Luck.',
    url: 'https://www.olden-era.com/en/skills/basic_luck',
    image: 'https://www.olden-era.com/img/skills/basic_luck.webp',
    properties: {
      'Base Skill / Category': 'luck',
    },
  },
  {
    id: 'advanced-luck',
    name: 'Advanced Luck',
    description: 'Advanced Luck — luck skill The hero gains 2 Luck.',
    url: 'https://www.olden-era.com/en/skills/advanced_luck',
    image: 'https://www.olden-era.com/img/skills/advanced_luck.webp',
    properties: {
      'Base Skill / Category': 'luck',
    },
  },
  {
    id: 'expert-luck',
    name: 'Expert Luck',
    description: 'Expert Luck — luck skill The hero gains 3 Luck.',
    url: 'https://www.olden-era.com/en/skills/expert_luck',
    image: 'https://www.olden-era.com/img/skills/expert_luck.webp',
    properties: {
      'Base Skill / Category': 'luck',
    },
  },
  {
    id: 'basic-resistance',
    name: 'Basic Resistance',
    description: 'Basic Resistance — resistance skill Friendly creatures take –15% Magic Damage.',
    url: 'https://www.olden-era.com/en/skills/basic_resistance',
    image: 'https://www.olden-era.com/img/skills/basic_resistance.webp',
    properties: {
      'Base Skill / Category': 'resistance',
    },
  },
  {
    id: 'advanced-resistance',
    name: 'Advanced Resistance',
    description: 'Advanced Resistance — resistance skill Friendly creatures take –25% Magic Damage.',
    url: 'https://www.olden-era.com/en/skills/advanced_resistance',
    image: 'https://www.olden-era.com/img/skills/advanced_resistance.webp',
    properties: {
      'Base Skill / Category': 'resistance',
    },
  },
  {
    id: 'expert-resistance',
    name: 'Expert Resistance',
    description: 'Expert Resistance — resistance skill Friendly creatures take –35% Magic Damage.',
    url: 'https://www.olden-era.com/en/skills/expert_resistance',
    image: 'https://www.olden-era.com/img/skills/expert_resistance.webp',
    properties: {
      'Base Skill / Category': 'resistance',
    },
  },
  {
    id: 'basic-siegecraft',
    name: 'Basic Siegecraft',
    description: 'Basic Siegecraft — siegecraft skill The catapult deals +50 Damage.',
    url: 'https://www.olden-era.com/en/skills/basic_siegecraft',
    image: 'https://www.olden-era.com/img/skills/basic_siegecraft.webp',
    properties: {
      'Base Skill / Category': 'siegecraft',
    },
  },
  {
    id: 'advanced-siegecraft',
    name: 'Advanced Siegecraft',
    description: 'Advanced Siegecraft — siegecraft skill The catapult deals +100 Damage.',
    url: 'https://www.olden-era.com/en/skills/advanced_siegecraft',
    image: 'https://www.olden-era.com/img/skills/advanced_siegecraft.webp',
    properties: {
      'Base Skill / Category': 'siegecraft',
    },
  },
  {
    id: 'expert-siegecraft',
    name: 'Expert Siegecraft',
    description: 'Expert Siegecraft — siegecraft skill The catapult deals +150 Damage.',
    url: 'https://www.olden-era.com/en/skills/expert_siegecraft',
    image: 'https://www.olden-era.com/img/skills/expert_siegecraft.webp',
    properties: {
      'Base Skill / Category': 'siegecraft',
    },
  },
  {
    id: 'basic-tactics',
    name: '基础战术',
    description: '基础战术 — tactics skill 在战术阶段，你可以在 3 行范围内部署生物。',
    url: 'https://www.olden-era.com/en/skills/basic_tactics',
    image: 'https://www.olden-era.com/img/skills/basic_tactics.webp',
    properties: {
      'Base Skill / Category': 'tactics',
    },
  },
  {
    id: 'advanced-tactics',
    name: 'Advanced Tactics',
    description:
      'Advanced Tactics — tactics skill In the Tactics Phase, creatures can be placed within a 4‑line area. If the enemy also knows “Tactics”, their area of placement reduces by 2 line(s).',
    url: 'https://www.olden-era.com/en/skills/advanced_tactics',
    image: 'https://www.olden-era.com/img/skills/advanced_tactics.webp',
    properties: {
      'Base Skill / Category': 'tactics',
    },
  },
  {
    id: 'expert-tactics',
    name: 'Expert Tactics',
    description:
      'Expert Tactics — tactics skill In the Tactics Phase, creatures can be placed within a 5‑line area. If the enemy also knows “Tactics”, their area of placement reduces by 3 line(s).',
    url: 'https://www.olden-era.com/en/skills/expert_tactics',
    image: 'https://www.olden-era.com/img/skills/expert_tactics.webp',
    properties: {
      'Base Skill / Category': 'tactics',
    },
  },
  {
    id: 'basic-recruitment',
    name: 'Basic Recruitment',
    description: 'Basic Recruitment — recruitment skill +4 to tier‑1 creature growth in all your cities.',
    url: 'https://www.olden-era.com/en/skills/basic_recruitment',
    image: 'https://www.olden-era.com/img/skills/basic_recruitment.webp',
    properties: {
      'Base Skill / Category': 'recruitment',
    },
  },
  {
    id: 'advanced-recruitment',
    name: 'Advanced Recruitment',
    description:
      'Advanced Recruitment — recruitment skill +4 to tier‑1 and +3 to tier‑2 creature growth in all your cities.',
    url: 'https://www.olden-era.com/en/skills/advanced_recruitment',
    image: 'https://www.olden-era.com/img/skills/advanced_recruitment.webp',
    properties: {
      'Base Skill / Category': 'recruitment',
    },
  },
  {
    id: 'expert-recruitment',
    name: 'Expert Recruitment',
    description:
      'Expert Recruitment — recruitment skill +4 to tier‑1, +3 to tier‑2, and +2 to tier‑3 creature growth in all your cities.',
    url: 'https://www.olden-era.com/en/skills/expert_recruitment',
    image: 'https://www.olden-era.com/img/skills/expert_recruitment.webp',
    properties: {
      'Base Skill / Category': 'recruitment',
    },
  },
] satisfies EncyclopediaEntry[]

export const lawEntries = [
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i_sylvan.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description: 'Tax Collectors. —. faction law. Tier 1: Produces 500 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors_sylvan.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Knowledge is Power',
    description:
      'Knowledge is Power. —. faction law. Tier 1: Your heroes gain 1 Knowledge. | Tier 2: Your heroes gain 2 Knowledge. | Tier 3: Your heroes gain 3 Knowledge.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/knowledge_is_power.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Crystals',
    description:
      'Mining: Crystals. —. faction law. Tier 1: Produces 1 Crystal(s) daily. | Tier 2: Produces 2 Crystal(s) daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_crystals.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Clear Sky',
    description: 'Clear Sky. —. faction law. Tier 1: Produces 250 Astrology Points daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/clear_sky.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Folk Heroes',
    description: 'Folk Heroes. —. faction law. Tier 1: Your heroes cost –40% Gold.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/folk_heroes.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii_sylvan.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Save the Forests',
    description:
      'Save the Forests. —. faction law. Tier 1: Your buildings cost –20% Wood to construct. | Tier 2: Your buildings cost –40% Wood to construct.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/save_the_forests.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Forest Magic',
    description:
      'Forest Magic. —. faction law. Tier 1: Each time your improve a Mage Guild in your Grove cities, +1 spell(s) is unlocked in the Observatory. | Tier 2: Each time your improve a Mage Guild in your Grove cities, +2 spell(s) is unlocked in the Observatory.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/forest_magic.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Woodland Resistance',
    description:
      'Woodland Resistance. —. faction law. Tier 1: Enemies can’t see detailed information about your armies. (When viewed, it shows random numbers of random Grove units.)',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/woodland_resistants.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Fertile Ground',
    description:
      'Fertile Ground. —. faction law. Tier 1: Creature growth of your external dwellings increases by +50%. | Tier 2: Creature growth of your external dwellings increases by +100%.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/fertile_ground.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'The Power of the Written Word',
    description:
      'The Power of the Written Word. —. faction law. Tier 1: All temporary spells (scrolls, artifacts etc.) available to your heroes gain 1 level(s). | Tier 2: All temporary spells (scrolls, artifacts etc.) available to your heroes gain 2 level(s). | Tier 3: All temporary spells (scrolls, artifacts etc.) available to your heroes gain 3 level(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/the_power_of_the_written_world.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Natural Serenity',
    description:
      'Natural Serenity. —. faction law. Tier 1: The cooldowns of all the battle spells of your heroes are reduced by 1 round(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/natural_serenity.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Live roots',
    description: 'Live roots. —. faction law. Tier 1: Enemy heroes can’t flee or surrender.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/live_roots.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii_sylvan.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Force of Nature',
    description: 'Force of Nature. —. faction law. Tier 1: Your Heroic Strikes deal +10 basic Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/force_of_nature.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Children of the Wild',
    description:
      'Children of the Wild. —. faction law. Tier 1: Your Grove heroes gain 1 sight radius and 10 Movement points. | Tier 2: Your Grove heroes gain 2 sight radius and 20 Movement points.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/children_of_the_wild.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Focus',
    description: 'Focus. —. faction law. Tier 1: Each round of battle, you generate 1 Focus Charge(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/focus.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Fauns',
    description:
      'Elite Fauns. —. army law. Tier 1: Faun growth in your cities increases by 2. They deal +50% Melee Damage. | Tier 2: Faun growth in your cities increases by 4. They deal +50% Melee Damage. | Tier 3: Faun growth in your cities increases by 6. They deal +50% Melee Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_fauns.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Hoplets',
    description:
      'Elite Hoplets. —. army law. Tier 1: Hoplet growth in your cities increases by 2. They always deal maximum Damage. | Tier 2: Hoplet growth in your cities increases by 4. They always deal maximum Damage. | Tier 3: Hoplet growth in your cities increases by 6. They always deal maximum Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_hoplets.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Iriyads',
    description:
      'Elite Iriyads. —. army law. Tier 1: Vine Iriyad growth in your cities increases by 2. They gain 5 HP. | Tier 2: Vine Iriyad growth in your cities increases by 2. They gain 10 HP. | Tier 3: Vine Iriyad growth in your cities increases by 2. They gain 15 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_iriyads.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Nature’s Wildness',
    description:
      'Nature’s Wildness. —. army law. Tier 1: Friendly creatures deal 25% more Damage with Lucky Strikes. | Tier 2: Friendly creatures deal 50% more Damage with Lucky Strikes.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/nature_s_wildness.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Veiled by the Trees',
    description:
      'Veiled by the Trees. —. army law. Tier 1: When battling in the area you control, friendly creatures gain 2 Attack and Defense. | Tier 2: When battling in the area you control, friendly creatures gain 4 Attack and Defense. | Tier 3: When battling in the area you control, friendly creatures gain 6 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/veiled_by_the_trees.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Naiads',
    description:
      'Elite Naiads. —. army law. Tier 1: Naiad growth in your cities increases by 2. They gain 1 Speed and Initiative. | Tier 2: Naiad growth in your cities increases by 2. They gain 2 Speed and Initiative. | Tier 3: Naiad growth in your cities increases by 2. They gain 3 Speed and Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_naiads.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Nature’s Resolve',
    description:
      'Nature’s Resolve. —. army law. Tier 1: All negative effects on friendly creatures last 1 fewer round(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/nature_s_reolve.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Mancers',
    description:
      'Elite Mancers. —. army law. Tier 1: Herbomancer growth in your cities increases by 1. Their abilities cost –1 Focus Charge(s). | Tier 2: Herbomancer growth in your cities increases by 2. Their abilities cost –1 Focus Charge(s). | Tier 3: Herbomancer growth in your cities increases by 3. Their abilities cost –1 Focus Charge(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_mancers.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Qilins',
    description:
      'Elite Qilins. —. army law. Tier 1: Qilin growth in your cities increases by 1. They deal +2 Damage. | Tier 2: Qilin growth in your cities increases by 1. They deal +4 Damage. | Tier 3: Qilin growth in your cities increases by 1. They deal +6 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_qilins.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Luck of the Fittest',
    description:
      'Luck of the Fittest. —. army law. Tier 1: Friendly creatures now have +1% Lucky Strike chance for each point of Luck. | Tier 2: Friendly creatures now have +2% Lucky Strike chance for each point of Luck. | Tier 3: Friendly creatures now have +3% Lucky Strike chance for each point of Luck.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/luck_of_the_fittest.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Elite Phoenixes',
    description:
      'Elite Phoenixes. —. army law. Tier 1: Phoenix growth in your cities increases by 1. Their maximum Damage increases by 10. | Tier 2: Phoenix growth in your cities increases by 1. Their maximum Damage increases by 15. | Tier 3: Phoenix growth in your cities increases by 1. Their maximum Damage increases by 20.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_phoenixes.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Fairy Tale',
    description: 'Fairy Tale. —. army law. Tier 1: Your Fauns, Hoplets and Herbomancers gain 2 Speed and Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/fairy_tale.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Sanctuary',
    description:
      'Sanctuary. —. army law. Tier 1: The abilities of your Vine Iriyads, Naiads, Qilins and Phoenixes cost –1 Focus Charge(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/sanctuary.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'sylvan',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Laws of the Hive',
    description:
      'Laws of the Hive. —. faction law. Tier 1: Requirements for unlocking higher‑level Laws are reduced by 2. | Tier 2: Requirements for unlocking higher‑level Laws are reduced by 4.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/laws_of_the_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Mana Devour',
    description:
      'Mana Devour. —. faction law. Tier 1: Your heroes’ spells cost –1 mana. | Tier 2: Your heroes’ spells cost –2 mana. | Tier 3: Your heroes’ spells cost –3 mana.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mana_devour.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hidden Desires',
    description:
      'Hidden Desires. —. faction law. Tier 1: Your Hive heroes see exact information about neutral squads within [ 3 × hero’s sight ] squares.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hidden_desires.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description:
      'Tax Collectors. —. faction law. Tier 1: Produces 250 Gold daily. | Tier 2: Produces 500 Gold daily. | Tier 3: Produces 750 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Crystals',
    description:
      'Mining: Crystals. —. faction law. Tier 1: Produces 1 Crystal(s) daily. | Tier 2: Produces 2 Crystal(s) daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_crystals_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Focus Reserves',
    description: 'Focus Reserves. —. faction law. Tier 1: Start each battle with +1 Focus Charge(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/focus_reserves.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Ancient Power',
    description: 'Ancient Power. —. faction law. Tier 1: Primal spells of your heroes gain 1 level(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/ancient_power.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Evolve, Adapt, Overcome',
    description:
      'Evolve, Adapt, Overcome. —. faction law. Tier 1: Upgrading your Hive creatures costs –10% Gold. Recruiting upgraded creatures is discounted by the same amount. | Tier 2: Upgrading your Hive creatures costs –20% Gold. Recruiting upgraded creatures is discounted by the same amount.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/evolve_adapt_overcom.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Natural Selection',
    description:
      'Natural Selection. —. faction law. Tier 1: External dwellings in an area that you control produce upgraded creatures.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/natural_selection.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Beelzebub’s Gaze',
    description:
      'Beelzebub’s Gaze. —. faction law. Tier 1: Your Hive heroes see exact information about enemy heroes and cities within [ 3 × hero’s sight ] squares.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/beelzebub_s_gaze.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii_hive.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Prosper and Flourish',
    description:
      'Prosper and Flourish. —. faction law. Tier 1: External dwellings increase respective creature growth in the cities by 50%. | Tier 2: External dwellings increase respective creature growth in the cities by 100%.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/prosper_and_flourish.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Magic',
    description:
      'Hive Magic. —. faction law. Tier 1: Your heroes deal +10% Magic Damage. | Tier 2: Your heroes deal +20% Magic Damage. | Tier 3: Your heroes deal +30% Magic Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_magic.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Integration',
    description:
      'Hive Integration. —. army law. Tier 1: Friendly creatures gain 1 Attack. | Tier 2: Friendly creatures gain 2 Attack. | Tier 3: Friendly creatures gain 3 Attack.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_integration.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Reception',
    description:
      'Hive Reception. —. army law. Tier 1: Friendly creatures gain 1 Defense. | Tier 2: Friendly creatures gain 2 Defense. | Tier 3: Friendly creatures gain 3 Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_reception.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Offsprings I',
    description: 'Hive Offsprings I. —. army law. Tier 1: Summoned Fire Larvae deal +100% Damage on death.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_offsprings_i.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Parasites',
    description:
      'Elite Parasites. —. army law. Tier 1: Parasite growth in your cities increases by 4. They gain 1 HP. | Tier 2: Parasite growth in your cities increases by 4. They gain 2 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_parasites.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Locusts',
    description:
      'Elite Locusts. —. army law. Tier 1: Locust growth in your cities increases by 4. They gain 1 Speed. | Tier 2: Locust growth in your cities increases by 4. They gain 2 Speed.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_locusts.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Hornets',
    description:
      'Elite Hornets. —. army law. Tier 1: Hornet growth in your cities increases by 2. They gain 1 Initiative. | Tier 2: Hornet growth in your cities increases by 2. They gain 2 Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_hornets.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Scorpions',
    description:
      'Elite Scorpions. —. army law. Tier 1: Scorpion growth in your cities increases by 2. They gain 1 Morale and Luck. | Tier 2: Scorpion growth in your cities increases by 2. They gain 3 Morale and Luck.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_scorpions.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Reavers',
    description:
      'Elite Reavers. —. army law. Tier 1: Reaver growth in your cities increases by 1. They gain 1 Morale and 1 Luck. | Tier 2: Reaver growth in your cities increases by 1. They gain 5 Morale and 1 Luck.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_reavers.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Waurmos',
    description:
      'Elite Waurmos. —. army law. Tier 1: Waurms growth in your cities increases by 1. They gain 1 Morale and 1 Luck. | Tier 2: Waurms growth in your cities increases by 1. They gain 5 Morale and 1 Luck.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_waurmos.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Offsprings II',
    description: 'Hive Offsprings II. —. army law. Tier 1: Summoned Fire Larvae attack twice.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_offsprings_ii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Elite Hive Queens',
    description:
      'Elite Hive Queens. —. army law. Tier 1: Hive Queen growth in your cities increases by 1. They deal +5 Damage and gain 25 HP. | Tier 2: Hive Queen growth in your cities increases by 1. They deal +10 Damage and gain 50 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_hive_queens.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Great Conquest',
    description:
      'Great Conquest. —. army law. Tier 1: When battling in the area you do not control, friendly creatures gain 2 Attack and Defense. | Tier 2: When battling in the area you do not control, friendly creatures gain 4 Attack and Defense. | Tier 3: When battling in the area you do not control, friendly creatures gain 6 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/great_conquest.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Infernal Rage',
    description:
      'Infernal Rage. —. army law. Tier 1: Friendly creatures deal +1 Damage. | Tier 2: Friendly creatures deal +2 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/infernal_rage.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'No Compassion',
    description:
      'No Compassion. —. army law. Tier 1: The chance of Morale or Luck triggering for friendly creatures increases by 1% for each point of their Morale or Luck, respectively. | Tier 2: The chance of Morale or Luck triggering for friendly creatures increases by 2% for each point of their Morale or Luck, respectively. | Tier 3: The chance of Morale or Luck triggering for friendly creatures increases by 3% for each point of their Morale or Luck, respectively.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/no_compassion.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Hive Offsprings III',
    description:
      'Hive Offsprings III. —. army law. Tier 1: Summoned Fire Larvae provoke adjacent enemies to attack them over other units.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/hive_offsprings_iii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'hive',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description: 'Tax Collectors. —. faction law. Tier 1: Produces 250 Gold daily. | Tier 2: Produces 500 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Mercury',
    description:
      'Mining: Mercury. —. faction law. Tier 1: Produces 1 Mercury daily. | Tier 2: Produces 2 Mercury daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_mercury.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Generational Wisdom',
    description:
      'Generational Wisdom. —. faction law. Tier 1: Your heroes gain +10% XP. | Tier 2: Your heroes gain +20% XP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/generational_wisdom.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Ra’Shoth',
    description:
      'Elite Ra’Shoth. —. army law. Tier 1: Ra’Shoth growth in your cities increases by 4. They gain 1 Initiative. | Tier 2: Ra’Shoth growth in your cities increases by 8. They gain 1 Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_ra_shoth.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength I',
    description:
      'Unfrozen Strength I. —. army law. Tier 1: Tier‑1 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑1 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_i.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Frozen Homeland',
    description:
      'Frozen Homeland. —. army law. Tier 1: Friendly creatures gain 1 Attack and Defense when they battle on their Native Terrain. | Tier 2: Friendly creatures gain 2 Attack and Defense when they battle on their Native Terrain. | Tier 3: Friendly creatures gain 3 Attack and Defense when they battle on their Native Terrain.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/frozen_homeland.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Ice Power',
    description:
      'Ice Power. —. faction law. Tier 1: Your heroes gain +1 Spell Power. | Tier 2: Your heroes gain +2 Spell Power. | Tier 3: Your heroes gain +3 Spell Power.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/ice_power.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Survival Conditions',
    description:
      'Survival Conditions. —. faction law. Tier 1: Your cities produce +1 Wood and Ore. | Tier 2: Your cities produce +2 Wood and Ore.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/survival_conditions.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Planar Explorers',
    description:
      'Planar Explorers. —. faction law. Tier 1: Produces 250 Astrology points daily. | Tier 2: Produces 500 Astrology points daily. | Tier 3: Produces 750 Astrology points daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/planar_explorers.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Absolute Zero',
    description:
      'Absolute Zero. —. faction law. Tier 1: The cooldowns of all the battle spells of enemy heroes are increased by 1 round(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/absolute_zero.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Inevitable Destruction',
    description:
      'Inevitable Destruction. —. faction law. Tier 1: When destroying artifacts, you gain +10% Alchemical Dust. | Tier 2: When destroying artifacts, you gain +20% Alchemical Dust. | Tier 3: When destroying artifacts, you gain +30% Alchemical Dust.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/inevitable_destruction.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Depths of Mind',
    description:
      'Depths of Mind. —. faction law. Tier 1: Your Schism heroes restore +10% mana each morning. | Tier 2: Your Schism heroes restore +20% mana each morning.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/depths_of_mind.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Cultists',
    description:
      'Elite Cultists. —. army law. Tier 1: Cultist growth in your cities increases by 4. They deal +1 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_cultists.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Aga’Shoth Riders',
    description:
      'Elite Aga’Shoth Riders. —. army law. Tier 1: Aga’Shoth Rider growth in your cities increases by 2. They gain 5 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_aga_shoth_riders.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength II',
    description:
      'Unfrozen Strength II. —. army law. Tier 1: Tier‑2 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑2 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_ii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength III',
    description:
      'Unfrozen Strength III. —. army law. Tier 1: Tier‑3 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑3 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_iii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Otherworldly Magic',
    description: 'Otherworldly Magic. —. faction law. Tier 1: Arcane spells of your heroes gain 1 level.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/otherworldly_magic.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Grand Shoth',
    description:
      'Elite Grand Shoth. —. army law. Tier 1: Grand Shoth growth in your cities increases by 2. They gain 1 Speed. | Tier 2: Grand Shoth growth in your cities increases by 4. They gain 1 Speed.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_grand_shoth.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength IV',
    description:
      'Unfrozen Strength IV. —. army law. Tier 1: Tier‑4 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑4 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_iv.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Cold Touch',
    description:
      'Cold Touch. —. army law. Tier 1: All effects applied by your heroes and friendly creatures last 1 additional round(s). | Tier 2: All effects applied by your heroes and friendly creatures last 2 additional round(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/cold_touch.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Cold Shoulder',
    description:
      'Cold Shoulder. —. faction law. Tier 1: You can use Involuntary Summons in your Schism cities twice per week.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/cold_shoulder.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Call of the Deep',
    description:
      'Call of the Deep. —. faction law. Tier 1: Your Schism heroes’ spells and friendly creatures’ abilities summon +10% units. | Tier 2: Your Schism heroes’ spells and friendly creatures’ abilities summon +20% units.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/call_of_the_deep.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Concubi',
    description:
      'Elite Concubi. —. army law. Tier 1: Concubus growth in your cities increases by 1. They gain 4 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_concubi.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Arbitrators',
    description:
      'Elite Arbitrators. —. army law. Tier 1: Arbitrator growth in your cities increases by 1. They deal +4 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_arbitrators.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength V',
    description:
      'Unfrozen Strength V. —. army law. Tier 1: Tier‑5 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑5 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_v.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen Strength VI',
    description:
      'Unfrozen Strength VI. —. army law. Tier 1: Tier‑6 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑6 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_vi.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Mind Freeze',
    description: 'Mind Freeze. —. faction law. Tier 1: Each round of battle, the enemy loses 1 Focus Charge(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mind_freeze.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'The Abyss Stares Back',
    description:
      'The Abyss Stares Back. —. faction law. Tier 1: Your Schism heroes start each day with maximum Communion level.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/the_abyss_stares_back.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Elite Abyssal Envoys',
    description:
      'Elite Abyssal Envoys. —. army law. Tier 1: Abyssal Envoy growth in your cities increases by 1. They gain 3 Speed and Initiative. | Tier 2: Abyssal Envoy growth in your cities increases by 2. They gain 3 Speed and Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_abyssal_envoys.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Unfrozen strength VII',
    description:
      'Unfrozen strength VII. —. army law. Tier 1: Tier‑7 friendly creatures gain 10% of their hero’s Attack and Spell Power as Attack, 10% of their Defense and Knowledge as Defense. | Tier 2: Tier‑7 friendly creatures gain 20% of their hero’s Attack and Spell Power as Attack, 20% of their Defense and Knowledge as Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/unfrozen_strength_vii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Ice Storms',
    description: 'Ice Storms. —. army law. Tier 1: All enemy creatures lose 1 Speed and Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/ice_storms.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'The World is Ours',
    description: 'The World is Ours. —. faction law. Tier 1: Friendly creatures treat all Terrains as Native.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/the_world_is_ours.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'schism',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description: 'Tax Collectors. —. faction law. Tier 1: Produces 500 Gold daily. | Tier 2: Produces 1000 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors_temple.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i_temple.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Scouting',
    description:
      'Training: Scouting. —. faction law. Tier 1: Your heroes gain 1 Sight radius. | Tier 2: Your heroes gain 2 Sight radius.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_scouting.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Faith in Magic',
    description: 'Faith in Magic. —. faction law. Tier 1: Produces 250 Astrology points daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/faith_in_magic.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Swordsmen',
    description:
      'Elite Swordsmen. —. army law. Tier 1: Swordsman growth in your cities increases by 4. They gain 2 Defense. | Tier 2: Swordsman growth in your cities increases by 4. They gain 4 Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_swordsmen.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Crossbowmen',
    description:
      'Elite Crossbowmen. —. army law. Tier 1: Crossbowman growth in your cities increases by 4. They gain 2 Attack. | Tier 2: Crossbowman growth in your cities increases by 4. They gain 4 Attack.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_crossbowmen.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Inquisition Crusade',
    description:
      'Inquisition Crusade. —. army law. Tier 1: Friendly creatures deal +25% Damage to summoned enemy creatures.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/inquisition_crusade.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Heroes of Tales',
    description:
      'Heroes of Tales. —. faction law. Tier 1: Your heroes gain 1 Morale. | Tier 2: Your heroes gain 2 Morale.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/heroes_of_tales.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Griffins',
    description:
      'Elite Griffins. —. army law. Tier 1: Griffin growth in your cities increases by 2. They gain 5 HP. | Tier 2: Griffin growth in your cities increases by 2. They gain 10 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_griffins.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Lightweavers',
    description:
      'Elite Lightweavers. —. army law. Tier 1: Lightweaver growth in your cities increases by 2. They deal +2 Damage. | Tier 2: Lightweaver growth in your cities increases by 2. They deal +4 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_lightweavers.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Execute Excellence',
    description:
      'Execute Excellence. —. army law. Tier 1: All positive effects on friendly creatures last 1 additional round(s). | Tier 2: All positive effects on friendly creatures last 2 additional round(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/execute_excellence.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Swift Reflexes',
    description: 'Swift Reflexes. —. army law. Tier 1: Friendly creatures gain 1 Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/swift_reflexes.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Gems',
    description: 'Mining: Gems. —. faction law. Tier 1: Produces 1 Gem(s) daily. | Tier 2: Produces 2 Gem(s) daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_gems.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii_temple.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Coinage Reform',
    description:
      'Coinage Reform. —. faction law. Tier 1: Your sources of Gold produce +10% Gold. | Tier 2: Your sources of Gold produce +20% Gold.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/coinage_reform.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Sun’s Grace',
    description: 'Sun’s Grace. —. faction law. Tier 1: Daylight spells of your heroes gain 1 level(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/suns_grace.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Architect’s Mastery',
    description: 'Architect’s Mastery. —. faction law. Tier 1: You can construct +1 building(s) daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/architects_mastery.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Cavalry',
    description:
      'Elite Cavalry. —. army law. Tier 1: Cavalry growth in your cities increases by 1. Their attacks ignore 5% of the target’s Defense and they gain 1 Speed. | Tier 2: Cavalry growth in your cities increases by 1. Their attacks ignore 10% of the target’s Defense and they gain 1 Speed.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_cavalry.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Melee Combat',
    description:
      'Training: Melee Combat. —. army law. Tier 1: Friendly creatures deal +5% and take –5% Melee Damage. This effect is doubled for non‑Temple friendly creatures. | Tier 2: Friendly creatures deal +10% and take –10% Melee Damage. This effect is doubled for non‑Temple friendly creatures.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_melee_combat.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Range Combat',
    description:
      'Training: Range Combat. —. army law. Tier 1: Friendly creatures deal +5% and take –5% Long Reach and Ranged Damage. This effect is doubled for non‑Temple friendly creatures. | Tier 2: Friendly creatures deal +10% and take –10% Long Reach and Ranged Damage. This effect is doubled for non‑Temple friendly creatures.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_range_combat.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Attack',
    description:
      'Training: Attack. —. faction law. Tier 1: Your heroes gain 2 Attack. | Tier 2: Your heroes gain 4 Attack.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_attack.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Defense',
    description:
      'Training: Defense. —. faction law. Tier 1: Your heroes gain 2 Defense. | Tier 2: Your heroes gain 4 Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_defence.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Spell Power',
    description:
      'Training: Spell Power. —. faction law. Tier 1: Your heroes gain 2 Spell Power. | Tier 2: Your heroes gain 4 Spell Power.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_spell_power.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Training: Knowledge',
    description:
      'Training: Knowledge. —. faction law. Tier 1: Your heroes gain 2 Knowledge. | Tier 2: Your heroes gain 4 Knowledge.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/training_knowledge.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Inquisitors',
    description:
      'Elite Inquisitors. —. army law. Tier 1: Inquisitor growth in your cities increases by 1. They ignore 5% of the enemy’s Attack and they gain 1 Speed. | Tier 2: Inquisitor growth in your cities increases by 1. They ignore 10% of the enemy’s Attack and they gain 1 Speed.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_inquisitors.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Encouragement',
    description:
      'Encouragement. —. army law. Tier 1: The chance of Morale triggering for friendly creatures increases by 1% for each point of their Morale. | Tier 2: The chance of Morale triggering for friendly creatures increases by 2% for each point of their Morale. | Tier 3: The chance of Morale triggering for friendly creatures increases by 3% for each point of their Morale.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/encouragement.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Vengeful Strike',
    description:
      'Vengeful Strike. —. army law. Tier 1: Friendly creatures’ counterattacks deal +50% Damage. | Tier 2: Friendly creatures’ counterattacks deal +100% Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/vengeful_strike.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii_temple.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Power of Faith',
    description: 'Power of Faith. —. faction law. Tier 1: All your Temple heroes can learn any spells of any tier.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/power_of_faith.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Elite Angels',
    description:
      'Elite Angels. —. army law. Tier 1: Angel growth in your cities increases by 1. They gain 25% of their hero’s Attack and Defense as Attack and Defense. | Tier 2: Angel growth in your cities increases by 1. They gain 50% of their hero’s Attack and Defense as Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_angels.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Hero’s Blessing',
    description:
      'Hero’s Blessing. —. army law. Tier 1: Friendly creatures gain 25% of their hero’s Spell Power and Knowledge as Attack and Defense respectively.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/heros_blessing.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Sacred Lands',
    description:
      'Sacred Lands. —. army law. Tier 1: Friendly creatures are immune to negative effects when fighting on their Native Terrain.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/sacred_lands.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'temple',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i_necropolis.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description: 'Tax Collectors. —. faction law. Tier 1: Produces 250 Gold daily. | Tier 2: Produces 500 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors_necro.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Animate Dead I',
    description: 'Animate Dead I. —. faction law. Tier 1: Your heroes gain 2% Necromancy Power.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/animate_dead_i.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Skeletons',
    description:
      'Elite Skeletons. —. army law. Tier 1: Skeleton growth in your cities increases by 4. They gain 2 Attack and Defense. | Tier 2: Skeleton growth in your cities increases by 8. They gain 2 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_skeletons.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Wights',
    description:
      'Elite Wights. —. army law. Tier 1: Wight growth in your cities increases by 4. Their minimum Damage increases by 1. | Tier 2: Wight growth in your cities increases by 8. Their minimum Damage increases by 1.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_wights.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Black Death',
    description:
      'Black Death. —. army law. Tier 1: Enemy creatures take +50% from Damage-over-time effects. | Tier 2: Enemy creatures take +100% from Damage-over-time effects.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/black_death.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Mercury',
    description:
      'Mining: Mercury. —. faction law. Tier 1: Produces 1 Mercury daily. | Tier 2: Produces 2 Mercury daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_mercury_necropolis.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Stand to the Death!',
    description:
      'Stand to the Death!. —. faction law. Tier 1: Your heroes gain 1 Defense. | Tier 2: Your heroes gain 2 Defense. | Tier 3: Your heroes gain 3 Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/stand_to_the_death.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii_necropolis.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Animate Dead II',
    description: 'Animate Dead II. —. faction law. Tier 1: Your heroes gain +250 maximum Necromantic Energy.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/animate_dead_ii.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Gifts of the Afterlife',
    description:
      'Gifts of the Afterlife. —. faction law. Tier 1: Your heroes gain 1 Luck. | Tier 2: Your heroes gain 2 Luck. | Tier 3: Your heroes gain 3 Luck.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/afterlife_gifts.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Laws of the Immortals',
    description:
      'Laws of the Immortals. —. faction law. Tier 1: Your cities generate +20% Law points. | Tier 2: Your cities generate +40% Law points. | Tier 3: Your cities generate +60% Law points.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/laws_of_immortal.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Undead Pets',
    description:
      'Elite Undead Pets. —. army law. Tier 1: Undead Pet growth in your cities increases by 2. They gain 2 Initiative. | Tier 2: Undead Pet growth in your cities increases by 4. They gain 2 Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_undead_pets.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Graverobbers',
    description:
      'Elite Graverobbers. —. army law. Tier 1: Graverobber growth in your cities increases by 2. They summon +50% units. | Tier 2: Graverobber growth in your cities increases by 4. They summon +50% units.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_graverobbers.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Death Equalizes All',
    description:
      'Death Equalizes All. —. army law. Tier 1: Friendly creatures from different factions don’t decrease each other’s Morale.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/death_equates_all.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Moon’s Grace',
    description: 'Moon’s Grace. —. faction law. Tier 1: Nightshade spells of your heroes gain 1 level(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/moon_s_grace.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Animate Dead III',
    description: 'Animate Dead III. —. faction law. Tier 1: Your heroes gain 3% Necromancy Power.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/animate_dead_iii.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Forbidden Alchemy',
    description:
      'Forbidden Alchemy. —. faction law. Tier 1: Your spell upgrades cost –20% Alchemical Dust. | Tier 2: Your spell upgrades cost –30% Alchemical Dust. | Tier 3: Your spell upgrades cost –40% Alchemical Dust.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/forbidden_alchemy.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Liches',
    description:
      'Elite Liches. —. army law. Tier 1: Lich growth in your cities increases by 1. Their healing abilities restore 100% more HP. | Tier 2: Lich growth in your cities increases by 2. Their healing abilities restore 100% more HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_liches.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Dread Knights',
    description:
      'Elite Dread Knights. —. army law. Tier 1: Dread Knight growth in your cities increases by 1. Their maximum Damage increases by 6. | Tier 2: Dread Knight growth in your cities increases by 2. Their maximum Damage increases by 6.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_dread_knights.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Bloodthirst',
    description:
      'Bloodthirst. —. army law. Tier 1: Vampirism of friendly creatures increases by 50%. | Tier 2: Vampirism of friendly creatures increases by 100%.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/bloodthirst.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Free Death',
    description:
      'Free Death. —. faction law. Tier 1: Your Necropolis creatures cost –10% Gold. | Tier 2: Your Necropolis creatures cost –15% Gold. | Tier 3: Your Necropolis creatures cost –20% Gold.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/free_death.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Terra Mortis',
    description: 'Terra Mortis. —. faction law. Tier 1: Your Necropolis heroes always battle on their Native Terrain.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/terra_mortis.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Animate Dead IV',
    description: 'Animate Dead IV. —. faction law. Tier 1: Your heroes gain +250 maximum Necromantic Energy.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/animate_dead_iv.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Elite Vampires',
    description:
      'Elite Vampires. —. army law. Tier 1: Vampire growth in your cities increases by 1. They gain 25 HP. | Tier 2: Vampire growth in your cities increases by 2. They gain 25 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_vampires.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Return to the Soil',
    description:
      'Return to the Soil. —. army law. Tier 1: Friendly creatures battling on their Native terrain gain 1 Speed. | Tier 2: Friendly creatures battling on their Native terrain gain 2 Speed.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/return_to_the_soil.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Terror and Dread',
    description:
      'Terror and Dread. —. army law. Tier 1: The chance of Morale or Luck triggering for enemy creatures decreases by 1% for each point of their Morale or Luck, respectively. | Tier 2: The chance of Morale or Luck triggering for enemy creatures decreases by 2% for each point of their Morale or Luck, respectively.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/terror_and_dread.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii_necropolis.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Magic Absorption',
    description: 'Magic Absorption. —. faction law. Tier 1: The enemy loses 1 level(s) on all Magic School spells.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/magic_absorbation.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Animate Dead V',
    description: 'Animate Dead V. —. faction law. Tier 1: Your heroes gain 4% Necromancy Power.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/animate_dead_v.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Morituri te Salutant',
    description: 'Morituri te Salutant. —. army law. Tier 1: Friendly creatures can make +1 counterattacks per round.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/morituri_te_salutant.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Death’s Presence',
    description:
      'Death’s Presence. —. army law. Tier 1: Enemy non‑Necropolis creatures deal –5% and take +5% Damage. Your non‑Necropolis creatures gain the opposite effect. | Tier 2: Enemy non‑Necropolis creatures deal –10% and take +10% Damage. Your non‑Necropolis creatures gain the opposite effect.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/death_presence.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'necropolis',
    },
  },
  {
    id: 'laws',
    name: 'Tax Collectors',
    description: 'Tax Collectors. —. faction law. Tier 1: Produces 250 Gold daily. | Tier 2: Produces 500 Gold daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tax_collectors_dungeon.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches I',
    description:
      'Resource Riches I. —. faction law. Tier 1: Provides a one‑time allotment of 2500 Gold, 5 Wood, and 5 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_i_dungeon.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Arcane Knowledge',
    description: 'Arcane Knowledge. —. faction law. Tier 1: Produces 500 Astrology points daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/arcane_knowledge.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Leaders of the Nation',
    description:
      'Leaders of the Nation. —. faction law. Tier 1: Your heroes generate +10% Law points. | Tier 2: Your heroes generate +10% Law points.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/leaders_of_the_nation.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Troglodytes',
    description:
      'Elite Troglodytes. —. army law. Tier 1: Your Troglodytes deal 1.5 times more Damage when using their Fighting Style. Their min. Damage increases by 1. | Tier 2: Your Troglodytes deal 1.5 times more Damage when using their Fighting Style. Their min. Damage increases by 2.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_troglodytes.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters I',
    description: 'Dungeon Masters I. —. army law. Tier 1: Tier‑1 creature growth in your cities increases by 4.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_i.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dragon Scales',
    description:
      'Dragon Scales. —. army law. Tier 1: Friendly creatures take –5% Magic Damage. | Tier 2: Friendly creatures take –10% Magic Damage. | Tier 3: Friendly creatures take –15% Magic Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dragon_scales.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '3',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Mining: Gems',
    description: 'Mining: Gems. —. faction law. Tier 1: Produces 1 Gem(s) daily. | Tier 2: Produces 2 Gem(s) daily.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/mining_gems_dungeon.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Alchemists Code I',
    description:
      'Alchemists Code I. —. faction law. Tier 1: Provides a one‑time allotment of 75 Alchemical Dust when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/alchemists_code_i.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Infiltrators',
    description:
      'Elite Infiltrators. —. army law. Tier 1: Your Infiltrators deal 1.5 times more Damage when using their Fighting Style. They gain 2 HP. | Tier 2: Your Infiltrators deal 1.5 times more Damage when using their Fighting Style. They gain 4 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_infiltrators.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Dancers',
    description:
      'Elite Dancers. —. army law. Tier 1: Your Onyx Dancers deal 1.5 times more Damage when using their Fighting Style. They gain 2 Attack and Defense. | Tier 2: Your Onyx Dancers deal 1.5 times more Damage when using their Fighting Style. They gain 4 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_dancers.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters II',
    description: 'Dungeon Masters II. —. army law. Tier 1: Tier‑2 creature growth in your cities increases by 4.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_ii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters III',
    description: 'Dungeon Masters III. —. army law. Tier 1: Tier‑3 creature growth in your cities increases by 2.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_iii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches II',
    description:
      'Resource Riches II. —. faction law. Tier 1: Provides a one‑time allotment of 5000 Gold, 10 Wood, and 10 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_ii_dungeon.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Or No Ore?',
    description:
      'Or No Ore?. —. faction law. Tier 1: Your buildings cost –20% Ore to construct. | Tier 2: Your buildings cost –40% Ore to construct.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/or_no_ore.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Jadame Maps',
    description:
      'Jadame Maps. —. faction law. Tier 1: Your heroes gain 10 Movement points. | Tier 2: Your heroes gain 20 Movement points.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/jadame_maps.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Spy Network',
    description:
      'Spy Network. —. faction law. Tier 1: All external buildings and structures under your control gain +2 sight radius. | Tier 2: All external buildings and structures under your control gain +4 sight radius. | Tier 3: All external buildings and structures under your control gain +6 sight radius.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/spy_network.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '3',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Minotaurs',
    description:
      'Elite Minotaurs. —. army law. Tier 1: Your Minotaurs deal 1.5 times more Damage when using their Fighting Style. They gain 1 Speed and Initiative and deal +2 Damage. | Tier 2: Your Minotaurs deal 1.5 times more Damage when using their Fighting Style. They gain 1 Speed and Initiative and deal +4 Damage.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_minotaurs.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Medusae',
    description:
      'Elite Medusae. —. army law. Tier 1: Your Medusae deal 1.5 times more Damage when using their Fighting Style. They gain 1 Initiative and 4 Attack and Defense. | Tier 2: Your Medusae deal 1.5 times more Damage when using their Fighting Style. They gain 2 Initiative and 4 Attack and Defense.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_medusae.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Tactical Advantage',
    description: 'Tactical Advantage. —. army law. Tier 1: All enemy creatures lose 1 Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/tactical_advantage.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters IV',
    description: 'Dungeon Masters IV. —. army law. Tier 1: Tier‑4 creature growth in your cities increases by 2.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_iv.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Merchants Guild',
    description: 'Merchants Guild. —. faction law. Tier 1: Eliminates all price markups in the Marketplace.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/merchants_guild.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Triumvirate’s Agents',
    description:
      'Triumvirate’s Agents. —. faction law. Tier 1: Your Dungeon heroes gain 1 to all attributes. | Tier 2: Your Dungeon heroes gain 2 to all attributes.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/triumvirates_agents.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Alchemists Code II',
    description:
      'Alchemists Code II. —. faction law. Tier 1: Provides a one‑time allotment of 150 Alchemical Dust when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/alchemists_code_ii.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Peoples of Jadame',
    description:
      'Peoples of Jadame. —. faction law. Tier 1: Your heroes’ Persuasion Power in Diplomacy increases by 10%. | Tier 2: Your heroes’ Persuasion Power in Diplomacy increases by 20%.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/peoples_of_jadame.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Hydras',
    description:
      'Elite Hydras. —. army law. Tier 1: Your Hydras deal 1.5 times more Damage when using their Fighting Style. They gain 1 Speed and 25 HP. | Tier 2: Your Hydras deal 1.5 times more Damage when using their Fighting Style. They gain 2 Speed and 25 HP.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_hydras.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters V',
    description: 'Dungeon Masters V. —. army law. Tier 1: Tier‑5 creature growth in your cities increases by 1.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_v.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon masters VI',
    description: 'Dungeon masters VI. —. army law. Tier 1: Tier‑6 creature growth in your cities increases by 1.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_vi.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Resource Riches III',
    description:
      'Resource Riches III. —. faction law. Tier 1: Provides a one‑time allotment of 7500 Gold, 15 Wood, and 15 Ore when enacted.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/resource_riches_iii_dungeon.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Magical Education',
    description: 'Magical Education. —. faction law. Tier 1: Spells of your heroes gain 1 level(s).',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/magical_education.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Saturation',
    description: 'Saturation. —. faction law. Tier 1: Your Focus Charge limit increases by 1.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/saturation.webp',
    properties: {
      Type: 'faction',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Elite Cave Dragons',
    description:
      'Elite Cave Dragons. —. army law. Tier 1: Your Cave Dragons deal 1.5 times more Damage, when using their Fighting Style. They gain 4 Attack and Defense and 1 Speed and Initiative. | Tier 2: Your Cave Dragons deal 1.5 times more Damage, when using their Fighting Style. They gain 8 Attack and Defense and 2 Speed and Initiative.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/elite_cave_dragons.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '2',
      'Faction / Alignment': 'dungeon',
    },
  },
  {
    id: 'laws',
    name: 'Dungeon Masters VII',
    description: 'Dungeon Masters VII. —. army law. Tier 1: Tier‑7 creature growth in your cities increases by 1.',
    url: 'https://www.olden-era.com/en/laws',
    image: 'https://www.olden-era.com/img/laws/dungeon_masters_vii.webp',
    properties: {
      Type: 'army',
      'Tiers Count': '1',
      'Faction / Alignment': 'dungeon',
    },
  },
] satisfies EncyclopediaEntry[]

export const spellEntries = [
  {
    id: 'groundsight',
    name: 'Groundsight',
    description: 'Groundsight. —. primal school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/groundsight',
    image: 'https://www.olden-era.com/img/spells/primal/groundsight.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '1',
    },
  },
  {
    id: 'whean',
    name: 'Wean',
    description: 'Wean. —. primal school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/whean',
    image: 'https://www.olden-era.com/img/spells/primal/whean.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '1',
    },
  },
  {
    id: 'lighting-bolt',
    name: 'Lightning Bolt',
    description: 'Lightning Bolt. —. primal school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/lighting_bolt',
    image: 'https://www.olden-era.com/img/spells/primal/lighting_bolt.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '1',
    },
  },
  {
    id: 'thick-hide',
    name: 'Thick Hide',
    description: 'Thick Hide. —. primal school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/thick_hide',
    image: 'https://www.olden-era.com/img/spells/primal/thick_hide.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '1',
    },
  },
  {
    id: 'blessing',
    name: 'Blessing',
    description: 'Blessing. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/blessing',
    image: 'https://www.olden-era.com/img/spells/daylight/blessing.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'blessing-m',
    name: 'Masterful Blessing',
    description: 'Masterful Blessing. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/blessing_m',
    image: 'https://www.olden-era.com/img/spells/daylight/blessing.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'from-a-birds-eye',
    name: 'From a Bird’s Eye',
    description: 'From a Bird’s Eye. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/from_a_birds_eye',
    image: 'https://www.olden-era.com/img/spells/daylight/from_a_birds_eye.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'healing-water',
    name: 'Healing Water',
    description: 'Healing Water. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/healing_water',
    image: 'https://www.olden-era.com/img/spells/daylight/healing_water.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'healing-water-m',
    name: 'Masterful Healing Water',
    description: 'Masterful Healing Water. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/healing_water_m',
    image: 'https://www.olden-era.com/img/spells/daylight/healing_water.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'haste',
    name: 'Haste',
    description: 'Haste. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/haste',
    image: 'https://www.olden-era.com/img/spells/daylight/haste.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'haste-m',
    name: 'Masterful Haste',
    description: 'Masterful Haste. —. daylight school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/haste_m',
    image: 'https://www.olden-era.com/img/spells/daylight/haste.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '1',
    },
  },
  {
    id: 'early-start',
    name: 'Early Start',
    description: 'Early Start. —. arcane school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/early_start',
    image: 'https://www.olden-era.com/img/spells/arcane/early_start.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '1',
    },
  },
  {
    id: 'early-start-m',
    name: 'Early Start',
    description: 'Early Start. —. arcane school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/early_start_m',
    image: 'https://www.olden-era.com/img/spells/arcane/early_start.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '1',
    },
  },
  {
    id: 'energize',
    name: 'Energize',
    description: 'Energize. —. arcane school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/energize',
    image: 'https://www.olden-era.com/img/spells/arcane/energize.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '1',
    },
  },
  {
    id: 'energy-explosion',
    name: 'Energy Explosion',
    description: 'Energy Explosion. —. arcane school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/energy_explosion',
    image: 'https://www.olden-era.com/img/spells/arcane/energy_explosion.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '1',
    },
  },
  {
    id: 'enlarge-shadow',
    name: 'Enlarge Shadow',
    description: 'Enlarge Shadow. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/enlarge_shadow',
    image: 'https://www.olden-era.com/img/spells/nightshade/enlarge_shadow.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'despair',
    name: 'Despair',
    description: 'Despair. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/despair',
    image: 'https://www.olden-era.com/img/spells/nightshade/despair.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'despair-m',
    name: 'Masterful Despair',
    description: 'Masterful Despair. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/despair_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/despair.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'unnatural-calm',
    name: 'Unnatural Calm',
    description: 'Unnatural Calm. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/unnatural_calm',
    image: 'https://www.olden-era.com/img/spells/nightshade/unnatural_calm.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'unnatural-calm-m',
    name: 'Masterful Unnatural Calm',
    description: 'Masterful Unnatural Calm. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/unnatural_calm_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/unnatural_calm.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'web',
    name: 'Web',
    description: 'Web. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/web',
    image: 'https://www.olden-era.com/img/spells/nightshade/web.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'web-m',
    name: 'Masterful Web',
    description: 'Masterful Web. —. nightshade school spell. tier 1. no description',
    url: 'https://www.olden-era.com/en/spells/web_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/web.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '1',
    },
  },
  {
    id: 'optical-illusion',
    name: 'Optical Illusion',
    description: 'Optical Illusion. —. arcane school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/optical_illusion',
    image: 'https://www.olden-era.com/img/spells/arcane/optical_illusion.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '2',
    },
  },
  {
    id: 'blink',
    name: 'Blink',
    description: 'Blink. —. arcane school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/blink',
    image: 'https://www.olden-era.com/img/spells/arcane/blink.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '2',
    },
  },
  {
    id: 'blink-m',
    name: 'Masterful Blink',
    description: 'Masterful Blink. —. arcane school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/blink_m',
    image: 'https://www.olden-era.com/img/spells/arcane/blink.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '2',
    },
  },
  {
    id: 'trap-temporal-spheres',
    name: 'Temporal Spheres',
    description: 'Temporal Spheres. —. arcane school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/trap_temporal_spheres',
    image: 'https://www.olden-era.com/img/spells/arcane/trap_temporal_spheres.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '2',
    },
  },
  {
    id: 'reinforcements',
    name: 'Reinforcements',
    description: 'Reinforcements. —. arcane school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/reinforcements',
    image: 'https://www.olden-era.com/img/spells/arcane/reinforcements.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '2',
    },
  },
  {
    id: 'inner-light',
    name: 'Inner Light',
    description: 'Inner Light. —. daylight school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/inner_light',
    image: 'https://www.olden-era.com/img/spells/daylight/inner_light.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '2',
    },
  },
  {
    id: 'shorten-shadow',
    name: 'Shorten Shadow',
    description: 'Shorten Shadow. —. daylight school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/shorten_shadow',
    image: 'https://www.olden-era.com/img/spells/daylight/shorten_shadow.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '2',
    },
  },
  {
    id: 'favorable-wind',
    name: 'Favorable Wind',
    description: 'Favorable Wind. —. daylight school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/favorable_wind',
    image: 'https://www.olden-era.com/img/spells/daylight/favorable_wind.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '2',
    },
  },
  {
    id: 'weakening-ray',
    name: 'Weakening Ray',
    description: 'Weakening Ray. —. daylight school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/weakening_ray',
    image: 'https://www.olden-era.com/img/spells/daylight/weakening_ray.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '2',
    },
  },
  {
    id: 'ice-bolt',
    name: 'Ice Bolt',
    description: 'Ice Bolt. —. primal school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/ice_bolt',
    image: 'https://www.olden-era.com/img/spells/primal/ice_bolt.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '2',
    },
  },
  {
    id: 'ice-bolt-m',
    name: 'Masterful Ice Bolt',
    description: 'Masterful Ice Bolt. —. primal school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/ice_bolt_m',
    image: 'https://www.olden-era.com/img/spells/primal/ice_bolt.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '2',
    },
  },
  {
    id: 'crystal-crown',
    name: 'Crystal Crown',
    description: 'Crystal Crown. —. primal school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/crystal_crown',
    image: 'https://www.olden-era.com/img/spells/primal/crystal_crown.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '2',
    },
  },
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Fireball. —. primal school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/fireball',
    image: 'https://www.olden-era.com/img/spells/primal/fireball.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '2',
    },
  },
  {
    id: 'fireball-m',
    name: 'Masterful Fireball',
    description: 'Masterful Fireball. —. primal school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/fireball_m',
    image: 'https://www.olden-era.com/img/spells/primal/fireball.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '2',
    },
  },
  {
    id: 'shade-cloak',
    name: 'Shade Cloak',
    description: 'Shade Cloak. —. nightshade school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/shade_cloak',
    image: 'https://www.olden-era.com/img/spells/nightshade/shade_cloak.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '2',
    },
  },
  {
    id: 'fatal-decay',
    name: 'Fatal Decay',
    description: 'Fatal Decay. —. nightshade school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/fatal_decay',
    image: 'https://www.olden-era.com/img/spells/nightshade/fatal_decay.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '2',
    },
  },
  {
    id: 'read-minds',
    name: 'Read Minds',
    description: 'Read Minds. —. nightshade school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/read_minds',
    image: 'https://www.olden-era.com/img/spells/nightshade/read_minds.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '2',
    },
  },
  {
    id: 'umbral-grip',
    name: 'Umbral Grip',
    description: 'Umbral Grip. —. nightshade school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/umbral_grip',
    image: 'https://www.olden-era.com/img/spells/nightshade/umbral_grip.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '2',
    },
  },
  {
    id: 'umbral-grip-m',
    name: 'Masterful Umbral Grip',
    description: 'Masterful Umbral Grip. —. nightshade school spell. tier 2. no description',
    url: 'https://www.olden-era.com/en/spells/umbral_grip_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/umbral_grip.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '2',
    },
  },
  {
    id: 'song-of-power',
    name: 'Song of Power',
    description: 'Song of Power. —. daylight school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/song_of_power',
    image: 'https://www.olden-era.com/img/spells/daylight/song_of_power.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '3',
    },
  },
  {
    id: 'riposte',
    name: 'Riposte',
    description: 'Riposte. —. daylight school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/riposte',
    image: 'https://www.olden-era.com/img/spells/daylight/riposte.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '3',
    },
  },
  {
    id: 'arinas-touch',
    name: 'Arina’s Touch',
    description: 'Arina’s Touch. —. daylight school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/arinas_touch',
    image: 'https://www.olden-era.com/img/spells/daylight/arinas_touch.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '3',
    },
  },
  {
    id: 'arinas-touch-m',
    name: 'Masterful Arina’s Touch',
    description: 'Masterful Arina’s Touch. —. daylight school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/arinas_touch_m',
    image: 'https://www.olden-era.com/img/spells/daylight/arinas_touch.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '3',
    },
  },
  {
    id: 'taunt',
    name: 'Taunt',
    description: 'Taunt. —. daylight school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/taunt',
    image: 'https://www.olden-era.com/img/spells/daylight/taunt.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '3',
    },
  },
  {
    id: 'assemble',
    name: 'Assemble!',
    description: 'Assemble!. —. arcane school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/assemble',
    image: 'https://www.olden-era.com/img/spells/arcane/assemble.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '3',
    },
  },
  {
    id: 'impending-fate',
    name: 'Impending Fate',
    description: 'Impending Fate. —. arcane school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/impending_fate',
    image: 'https://www.olden-era.com/img/spells/arcane/impending_fate.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '3',
    },
  },
  {
    id: 'carapace',
    name: 'Carapace',
    description: 'Carapace. —. arcane school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/carapace',
    image: 'https://www.olden-era.com/img/spells/arcane/carapace.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '3',
    },
  },
  {
    id: 'carapace-m',
    name: 'Masterful Carapace',
    description: 'Masterful Carapace. —. arcane school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/carapace_m',
    image: 'https://www.olden-era.com/img/spells/arcane/carapace.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '3',
    },
  },
  {
    id: 'shackles',
    name: '手铐',
    description: '手铐. —. arcane school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/shackles',
    image: 'https://www.olden-era.com/img/spells/arcane/shackles.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '3',
    },
  },
  {
    id: 'nairas-veil',
    name: 'Naira’s Veil',
    description: 'Naira’s Veil. —. nightshade school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/nairas_veil',
    image: 'https://www.olden-era.com/img/spells/nightshade/nairas_veil.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '3',
    },
  },
  {
    id: 'sleep',
    name: 'Sleep',
    description: 'Sleep. —. nightshade school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/sleep',
    image: 'https://www.olden-era.com/img/spells/nightshade/sleep.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '3',
    },
  },
  {
    id: 'silence',
    name: 'Silence',
    description: 'Silence. —. nightshade school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/silence',
    image: 'https://www.olden-era.com/img/spells/nightshade/silence.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '3',
    },
  },
  {
    id: 'twilight',
    name: 'Twilight',
    description: 'Twilight. —. nightshade school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/twilight',
    image: 'https://www.olden-era.com/img/spells/nightshade/twilight.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '3',
    },
  },
  {
    id: 'firewall',
    name: 'Firewall',
    description: 'Firewall. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/firewall',
    image: 'https://www.olden-era.com/img/spells/primal/firewall.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'firewall-m',
    name: 'Masterful Firewall',
    description: 'Masterful Firewall. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/firewall_m',
    image: 'https://www.olden-era.com/img/spells/primal/firewall.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'cave-in',
    name: 'Cave In',
    description: 'Cave In. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/cave_in',
    image: 'https://www.olden-era.com/img/spells/primal/cave_in.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'cave-in-m',
    name: 'Masterful Cave In',
    description: 'Masterful Cave In. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/cave_in_m',
    image: 'https://www.olden-era.com/img/spells/primal/cave_in.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'earths-rage',
    name: 'Earth’s Rage',
    description: 'Earth’s Rage. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/earths_rage',
    image: 'https://www.olden-era.com/img/spells/primal/earths_rage.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'stone-fangs',
    name: 'Stone Fangs',
    description: 'Stone Fangs. —. primal school spell. tier 3. no description',
    url: 'https://www.olden-era.com/en/spells/stone_fangs',
    image: 'https://www.olden-era.com/img/spells/primal/stone_fangs.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '3',
    },
  },
  {
    id: 'trap-spacial-snare',
    name: 'Spatial Snare',
    description: 'Spatial Snare. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/trap_spacial_snare',
    image: 'https://www.olden-era.com/img/spells/arcane/trap_spacial_snare.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'rewind-life',
    name: 'Rewind Life',
    description: 'Rewind Life. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/rewind_life',
    image: 'https://www.olden-era.com/img/spells/arcane/rewind_life.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'rewind-life-m',
    name: 'Masterful Rewind Life',
    description: 'Masterful Rewind Life. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/rewind_life_m',
    image: 'https://www.olden-era.com/img/spells/arcane/rewind_life.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'guillotine',
    name: 'Guillotine',
    description: 'Guillotine. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/guillotine',
    image: 'https://www.olden-era.com/img/spells/arcane/guillotine.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'guillotine-m',
    name: 'Masterful Guillotine',
    description: 'Masterful Guillotine. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/guillotine_m',
    image: 'https://www.olden-era.com/img/spells/arcane/guillotine.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'mirror-copy',
    name: 'Mirror Copy',
    description: 'Mirror Copy. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/mirror_copy',
    image: 'https://www.olden-era.com/img/spells/arcane/mirror_copy.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'mirror-copy-m',
    name: 'Masterful Mirror Copy',
    description: 'Masterful Mirror Copy. —. arcane school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/mirror_copy_m',
    image: 'https://www.olden-era.com/img/spells/arcane/mirror_copy.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '4',
    },
  },
  {
    id: 'chain-lighting',
    name: 'Chain Lightning',
    description: 'Chain Lightning. —. primal school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/chain_lighting',
    image: 'https://www.olden-era.com/img/spells/primal/chain_lighting.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '4',
    },
  },
  {
    id: 'chain-lighting-m',
    name: 'Masterful Chain Lightning',
    description: 'Masterful Chain Lightning. —. primal school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/chain_lighting_m',
    image: 'https://www.olden-era.com/img/spells/primal/chain_lighting.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '4',
    },
  },
  {
    id: 'anti-magic',
    name: 'Anti‑Magic',
    description: 'Anti‑Magic. —. primal school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/anti_magic',
    image: 'https://www.olden-era.com/img/spells/primal/anti_magic.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '4',
    },
  },
  {
    id: 'primordial-chaos',
    name: 'Primordial Chaos',
    description: 'Primordial Chaos. —. primal school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/primordial_chaos',
    image: 'https://www.olden-era.com/img/spells/primal/primordial_chaos.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '4',
    },
  },
  {
    id: 'circle-of-winter',
    name: 'Circle of Winter',
    description: 'Circle of Winter. —. primal school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/circle_of_winter',
    image: 'https://www.olden-era.com/img/spells/primal/circle_of_winter.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '4',
    },
  },
  {
    id: 'summon-starchild',
    name: 'Summon Starchild',
    description: 'Summon Starchild. —. nightshade school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/summon_starchild',
    image: 'https://www.olden-era.com/img/spells/nightshade/summon_starchild.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '4',
    },
  },
  {
    id: 'berserk',
    name: 'Berserk',
    description: 'Berserk. —. nightshade school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/berserk',
    image: 'https://www.olden-era.com/img/spells/nightshade/berserk.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '4',
    },
  },
  {
    id: 'berserk-m',
    name: 'Masterful Berserk',
    description: 'Masterful Berserk. —. nightshade school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/berserk_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/berserk.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '4',
    },
  },
  {
    id: 'vulnerability',
    name: 'Vulnerability',
    description: 'Vulnerability. —. nightshade school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/vulnerability',
    image: 'https://www.olden-era.com/img/spells/nightshade/vulnerability.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '4',
    },
  },
  {
    id: 'vulnerability-m',
    name: 'Masterful Vulnerability',
    description: 'Masterful Vulnerability. —. nightshade school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/vulnerability_m',
    image: 'https://www.olden-era.com/img/spells/nightshade/vulnerability.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '4',
    },
  },
  {
    id: 'vengeance',
    name: 'Vengeance',
    description: 'Vengeance. —. daylight school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/vengeance',
    image: 'https://www.olden-era.com/img/spells/daylight/vengeance.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '4',
    },
  },
  {
    id: 'heavenly-blades',
    name: 'Heavenly Blades',
    description: 'Heavenly Blades. —. daylight school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/heavenly_blades',
    image: 'https://www.olden-era.com/img/spells/daylight/heavenly_blades.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '4',
    },
  },
  {
    id: 'clear-fog',
    name: 'Clear Fog',
    description: 'Clear Fog. —. daylight school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/clear_fog',
    image: 'https://www.olden-era.com/img/spells/daylight/clear_fog.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '4',
    },
  },
  {
    id: 'radiant-armour',
    name: 'Radiant Armor',
    description: 'Radiant Armor. —. daylight school spell. tier 4. no description',
    url: 'https://www.olden-era.com/en/spells/radiant_armour',
    image: 'https://www.olden-era.com/img/spells/daylight/radiant_armour.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '4',
    },
  },
  {
    id: 'hksmillas-rampage',
    name: 'Hksmilla’s Rampage',
    description: 'Hksmilla’s Rampage. —. primal school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/hksmillas_rampage',
    image: 'https://www.olden-era.com/img/spells/primal/hksmillas_rampage.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '5',
    },
  },
  {
    id: 'summon-primal-remnant',
    name: 'Summon Primal Remnant',
    description: 'Summon Primal Remnant. —. primal school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/summon_primal_remnant',
    image: 'https://www.olden-era.com/img/spells/primal/summon_primal_remnant.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '5',
    },
  },
  {
    id: 'armageddon',
    name: 'Armageddon',
    description: 'Armageddon. —. primal school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/armageddon',
    image: 'https://www.olden-era.com/img/spells/primal/armageddon.webp',
    properties: {
      'Magic School': 'primal',
      'Tier / Level': '5',
    },
  },
  {
    id: 'judgement',
    name: 'Judgement',
    description: 'Judgement. —. daylight school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/judgement',
    image: 'https://www.olden-era.com/img/spells/daylight/judgement.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '5',
    },
  },
  {
    id: 'arinas-chosen',
    name: 'Arina’s Chosen',
    description: 'Arina’s Chosen. —. daylight school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/arinas_chosen',
    image: 'https://www.olden-era.com/img/spells/daylight/arinas_chosen.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '5',
    },
  },
  {
    id: 'arinas-chosen-m',
    name: 'Masterful Arina’s Chosen',
    description: 'Masterful Arina’s Chosen. —. daylight school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/arinas_chosen_m',
    image: 'https://www.olden-era.com/img/spells/daylight/arinas_chosen.webp',
    properties: {
      'Magic School': 'daylight',
      'Tier / Level': '5',
    },
  },
  {
    id: 'coup-de-grace',
    name: 'Coup de Grâce',
    description: 'Coup de Grâce. —. nightshade school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/coup_de_grace',
    image: 'https://www.olden-era.com/img/spells/nightshade/coup_de_grace.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '5',
    },
  },
  {
    id: 'shadow-army',
    name: 'Shadow Army',
    description: 'Shadow Army. —. nightshade school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/shadow_army',
    image: 'https://www.olden-era.com/img/spells/nightshade/shadow_army.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '5',
    },
  },
  {
    id: 'nairas-kiss',
    name: 'Naira’s Kiss',
    description: 'Naira’s Kiss. —. nightshade school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/nairas_kiss',
    image: 'https://www.olden-era.com/img/spells/nightshade/nairas_kiss.webp',
    properties: {
      'Magic School': 'nightshade',
      'Tier / Level': '5',
    },
  },
  {
    id: 'black-hole',
    name: 'Black Hole',
    description: 'Black Hole. —. arcane school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/black_hole',
    image: 'https://www.olden-era.com/img/spells/arcane/black_hole.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '5',
    },
  },
  {
    id: 'doreaths-tide',
    name: 'Doreath’s Tide',
    description: 'Doreath’s Tide. —. arcane school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/doreaths_tide',
    image: 'https://www.olden-era.com/img/spells/arcane/doreaths_tide.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '5',
    },
  },
  {
    id: 'reality-distortion',
    name: 'Reality Distortion',
    description: 'Reality Distortion. —. arcane school spell. tier 5. no description',
    url: 'https://www.olden-era.com/en/spells/reality_distortion',
    image: 'https://www.olden-era.com/img/spells/arcane/reality_distortion.webp',
    properties: {
      'Magic School': 'arcane',
      'Tier / Level': '5',
    },
  },
] satisfies EncyclopediaEntry[]

export const classEntries = [
  {
    id: 'warden',
    name: 'Warden',
    description: 'Warden — class of the sylvan faction',
    url: 'https://www.olden-era.com/en/classes/warden',
    image: 'https://www.olden-era.com/img/subclass/wellspring_of_vigor.webp',
    properties: {
      Faction: 'sylvan',
    },
  },
  {
    id: 'druid',
    name: 'Druid',
    description: 'Druid — class of the sylvan faction',
    url: 'https://www.olden-era.com/en/classes/druid',
    image: 'https://www.olden-era.com/img/subclass/celestial_envoy.webp',
    properties: {
      Faction: 'sylvan',
    },
  },
  {
    id: 'enforcer',
    name: 'Enforcer',
    description: 'Enforcer — class of the hive faction',
    url: 'https://www.olden-era.com/en/classes/enforcer',
    image: 'https://www.olden-era.com/img/subclass/broodmother.webp',
    properties: {
      Faction: 'hive',
    },
  },
  {
    id: 'herald',
    name: 'Herald',
    description: 'Herald — class of the hive faction',
    url: 'https://www.olden-era.com/en/classes/herald',
    image: 'https://www.olden-era.com/img/subclass/progenitor.webp',
    properties: {
      Faction: 'hive',
    },
  },
  {
    id: 'overlord',
    name: 'Overlord',
    description: 'Overlord — class of the dungeon faction',
    url: 'https://www.olden-era.com/en/classes/overlord',
    image: 'https://www.olden-era.com/img/subclass/balthazars_bodyguard.webp',
    properties: {
      Faction: 'dungeon',
    },
  },
  {
    id: 'warlock',
    name: 'Warlock',
    description: 'Warlock — class of the dungeon faction',
    url: 'https://www.olden-era.com/en/classes/warlock',
    image: 'https://www.olden-era.com/img/subclass/amelchias_heir.webp',
    properties: {
      Faction: 'dungeon',
    },
  },
  {
    id: 'death-knight',
    name: 'Death Knight',
    description: 'Death Knight — class of the necropolis faction',
    url: 'https://www.olden-era.com/en/classes/death_knight',
    image: 'https://www.olden-era.com/img/subclass/walking_rot.webp',
    properties: {
      Faction: 'necropolis',
    },
  },
  {
    id: 'necromancer',
    name: 'Necromancer',
    description: 'Necromancer — class of the necropolis faction',
    url: 'https://www.olden-era.com/en/classes/necromancer',
    image: 'https://www.olden-era.com/img/subclass/chronomancer.webp',
    properties: {
      Faction: 'necropolis',
    },
  },
  {
    id: 'oathkeeper',
    name: 'Oathkeeper',
    description: 'Oathkeeper — class of the schism faction',
    url: 'https://www.olden-era.com/en/classes/oathkeeper',
    image: 'https://www.olden-era.com/img/subclass/unfeeling.webp',
    properties: {
      Faction: 'schism',
    },
  },
  {
    id: 'riftspeaker',
    name: 'Riftspeaker',
    description: 'Riftspeaker — class of the schism faction',
    url: 'https://www.olden-era.com/en/classes/riftspeaker',
    image: 'https://www.olden-era.com/img/subclass/unfathomable.webp',
    properties: {
      Faction: 'schism',
    },
  },
  {
    id: 'cleric',
    name: 'Cleric',
    description: 'Cleric — class of the temple faction',
    url: 'https://www.olden-era.com/en/classes/cleric',
    image: 'https://www.olden-era.com/img/subclass/grand_inquisitor.webp',
    properties: {
      Faction: 'temple',
    },
  },
  {
    id: 'knight',
    name: 'Knight',
    description: 'Knight — class of the temple faction',
    url: 'https://www.olden-era.com/en/classes/knight',
    image: 'https://www.olden-era.com/img/subclass/paragon.webp',
    properties: {
      Faction: 'temple',
    },
  },
] satisfies EncyclopediaEntry[]

export const factionDirectoryEntries = [
  {
    id: 'temple',
    name: 'Temple',
    description: 'Temple — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/temple',
    image: 'https://www.olden-era.com/img/factions/temple.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'schism',
    name: 'Schism',
    description: 'Schism — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/schism',
    image: 'https://www.olden-era.com/img/factions/schism.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'dungeon',
    name: 'Dungeon',
    description: 'Dungeon — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/dungeon',
    image: 'https://www.olden-era.com/img/factions/dungeon.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'necropolis',
    name: 'Necropolis',
    description: 'Necropolis — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/necropolis',
    image: 'https://www.olden-era.com/img/factions/necropolis.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'neutral',
    name: 'Neutral',
    description: 'Neutral — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/neutral',
    image: 'https://www.olden-era.com/img/factions/neutral.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'sylvan',
    name: 'Sylvan',
    description: 'Sylvan — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/sylvan',
    image: 'https://www.olden-era.com/img/factions/sylvan.webp',
    properties: {
      'Units Count': '0',
    },
  },
  {
    id: 'hive',
    name: 'Hive',
    description: 'Hive — playable faction in Heroes of Might and Magic: Olden Era.',
    url: 'https://www.olden-era.com/en/factions/hive',
    image: 'https://www.olden-era.com/img/factions/hive.webp',
    properties: {
      'Units Count': '0',
    },
  },
] satisfies EncyclopediaEntry[]

export const artifactDirectoryEntries = [
  {
    id: 'fish-to-the-face',
    name: 'Fish‑to‑the‑Face',
    description: 'Fish‑to‑the‑Face — main_hand slot artefact (+1 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/fish_to_the_face',
    image: 'https://www.olden-era.com/img/artefacts/fish_to_the_face.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+1 Attack.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'lance',
    name: 'Lance',
    description: 'Lance — main_hand slot artefact (+3 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/lance',
    image: 'https://www.olden-era.com/img/artefacts/lance.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+3 Attack.',
      Set: 'knights_honor',
      Rarity: 'rare',
    },
  },
  {
    id: 'red-dragon-flame-tongue',
    name: 'Red Dragon Flame Tongue',
    description: 'Red Dragon Flame Tongue — main_hand slot artefact (+2 Attack and Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/red_dragon_flame_tongue',
    image: 'https://www.olden-era.com/img/artefacts/red_dragon_flame_tongue.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+2 Attack and Defense.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'rare',
    },
  },
  {
    id: 'dark-hatchet',
    name: 'Dark Hatchet',
    description: 'Dark Hatchet — main_hand slot artefact (+4 Attack, then +15% total Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/dark_hatchet',
    image: 'https://www.olden-era.com/img/artefacts/dark_hatchet.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+4 Attack, then +15% total Attack.',
      Set: 'shadow_of_death',
      Rarity: 'epic',
    },
  },
  {
    id: 'excalibur',
    name: 'Excalibur',
    description:
      'Excalibur — main_hand slot artefact (Heroic Strike kills +1 unit(s). Works on creatures up to tier 7.)',
    url: 'https://www.olden-era.com/en/artefacts/excalibur',
    image: 'https://www.olden-era.com/img/artefacts/excalibur.webp',
    properties: {
      Slot: 'main_hand',
      Effect: 'Heroic Strike kills +1 unit(s). Works on creatures up to tier 7.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'garotte',
    name: 'Garotte',
    description: 'Garotte — main_hand slot artefact (–1 Speed to all enemies.)',
    url: 'https://www.olden-era.com/en/artefacts/garotte',
    image: 'https://www.olden-era.com/img/artefacts/garotte.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '–1 Speed to all enemies.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'rapier',
    name: 'Rapier',
    description: 'Rapier — main_hand slot artefact (Friendly creatures deal +10% Melee Damage)',
    url: 'https://www.olden-era.com/en/artefacts/rapier',
    image: 'https://www.olden-era.com/img/artefacts/rapier.webp',
    properties: {
      Slot: 'main_hand',
      Effect: 'Friendly creatures deal +10% Melee Damage',
      Set: 'duelists_pride',
      Rarity: 'rare',
    },
  },
  {
    id: 'shaman-staff',
    name: 'Shaman Staff',
    description: 'Shaman Staff — main_hand slot artefact (+6 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/shaman_staff',
    image: 'https://www.olden-era.com/img/artefacts/shaman_staff.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+6 Spell Power.',
      Set: 'shamaniac_soul',
      Rarity: 'epic',
    },
  },
  {
    id: 'shroomwood-bow',
    name: 'Shroomwood Bow',
    description: 'Shroomwood Bow — main_hand slot artefact (Eliminates Ranged Damage penalty for friendly creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/shroomwood_bow',
    image: 'https://www.olden-era.com/img/artefacts/shroomwood_bow.webp',
    properties: {
      Slot: 'main_hand',
      Effect: 'Eliminates Ranged Damage penalty for friendly creatures.',
      Set: 'living_arrows',
      Rarity: 'epic',
    },
  },
  {
    id: 'truthmaker',
    name: 'Truthmaker',
    description: 'Truthmaker — main_hand slot artefact (–10% Attack to enemy creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/truthmaker',
    image: 'https://www.olden-era.com/img/artefacts/truthmaker.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '–10% Attack to enemy creatures.',
      Set: 'dominion_of_puppeteers',
      Rarity: 'epic',
    },
  },
  {
    id: 'demon-claw',
    name: 'Demon Claw',
    description: 'Demon Claw — main_hand slot artefact (+12 Attack, but –4 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/demon_claw',
    image: 'https://www.olden-era.com/img/artefacts/demon_claw.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+12 Attack, but –4 Defense.',
      Set: 'beelzebubs_chosen',
      Rarity: 'legendary',
    },
  },
  {
    id: 'ogres-club-of-havoc',
    name: 'Ogre’s Club of Havoc',
    description: 'Ogre’s Club of Havoc — main_hand slot artefact (+4 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/ogres_club_of_havoc',
    image: 'https://www.olden-era.com/img/artefacts/ogres_club_of_havoc.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+4 Attack.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'sword-of-judgement',
    name: 'Sword of Judgement',
    description: 'Sword of Judgement — main_hand slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/sword_of_judgement',
    image: 'https://www.olden-era.com/img/artefacts/sword_of_judgement.webp',
    properties: {
      Slot: 'main_hand',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'shoddy-shield',
    name: 'Shoddy Shield',
    description: 'Shoddy Shield — off_hand slot artefact (+2 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/shoddy_shield',
    image: 'https://www.olden-era.com/img/artefacts/shoddy_shield.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+2 Defense.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'misericorde',
    name: 'Misericorde',
    description: 'Misericorde — off_hand slot artefact (+2 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/misericorde',
    image: 'https://www.olden-era.com/img/artefacts/misericorde.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+2 Attack.',
      Set: 'knights_honor',
      Rarity: 'common',
    },
  },
  {
    id: 'singing-pan-pipe',
    name: 'Singing Pan‑Pipe',
    description:
      'Singing Pan‑Pipe — off_hand slot artefact (Over Time effects cast by friendly creatures last for +1 round.)',
    url: 'https://www.olden-era.com/en/artefacts/singing_pan_pipe',
    image: 'https://www.olden-era.com/img/artefacts/singing_pan_pipe.webp',
    properties: {
      Slot: 'off_hand',
      Effect: 'Over Time effects cast by friendly creatures last for +1 round.',
      Set: 'inner_song',
      Rarity: 'common',
    },
  },
  {
    id: 'buckler',
    name: 'Buckler',
    description:
      'Buckler — off_hand slot artefact (Friendly creatures can counterattack even if the attacking enemy has “Swift Strike.”)',
    url: 'https://www.olden-era.com/en/artefacts/buckler',
    image: 'https://www.olden-era.com/img/artefacts/buckler.webp',
    properties: {
      Slot: 'off_hand',
      Effect: 'Friendly creatures can counterattack even if the attacking enemy has “Swift Strike.”',
      Set: 'duelists_pride',
      Rarity: 'common',
    },
  },
  {
    id: 'caduceus',
    name: 'Caduceus',
    description: 'Caduceus — off_hand slot artefact (Heroic Strike restores 6 mana.)',
    url: 'https://www.olden-era.com/en/artefacts/caduceus',
    image: 'https://www.olden-era.com/img/artefacts/caduceus.webp',
    properties: {
      Slot: 'off_hand',
      Effect: 'Heroic Strike restores 6 mana.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'crescent-dagger',
    name: 'Crescent Dagger',
    description:
      'Crescent Dagger — off_hand slot artefact (Spells and creature abilities ignore 40% of enemy magic resistance.)',
    url: 'https://www.olden-era.com/en/artefacts/crescent_dagger',
    image: 'https://www.olden-era.com/img/artefacts/crescent_dagger.webp',
    properties: {
      Slot: 'off_hand',
      Effect: 'Spells and creature abilities ignore 40% of enemy magic resistance.',
      Set: 'ethereal_knowledge',
      Rarity: 'rare',
    },
  },
  {
    id: 'dragon-scale-shield',
    name: 'Dragon Scale Shield',
    description: 'Dragon Scale Shield — off_hand slot artefact (+3 Attack and Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/dragon_scale_shield',
    image: 'https://www.olden-era.com/img/artefacts/dragon_scale_shield.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+3 Attack and Defense.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'epic',
    },
  },
  {
    id: 'fine-wand',
    name: 'Fine Wand',
    description: 'Fine Wand — off_hand slot artefact (+1 level to all spells.)',
    url: 'https://www.olden-era.com/en/artefacts/fine_wand',
    image: 'https://www.olden-era.com/img/artefacts/fine_wand.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+1 level to all spells.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'truthseeker',
    name: 'Truthseeker',
    description: 'Truthseeker — off_hand slot artefact (–10% Defense to enemy creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/truthseeker',
    image: 'https://www.olden-era.com/img/artefacts/truthseeker.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '–10% Defense to enemy creatures.',
      Set: 'dominion_of_puppeteers',
      Rarity: 'epic',
    },
  },
  {
    id: 'chitinous-shield',
    name: 'Chitinous Shield',
    description: 'Chitinous Shield — off_hand slot artefact (+12 Defense, but –4 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/chitinous_shield',
    image: 'https://www.olden-era.com/img/artefacts/chitinous_shield.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+12 Defense, but –4 Attack.',
      Set: 'beelzebubs_chosen',
      Rarity: 'legendary',
    },
  },
  {
    id: 'hourglass-of-protection',
    name: 'Pelagic Hourglass',
    description: 'Pelagic Hourglass — off_hand slot artefact (The cooldowns of all spells are reduced by 1 round(s).)',
    url: 'https://www.olden-era.com/en/artefacts/hourglass_of_protection',
    image: 'https://www.olden-era.com/img/artefacts/hourglass_of_protection.webp',
    properties: {
      Slot: 'off_hand',
      Effect: 'The cooldowns of all spells are reduced by 1 round(s).',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'lions-shield-of-courage',
    name: 'Lion’s Shield of Courage',
    description: 'Lion’s Shield of Courage — off_hand slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/lions_shield_of_courage',
    image: 'https://www.olden-era.com/img/artefacts/lions_shield_of_courage.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'shield-of-the-rampaging-ogre',
    name: 'Shield of the Rampaging Ogre',
    description: 'Shield of the Rampaging Ogre — off_hand slot artefact (+4 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/shield_of_the_rampaging_ogre',
    image: 'https://www.olden-era.com/img/artefacts/shield_of_the_rampaging_ogre.webp',
    properties: {
      Slot: 'off_hand',
      Effect: '+4 Defense.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'fancy-mask',
    name: 'Fancy Mask',
    description: 'Fancy Mask — head slot artefact (Generates 2 Focus Point(s) at the start of the battle.)',
    url: 'https://www.olden-era.com/en/artefacts/fancy_mask',
    image: 'https://www.olden-era.com/img/artefacts/fancy_mask.webp',
    properties: {
      Slot: 'head',
      Effect: 'Generates 2 Focus Point(s) at the start of the battle.',
      Set: 'inner_song',
      Rarity: 'common',
    },
  },
  {
    id: 'straw-hat',
    name: 'Straw Hat',
    description: 'Straw Hat — head slot artefact (+1 Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/straw_hat',
    image: 'https://www.olden-era.com/img/artefacts/straw_hat.webp',
    properties: {
      Slot: 'head',
      Effect: '+1 Knowledge.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'head-torch',
    name: 'Head Torch',
    description: 'Head Torch — head slot artefact (+1 sight radius.)',
    url: 'https://www.olden-era.com/en/artefacts/head_torch',
    image: 'https://www.olden-era.com/img/artefacts/head_torch.webp',
    properties: {
      Slot: 'head',
      Effect: '+1 sight radius.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'scholars-tiara',
    name: 'Scholar’s Tiara',
    description: 'Scholar’s Tiara — head slot artefact (+2 Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/scholars_tiara',
    image: 'https://www.olden-era.com/img/artefacts/scholars_tiara.webp',
    properties: {
      Slot: 'head',
      Effect: '+2 Knowledge.',
      Set: 'scholars_wisdom',
      Rarity: 'rare',
    },
  },
  {
    id: 'armet',
    name: 'Armet',
    description: 'Armet — head slot artefact (+2 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/armet',
    image: 'https://www.olden-era.com/img/artefacts/armet.webp',
    properties: {
      Slot: 'head',
      Effect: '+2 Defense.',
      Set: 'knights_honor',
      Rarity: 'common',
    },
  },
  {
    id: 'sirin-mask',
    name: 'Sirin Mask',
    description: 'Sirin Mask — head slot artefact (The cooldowns of all spells are reduced by 1 round(s).)',
    url: 'https://www.olden-era.com/en/artefacts/sirin_mask',
    image: 'https://www.olden-era.com/img/artefacts/sirin_mask.webp',
    properties: {
      Slot: 'head',
      Effect: 'The cooldowns of all spells are reduced by 1 round(s).',
      Set: 'shamaniac_soul',
      Rarity: 'legendary',
    },
  },
  {
    id: 'helm-of-heavenly-enlightenment',
    name: 'Helm of Heavenly Enlightenment',
    description:
      'Helm of Heavenly Enlightenment — head slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/helm_of_heavenly_enlightenment',
    image: 'https://www.olden-era.com/img/artefacts/helm_of_heavenly_enlightenment.webp',
    properties: {
      Slot: 'head',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'mirror-tiara',
    name: 'Mirror Tiara',
    description: 'Mirror Tiara — head slot artefact (Restores 8 mana to the hero each morning.)',
    url: 'https://www.olden-era.com/en/artefacts/mirror_tiara',
    image: 'https://www.olden-era.com/img/artefacts/mirror_tiara.webp',
    properties: {
      Slot: 'head',
      Effect: 'Restores 8 mana to the hero each morning.',
      Set: 'tranquil_glass',
      Rarity: 'epic',
    },
  },
  {
    id: 'crown-of-dragontooth',
    name: 'Crown of Dragontooth',
    description: 'Crown of Dragontooth — head slot artefact (+4 Spell Power and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/crown_of_dragontooth',
    image: 'https://www.olden-era.com/img/artefacts/crown_of_dragontooth.webp',
    properties: {
      Slot: 'head',
      Effect: '+4 Spell Power and Knowledge.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'legendary',
    },
  },
  {
    id: 'beelzebubs-boon',
    name: 'Beelzebub’s Boon',
    description: 'Beelzebub’s Boon — head slot artefact (+12 Knowledge, but –4 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/beelzebubs_boon',
    image: 'https://www.olden-era.com/img/artefacts/beelzebubs_boon.webp',
    properties: {
      Slot: 'head',
      Effect: '+12 Knowledge, but –4 Spell Power.',
      Set: 'beelzebubs_chosen',
      Rarity: 'legendary',
    },
  },
  {
    id: 'seven-eyes',
    name: 'Seven Eyes',
    description: 'Seven Eyes — head slot artefact (+1 level(s) to all spells while worn.)',
    url: 'https://www.olden-era.com/en/artefacts/seven_eyes',
    image: 'https://www.olden-era.com/img/artefacts/seven_eyes.webp',
    properties: {
      Slot: 'head',
      Effect: '+1 level(s) to all spells while worn.',
      Set: 'ethereal_knowledge',
      Rarity: 'legendary',
    },
  },
  {
    id: 'two-faced-mask',
    name: 'Two‑faced Mask',
    description:
      'Two‑faced Mask — head slot artefact (The hero can use the Spellbook 1 additional time(s) per battle round.)',
    url: 'https://www.olden-era.com/en/artefacts/two_faced_mask',
    image: 'https://www.olden-era.com/img/artefacts/two_faced_mask.webp',
    properties: {
      Slot: 'head',
      Effect: 'The hero can use the Spellbook 1 additional time(s) per battle round.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'spellbinders-hat',
    name: 'Spellbinder’s Hat',
    description: 'Spellbinder’s Hat — head slot artefact (Makes all tier‑5 spells available to the hero.)',
    url: 'https://www.olden-era.com/en/artefacts/spellbinders_hat',
    image: 'https://www.olden-era.com/img/artefacts/spellbinders_hat.webp',
    properties: {
      Slot: 'head',
      Effect: 'Makes all tier‑5 spells available to the hero.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'amelchias-law',
    name: 'Amelchia’s Law',
    description: 'Amelchia’s Law — head slot artefact (–1 Initiative to enemy creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/amelchias_law',
    image: 'https://www.olden-era.com/img/artefacts/amelchias_law.webp',
    properties: {
      Slot: 'head',
      Effect: '–1 Initiative to enemy creatures.',
      Set: 'dominion_of_puppeteers',
      Rarity: 'legendary',
    },
  },
  {
    id: 'crown-of-the-supreme-magi',
    name: 'Crown of the Supreme Magi',
    description: 'Crown of the Supreme Magi — head slot artefact (+4 Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/crown_of_the_supreme_magi',
    image: 'https://www.olden-era.com/img/artefacts/crown_of_the_supreme_magi.webp',
    properties: {
      Slot: 'head',
      Effect: '+4 Knowledge.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'rags',
    name: 'Rags',
    description: 'Rags — chest slot artefact (+1 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/rags',
    image: 'https://www.olden-era.com/img/artefacts/rags.webp',
    properties: {
      Slot: 'chest',
      Effect: '+1 Spell Power.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'chain-mail',
    name: 'Chain Mail',
    description: 'Chain Mail — chest slot artefact (+3 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/chain_mail',
    image: 'https://www.olden-era.com/img/artefacts/chain_mail.webp',
    properties: {
      Slot: 'chest',
      Effect: '+3 Defense.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'plate-armour',
    name: 'Plate Armor',
    description: 'Plate Armor — chest slot artefact (+3 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/plate_armour',
    image: 'https://www.olden-era.com/img/artefacts/plate_armour.webp',
    properties: {
      Slot: 'chest',
      Effect: '+3 Defense.',
      Set: 'knights_honor',
      Rarity: 'rare',
    },
  },
  {
    id: 'vortex-robe',
    name: 'Vortex Robe',
    description:
      'Vortex Robe — chest slot artefact (Whenever the opponent casts a spell, restores 40% of its cost as mana to the wearer.)',
    url: 'https://www.olden-era.com/en/artefacts/vortex_robe',
    image: 'https://www.olden-era.com/img/artefacts/vortex_robe.webp',
    properties: {
      Slot: 'chest',
      Effect: 'Whenever the opponent casts a spell, restores 40% of its cost as mana to the wearer.',
      Set: 'ethereal_knowledge',
      Rarity: 'rare',
    },
  },
  {
    id: 'ribcage-armour',
    name: 'Ribcage Armor',
    description: 'Ribcage Armor — chest slot artefact (+4 Defense, then +15% total Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/ribcage_armour',
    image: 'https://www.olden-era.com/img/artefacts/ribcage_armour.webp',
    properties: {
      Slot: 'chest',
      Effect: '+4 Defense, then +15% total Defense.',
      Set: 'shadow_of_death',
      Rarity: 'epic',
    },
  },
  {
    id: 'iridescent-cloak',
    name: 'Iridescent Cloak',
    description: 'Iridescent Cloak — chest slot artefact (+6 Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/iridescent_cloak',
    image: 'https://www.olden-era.com/img/artefacts/iridescent_cloak.webp',
    properties: {
      Slot: 'chest',
      Effect: '+6 Knowledge.',
      Set: 'shamaniac_soul',
      Rarity: 'epic',
    },
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    description: 'Heartbeat — chest slot artefact (+12 Spell Power, but –4 Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/heartbeat',
    image: 'https://www.olden-era.com/img/artefacts/heartbeat.webp',
    properties: {
      Slot: 'chest',
      Effect: '+12 Spell Power, but –4 Knowledge.',
      Set: 'beelzebubs_chosen',
      Rarity: 'legendary',
    },
  },
  {
    id: 'armour-of-wonder',
    name: 'Armor of Wonder',
    description: 'Armor of Wonder — chest slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/armour_of_wonder',
    image: 'https://www.olden-era.com/img/artefacts/armour_of_wonder.webp',
    properties: {
      Slot: 'chest',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'dragon-scale-armour',
    name: 'Dragon Scale Armor',
    description: 'Dragon Scale Armor — chest slot artefact (+4 Attack and Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/dragon_scale_armour',
    image: 'https://www.olden-era.com/img/artefacts/dragon_scale_armour.webp',
    properties: {
      Slot: 'chest',
      Effect: '+4 Attack and Defense.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'legendary',
    },
  },
  {
    id: 'tunic-of-the-cyclops-king',
    name: 'Tunic of the Cyclops King',
    description: 'Tunic of the Cyclops King — chest slot artefact (+4 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/tunic_of_the_cyclops_king',
    image: 'https://www.olden-era.com/img/artefacts/tunic_of_the_cyclops_king.webp',
    properties: {
      Slot: 'chest',
      Effect: '+4 Spell Power.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'eagle-armour',
    name: 'Eagle Armor',
    description: 'Eagle Armor — chest slot artefact (+2 Morale and Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/eagle_armour',
    image: 'https://www.olden-era.com/img/artefacts/eagle_armour.webp',
    properties: {
      Slot: 'chest',
      Effect: '+2 Morale and Luck.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'robe-of-enlightment',
    name: 'Robe of Enlightenment',
    description: 'Robe of Enlightenment — chest slot artefact (Makes all tier‑3 spells available to the hero.)',
    url: 'https://www.olden-era.com/en/artefacts/robe_of_enlightment',
    image: 'https://www.olden-era.com/img/artefacts/robe_of_enlightment.webp',
    properties: {
      Slot: 'chest',
      Effect: 'Makes all tier‑3 spells available to the hero.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'rope-belt',
    name: 'Rope Belt',
    description: 'Rope Belt — waist slot artefact (+1 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/rope_belt',
    image: 'https://www.olden-era.com/img/artefacts/rope_belt.webp',
    properties: {
      Slot: 'waist',
      Effect: '+1 Defense.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'soulless-sash',
    name: 'Soulless Sash',
    description: 'Soulless Sash — waist slot artefact (–1 Morale to enemy creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/soulless_sash',
    image: 'https://www.olden-era.com/img/artefacts/soulless_sash.webp',
    properties: {
      Slot: 'waist',
      Effect: '–1 Morale to enemy creatures.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'endless-bag',
    name: 'Endless Bag',
    description:
      'Endless Bag — waist slot artefact (Produces +1 Gem, Crystal, or Mercury daily. (The resource depends on the bearer’s faction.))',
    url: 'https://www.olden-era.com/en/artefacts/endless_bag',
    image: 'https://www.olden-era.com/img/artefacts/endless_bag.webp',
    properties: {
      Slot: 'waist',
      Effect: 'Produces +1 Gem, Crystal, or Mercury daily. (The resource depends on the bearer’s faction.)',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'flask-of-oblivion',
    name: 'Flask of Oblivion',
    description:
      'Flask of Oblivion — waist slot artefact (All negative effects on friendly creatures last for –1 round(s).)',
    url: 'https://www.olden-era.com/en/artefacts/flask_of_oblivion',
    image: 'https://www.olden-era.com/img/artefacts/flask_of_oblivion.webp',
    properties: {
      Slot: 'waist',
      Effect: 'All negative effects on friendly creatures last for –1 round(s).',
      Set: 'anaesthesia',
      Rarity: 'rare',
    },
  },
  {
    id: 'spyglass',
    name: 'Spyglass',
    description: 'Spyglass — items slot artefact (+2 sight radius.)',
    url: 'https://www.olden-era.com/en/artefacts/spyglass',
    image: 'https://www.olden-era.com/img/artefacts/spyglass.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 sight radius.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'warriors-belt',
    name: 'Warrior’s Belt',
    description: 'Warrior’s Belt — waist slot artefact (+2 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/warriors_belt',
    image: 'https://www.olden-era.com/img/artefacts/warriors_belt.webp',
    properties: {
      Slot: 'waist',
      Effect: '+2 Attack.',
      Set: 'warriors_strength',
      Rarity: 'rare',
    },
  },
  {
    id: 'protective-belt',
    name: '守护腰带',
    description: '守护腰带 — waist slot artefact (受到的魔法伤害降低 10%。)',
    url: 'https://www.olden-era.com/en/artefacts/protective_belt',
    image: 'https://www.olden-era.com/img/artefacts/protective_belt.webp',
    properties: {
      Slot: 'waist',
      Effect: '受到的魔法伤害降低 10%。',
      Set: 'dwarven_fortitude',
      Rarity: 'epic',
    },
  },
  {
    id: 'slithering-sash',
    name: 'Slithering Sash',
    description: 'Slithering Sash — waist slot artefact (+3 Spell Power and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/slithering_sash',
    image: 'https://www.olden-era.com/img/artefacts/slithering_sash.webp',
    properties: {
      Slot: 'waist',
      Effect: '+3 Spell Power and Knowledge.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'epic',
    },
  },
  {
    id: 'celestial-sash-of-bliss',
    name: 'Celestial Sash of Bliss',
    description: 'Celestial Sash of Bliss — waist slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/celestial_sash_of_bliss',
    image: 'https://www.olden-era.com/img/artefacts/celestial_sash_of_bliss.webp',
    properties: {
      Slot: 'waist',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'spells-in-bottles',
    name: 'Spells in Bottles',
    description: 'Spells in Bottles — waist slot artefact (Makes all tier‑4 spells available to the hero.)',
    url: 'https://www.olden-era.com/en/artefacts/spells_in_bottles',
    image: 'https://www.olden-era.com/img/artefacts/spells_in_bottles.webp',
    properties: {
      Slot: 'waist',
      Effect: 'Makes all tier‑4 spells available to the hero.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'magic-key-ring',
    name: 'Magic Key Ring',
    description:
      'Magic Key Ring — waist slot artefact (Negates all effects that restrict creature rearrangement, surrendering, fleeing, and using the Spellbook and hero abilities in battle.)',
    url: 'https://www.olden-era.com/en/artefacts/magic_key_ring',
    image: 'https://www.olden-era.com/img/artefacts/magic_key_ring.webp',
    properties: {
      Slot: 'waist',
      Effect:
        'Negates all effects that restrict creature rearrangement, surrendering, fleeing, and using the Spellbook and hero abilities in battle.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'skull-of-milos',
    name: 'Skull of Milos',
    description: 'Skull of Milos — waist slot artefact (+1000 Gold daily.)',
    url: 'https://www.olden-era.com/en/artefacts/skull_of_milos',
    image: 'https://www.olden-era.com/img/artefacts/skull_of_milos.webp',
    properties: {
      Slot: 'waist',
      Effect: '+1000 Gold daily.',
      Set: 'miloss_curse',
      Rarity: 'epic',
    },
  },
  {
    id: 'dragonbone-greaves',
    name: 'Dragonbone Greaves',
    description: 'Dragonbone Greaves — feet slot artefact (+1 Spell Power and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/dragonbone_greaves',
    image: 'https://www.olden-era.com/img/artefacts/dragonbone_greaves.webp',
    properties: {
      Slot: 'feet',
      Effect: '+1 Spell Power and Knowledge.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'common',
    },
  },
  {
    id: 'magic-slippers',
    name: 'Magic Slippers',
    description: 'Magic Slippers — feet slot artefact (Spells cost 2 less mana.)',
    url: 'https://www.olden-era.com/en/artefacts/magic_slippers',
    image: 'https://www.olden-era.com/img/artefacts/magic_slippers.webp',
    properties: {
      Slot: 'feet',
      Effect: 'Spells cost 2 less mana.',
      Set: 'ethereal_knowledge',
      Rarity: 'common',
    },
  },
  {
    id: 'boots-of-travel',
    name: 'Boots of Travel',
    description: 'Boots of Travel — feet slot artefact (+10 Movement points.)',
    url: 'https://www.olden-era.com/en/artefacts/boots_of_travel',
    image: 'https://www.olden-era.com/img/artefacts/boots_of_travel.webp',
    properties: {
      Slot: 'feet',
      Effect: '+10 Movement points.',
      Set: 'wanderers_way',
      Rarity: 'rare',
    },
  },
  {
    id: 'swamp-boots',
    name: 'Swamp Boots',
    description: 'Swamp Boots — feet slot artefact (Eliminates all terrain penalties.)',
    url: 'https://www.olden-era.com/en/artefacts/swamp_boots',
    image: 'https://www.olden-era.com/img/artefacts/swamp_boots.webp',
    properties: {
      Slot: 'feet',
      Effect: 'Eliminates all terrain penalties.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'bone-boots',
    name: 'Bone Boots',
    description: 'Bone Boots — feet slot artefact (+4 Spell Power, then +15% total Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/bone_boots',
    image: 'https://www.olden-era.com/img/artefacts/bone_boots.webp',
    properties: {
      Slot: 'feet',
      Effect: '+4 Spell Power, then +15% total Spell Power.',
      Set: 'shadow_of_death',
      Rarity: 'epic',
    },
  },
  {
    id: 'sandals-of-the-saint',
    name: 'Sandals of the Saint',
    description: 'Sandals of the Saint — feet slot artefact (+2 Attack, Defense, Spell Power, and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/sandals_of_the_saint',
    image: 'https://www.olden-era.com/img/artefacts/sandals_of_the_saint.webp',
    properties: {
      Slot: 'feet',
      Effect: '+2 Attack, Defense, Spell Power, and Knowledge.',
      Set: 'angelic_alliance',
      Rarity: 'legendary',
    },
  },
  {
    id: 'shackles-of-war',
    name: 'Shackles of War',
    description:
      'Shackles of War — items slot artefact (Prevents surrender and flee in battle. (This effects both the wearer and their opponent.))',
    url: 'https://www.olden-era.com/en/artefacts/shackles_of_war',
    image: 'https://www.olden-era.com/img/artefacts/shackles_of_war.webp',
    properties: {
      Slot: 'items',
      Effect: 'Prevents surrender and flee in battle. (This effects both the wearer and their opponent.)',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'legions-leg',
    name: 'Legion’s Leg',
    description: 'Legion’s Leg — feet slot artefact (+50% to all creature growth in all your cities.)',
    url: 'https://www.olden-era.com/en/artefacts/legions_leg',
    image: 'https://www.olden-era.com/img/artefacts/legions_leg.webp',
    properties: {
      Slot: 'feet',
      Effect: '+50% to all creature growth in all your cities.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'seven-league-boots',
    name: 'Seven‑League Boots',
    description: 'Seven‑League Boots — feet slot artefact (+30 Movement points.)',
    url: 'https://www.olden-era.com/en/artefacts/seven_league_boots',
    image: 'https://www.olden-era.com/img/artefacts/seven_league_boots.webp',
    properties: {
      Slot: 'feet',
      Effect: '+30 Movement points.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'warlord-boots',
    name: 'Warlord Boots',
    description: 'Warlord Boots — feet slot artefact (+2 Initiative to friendly creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/warlord_boots',
    image: 'https://www.olden-era.com/img/artefacts/warlord_boots.webp',
    properties: {
      Slot: 'feet',
      Effect: '+2 Initiative to friendly creatures.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'clenching-ring',
    name: 'Clenching Ring',
    description:
      'Clenching Ring — rings slot artefact (Over-time spell effects cast by the hero last +1 round(s) longer.)',
    url: 'https://www.olden-era.com/en/artefacts/clenching_ring',
    image: 'https://www.olden-era.com/img/artefacts/clenching_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: 'Over-time spell effects cast by the hero last +1 round(s) longer.',
      Set: 'shamaniac_soul',
      Rarity: 'common',
    },
  },
  {
    id: 'quiet-eye-of-a-dragon',
    name: 'Quiet Eye of a Dragon',
    description: 'Quiet Eye of a Dragon — rings slot artefact (+1 Attack and Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/quiet_eye_of_a_dragon',
    image: 'https://www.olden-era.com/img/artefacts/quiet_eye_of_a_dragon.webp',
    properties: {
      Slot: 'rings',
      Effect: '+1 Attack and Defense.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'common',
    },
  },
  {
    id: 'wooden-ring',
    name: 'Wooden Ring',
    description: 'Wooden Ring — rings slot artefact (+1 Morale.)',
    url: 'https://www.olden-era.com/en/artefacts/wooden_ring',
    image: 'https://www.olden-era.com/img/artefacts/wooden_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: '+1 Morale.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'emerald-resonance-controller',
    name: 'Emerald Resonance Controller',
    description: 'Emerald Resonance Controller — rings slot artefact (–10% to enemy hero Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/emerald_resonance_controller',
    image: 'https://www.olden-era.com/img/artefacts/emerald_resonance_controller.webp',
    properties: {
      Slot: 'rings',
      Effect: '–10% to enemy hero Spell Power.',
      Set: 'dwarven_fortitude',
      Rarity: 'rare',
    },
  },
  {
    id: 'keepers-ring',
    name: 'Keeper’s Ring',
    description: 'Keeper’s Ring — rings slot artefact (+2 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/keepers_ring',
    image: 'https://www.olden-era.com/img/artefacts/keepers_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: '+2 Defense.',
      Set: 'keepers_fortitude',
      Rarity: 'rare',
    },
  },
  {
    id: 'lords-ring',
    name: 'Lord’s Ring',
    description: 'Lord’s Ring — rings slot artefact (Friendly creatures have +1 Initiative.)',
    url: 'https://www.olden-era.com/en/artefacts/lords_ring',
    image: 'https://www.olden-era.com/img/artefacts/lords_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: 'Friendly creatures have +1 Initiative.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'shard-of-serenity',
    name: 'Shard of Serenity',
    description: 'Shard of Serenity — rings slot artefact (Restores 6 mana to the hero each morning.)',
    url: 'https://www.olden-era.com/en/artefacts/shard_of_serenity',
    image: 'https://www.olden-era.com/img/artefacts/shard_of_serenity.webp',
    properties: {
      Slot: 'rings',
      Effect: 'Restores 6 mana to the hero each morning.',
      Set: 'tranquil_glass',
      Rarity: 'rare',
    },
  },
  {
    id: 'tabar-signet-ring',
    name: 'Tabar Signet‑Ring',
    description: 'Tabar Signet‑Ring — rings slot artefact (+1 Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/tabar_signet_ring',
    image: 'https://www.olden-era.com/img/artefacts/tabar_signet_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: '+1 Luck.',
      Set: 'ukhtabar_signet',
      Rarity: 'rare',
    },
  },
  {
    id: 'chain-link',
    name: 'Chain Link',
    description:
      'Chain Link — rings slot artefact (Forbids the wearer and the enemy hero to cast tier‑1 and 2 spells in combat.)',
    url: 'https://www.olden-era.com/en/artefacts/chain_link',
    image: 'https://www.olden-era.com/img/artefacts/chain_link.webp',
    properties: {
      Slot: 'rings',
      Effect: 'Forbids the wearer and the enemy hero to cast tier‑1 and 2 spells in combat.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'crimson-resonance-controller',
    name: 'Crimson Resonance Controller',
    description: 'Crimson Resonance Controller — rings slot artefact (–20% to enemy hero Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/crimson_resonance_controller',
    image: 'https://www.olden-era.com/img/artefacts/crimson_resonance_controller.webp',
    properties: {
      Slot: 'rings',
      Effect: '–20% to enemy hero Spell Power.',
      Set: 'dwarven_fortitude',
      Rarity: 'epic',
    },
  },
  {
    id: 'ring-of-life',
    name: 'Ring of Life',
    description:
      'Ring of Life — rings slot artefact (All positive effects on friendly creatures last for +1 round(s).)',
    url: 'https://www.olden-era.com/en/artefacts/ring_of_life',
    image: 'https://www.olden-era.com/img/artefacts/ring_of_life.webp',
    properties: {
      Slot: 'rings',
      Effect: 'All positive effects on friendly creatures last for +1 round(s).',
      Set: 'anaesthesia',
      Rarity: 'rare',
    },
  },
  {
    id: 'ring-of-neutrality',
    name: 'Ring of Neutrality',
    description:
      'Ring of Neutrality — rings slot artefact (All creatures always have neutral Morale and Luck in battle.)',
    url: 'https://www.olden-era.com/en/artefacts/ring_of_neutrality',
    image: 'https://www.olden-era.com/img/artefacts/ring_of_neutrality.webp',
    properties: {
      Slot: 'rings',
      Effect: 'All creatures always have neutral Morale and Luck in battle.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'brass-knuckles',
    name: 'Brass Knuckles',
    description: 'Brass Knuckles — rings slot artefact (Friendly creatures take –30% counterattack Damage.)',
    url: 'https://www.olden-era.com/en/artefacts/brass_knuckles',
    image: 'https://www.olden-era.com/img/artefacts/brass_knuckles.webp',
    properties: {
      Slot: 'rings',
      Effect: 'Friendly creatures take –30% counterattack Damage.',
      Set: 'duelists_pride',
      Rarity: 'epic',
    },
  },
  {
    id: 'seal-of-silence',
    name: 'Seal of Silence',
    description: 'Seal of Silence — rings slot artefact (+1 round(s) to the cooldown of all enemy spells.)',
    url: 'https://www.olden-era.com/en/artefacts/seal_of_silence',
    image: 'https://www.olden-era.com/img/artefacts/seal_of_silence.webp',
    properties: {
      Slot: 'rings',
      Effect: '+1 round(s) to the cooldown of all enemy spells.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'sixth-finger',
    name: 'Sixth Finger',
    description: 'Sixth Finger — rings slot artefact (–2 to enemy Morale and Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/sixth_finger',
    image: 'https://www.olden-era.com/img/artefacts/sixth_finger.webp',
    properties: {
      Slot: 'rings',
      Effect: '–2 to enemy Morale and Luck.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'soulcaller-ring',
    name: 'Soulcaller Ring',
    description: 'Soulcaller Ring — rings slot artefact (The enemy loses 1 levels on all Magic School spells.)',
    url: 'https://www.olden-era.com/en/artefacts/soulcaller_ring',
    image: 'https://www.olden-era.com/img/artefacts/soulcaller_ring.webp',
    properties: {
      Slot: 'rings',
      Effect: 'The enemy loses 1 levels on all Magic School spells.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'omencaller',
    name: 'Omencaller',
    description: 'Omencaller — back slot artefact (–1 to enemy Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/omencaller',
    image: 'https://www.olden-era.com/img/artefacts/omencaller.webp',
    properties: {
      Slot: 'back',
      Effect: '–1 to enemy Luck.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'wizards-cloak',
    name: 'Wizard’s Cloak',
    description: 'Wizard’s Cloak — back slot artefact (+2 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/wizards_cloak',
    image: 'https://www.olden-era.com/img/artefacts/wizards_cloak.webp',
    properties: {
      Slot: 'back',
      Effect: '+2 Spell Power.',
      Set: 'wizards_might',
      Rarity: 'rare',
    },
  },
  {
    id: 'automated-antimagic-shield',
    name: 'Automated Antimagic Shield',
    description: 'Automated Antimagic Shield — back slot artefact (–10% Magic Damage taken.)',
    url: 'https://www.olden-era.com/en/artefacts/automated_antimagic_shield',
    image: 'https://www.olden-era.com/img/artefacts/automated_antimagic_shield.webp',
    properties: {
      Slot: 'back',
      Effect: '–10% Magic Damage taken.',
      Set: 'dwarven_fortitude',
      Rarity: 'rare',
    },
  },
  {
    id: 'dragon-wing-tabard',
    name: 'Dragon Wing Tabard',
    description: 'Dragon Wing Tabard — back slot artefact (+2 Spell Power and Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/dragon_wing_tabard',
    image: 'https://www.olden-era.com/img/artefacts/dragon_wing_tabard.webp',
    properties: {
      Slot: 'back',
      Effect: '+2 Spell Power and Knowledge.',
      Set: 'power_of_the_dragon_father',
      Rarity: 'rare',
    },
  },
  {
    id: 'monster-head',
    name: 'Monster Head',
    description: 'Monster Head — back slot artefact (–1 to enemy Morale and Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/monster_head',
    image: 'https://www.olden-era.com/img/artefacts/monster_head.webp',
    properties: {
      Slot: 'back',
      Effect: '–1 to enemy Morale and Luck.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'flag-of-truce',
    name: 'Flag of Truce',
    description: 'Flag of Truce — items slot artefact (The wearer keeps their army whenever they flee from battle.)',
    url: 'https://www.olden-era.com/en/artefacts/flag_of_truce',
    image: 'https://www.olden-era.com/img/artefacts/flag_of_truce.webp',
    properties: {
      Slot: 'items',
      Effect: 'The wearer keeps their army whenever they flee from battle.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'backpack',
    name: 'Backpack',
    description: 'Backpack — back slot artefact (The hero has +10 Movement points.)',
    url: 'https://www.olden-era.com/en/artefacts/backpack',
    image: 'https://www.olden-era.com/img/artefacts/backpack.webp',
    properties: {
      Slot: 'back',
      Effect: 'The hero has +10 Movement points.',
      Set: 'wanderers_way',
      Rarity: 'rare',
    },
  },
  {
    id: 'light-and-shade-cloak',
    name: 'Light‑and‑Shade Cloak',
    description:
      'Light‑and‑Shade Cloak — back slot artefact (Friendly creatures can still use Ranged attacks while adjacent to enemy creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/light_and_shade_cloak',
    image: 'https://www.olden-era.com/img/artefacts/light_and_shade_cloak.webp',
    properties: {
      Slot: 'back',
      Effect: 'Friendly creatures can still use Ranged attacks while adjacent to enemy creatures.',
      Set: 'living_arrows',
      Rarity: 'epic',
    },
  },
  {
    id: 'second-shade',
    name: 'Second Shade',
    description: 'Second Shade — back slot artefact (+4 Knowledge, then +15% total Knowledge.)',
    url: 'https://www.olden-era.com/en/artefacts/second_shade',
    image: 'https://www.olden-era.com/img/artefacts/second_shade.webp',
    properties: {
      Slot: 'back',
      Effect: '+4 Knowledge, then +15% total Knowledge.',
      Set: 'shadow_of_death',
      Rarity: 'epic',
    },
  },
  {
    id: 'ambassadors-sash',
    name: 'Ambassador’s Sash',
    description: 'Ambassador’s Sash — back slot artefact (+10% to Persuasion Power in Diplomacy.)',
    url: 'https://www.olden-era.com/en/artefacts/ambassadors_sash',
    image: 'https://www.olden-era.com/img/artefacts/ambassadors_sash.webp',
    properties: {
      Slot: 'back',
      Effect: '+10% to Persuasion Power in Diplomacy.',
      Set: 'ambassadors_word',
      Rarity: 'legendary',
    },
  },
  {
    id: 'fallen-angel-wings',
    name: 'Fallen Angel Wings',
    description: 'Fallen Angel Wings — back slot artefact (Grants constant flight.)',
    url: 'https://www.olden-era.com/en/artefacts/fallen_angel_wings',
    image: 'https://www.olden-era.com/img/artefacts/fallen_angel_wings.webp',
    properties: {
      Slot: 'back',
      Effect: 'Grants constant flight.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'banner-of-six-winds',
    name: 'Banner of Six Winds',
    description: 'Banner of Six Winds — back slot artefact (+1 Speed to friendly creatures.)',
    url: 'https://www.olden-era.com/en/artefacts/banner_of_six_winds',
    image: 'https://www.olden-era.com/img/artefacts/banner_of_six_winds.webp',
    properties: {
      Slot: 'back',
      Effect: '+1 Speed to friendly creatures.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'magic-scroll',
    name: 'Magic Scroll',
    description: "Magic Scroll — items slot artefact (Adds a specific spell to the hero's spellbook)",
    url: 'https://www.olden-era.com/en/artefacts/magic_scroll',
    image: 'https://www.olden-era.com/img/artefacts/magic_scroll.webp',
    properties: {
      Slot: 'items',
      Effect: "Adds a specific spell to the hero's spellbook",
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'enchanted-magic-scroll',
    name: 'Enchanted Magic Scroll',
    description: "Enchanted Magic Scroll — items slot artefact (Adds a specific level 4 spell to the hero's spellbook)",
    url: 'https://www.olden-era.com/en/artefacts/enchanted_magic_scroll',
    image: 'https://www.olden-era.com/img/artefacts/enchanted_magic_scroll.webp',
    properties: {
      Slot: 'items',
      Effect: "Adds a specific level 4 spell to the hero's spellbook",
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'magic-mirror',
    name: 'Magic Mirror',
    description: 'Magic Mirror — items slot artefact (Restores 4 mana to the hero each morning.)',
    url: 'https://www.olden-era.com/en/artefacts/magic_mirror',
    image: 'https://www.olden-era.com/img/artefacts/magic_mirror.webp',
    properties: {
      Slot: 'items',
      Effect: 'Restores 4 mana to the hero each morning.',
      Set: 'tranquil_glass',
      Rarity: 'common',
    },
  },
  {
    id: 'last-coin',
    name: 'Last Coin',
    description: 'Last Coin — items slot artefact (+1 Luck.)',
    url: 'https://www.olden-era.com/en/artefacts/last_coin',
    image: 'https://www.olden-era.com/img/artefacts/last_coin.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 Luck.',
      Set: 'paupers_glory',
      Rarity: 'common',
    },
  },
  {
    id: 'boreoloths-hand',
    name: 'Boreoloth’s Hand',
    description: 'Boreoloth’s Hand — items slot artefact (+1 Attack.)',
    url: 'https://www.olden-era.com/en/artefacts/boreoloths_hand',
    image: 'https://www.olden-era.com/img/artefacts/boreoloths_hand.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 Attack.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'boreoloths-tail',
    name: 'Boreoloth’s Tail',
    description: 'Boreoloth’s Tail — items slot artefact (+1 Defense.)',
    url: 'https://www.olden-era.com/en/artefacts/boreoloths_tail',
    image: 'https://www.olden-era.com/img/artefacts/boreoloths_tail.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 Defense.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'boreoloths-heart',
    name: 'Boreoloth’s Heart',
    description: 'Boreoloth’s Heart — items slot artefact (+1 Spell Power.)',
    url: 'https://www.olden-era.com/en/artefacts/boreoloths_heart',
    image: 'https://www.olden-era.com/img/artefacts/boreoloths_heart.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 Spell Power.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'boreoloths-head',
    name: 'Голова Бореолоса',
    description: 'Голова Бореолоса — items slot artefact (+1 к знаниям.)',
    url: 'https://www.olden-era.com/en/artefacts/boreoloths_head',
    image: 'https://www.olden-era.com/img/artefacts/boreoloths_head.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 к знаниям.',
      Set: 'no_sets',
      Rarity: 'common',
    },
  },
  {
    id: 'keepers-amulet',
    name: 'Оберег хранителя',
    description: 'Оберег хранителя — items slot artefact (+2 к защите.)',
    url: 'https://www.olden-era.com/en/artefacts/keepers_amulet',
    image: 'https://www.olden-era.com/img/artefacts/keepers_amulet.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 к защите.',
      Set: 'keepers_fortitude',
      Rarity: 'rare',
    },
  },
  {
    id: 'warriors-amulet',
    name: 'Оберег воителя',
    description: 'Оберег воителя — items slot artefact (+2 к атаке.)',
    url: 'https://www.olden-era.com/en/artefacts/warriors_amulet',
    image: 'https://www.olden-era.com/img/artefacts/warriors_amulet.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 к атаке.',
      Set: 'warriors_strength',
      Rarity: 'rare',
    },
  },
  {
    id: 'scholars-amulet',
    name: 'Оберег учёного',
    description: 'Оберег учёного — items slot artefact (+2 к знаниям.)',
    url: 'https://www.olden-era.com/en/artefacts/scholars_amulet',
    image: 'https://www.olden-era.com/img/artefacts/scholars_amulet.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 к знаниям.',
      Set: 'scholars_wisdom',
      Rarity: 'rare',
    },
  },
  {
    id: 'wizards-amulet',
    name: 'Оберег волшебника',
    description: 'Оберег волшебника — items slot artefact (+2 к силе магии.)',
    url: 'https://www.olden-era.com/en/artefacts/wizards_amulet',
    image: 'https://www.olden-era.com/img/artefacts/wizards_amulet.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 к силе магии.',
      Set: 'wizards_might',
      Rarity: 'rare',
    },
  },
  {
    id: 'ukh-signet',
    name: 'Печать «Укх»',
    description: 'Печать «Укх» — items slot artefact (+1 к боевому духу.)',
    url: 'https://www.olden-era.com/en/artefacts/ukh_signet',
    image: 'https://www.olden-era.com/img/artefacts/ukh_signet.webp',
    properties: {
      Slot: 'items',
      Effect: '+1 к боевому духу.',
      Set: 'ukhtabar_signet',
      Rarity: 'rare',
    },
  },
  {
    id: 'lifeblood-fairy',
    name: 'Кровавая фея',
    description: 'Кровавая фея — items slot artefact (+2 к здоровью дружественных существ.)',
    url: 'https://www.olden-era.com/en/artefacts/lifeblood_fairy',
    image: 'https://www.olden-era.com/img/artefacts/lifeblood_fairy.webp',
    properties: {
      Slot: 'items',
      Effect: '+2 к здоровью дружественных существ.',
      Set: 'anaesthesia',
      Rarity: 'legendary',
    },
  },
  {
    id: 'golden-pig',
    name: 'Золотая свинья',
    description: 'Золотая свинья — items slot artefact (Приносит 500 золота в день.)',
    url: 'https://www.olden-era.com/en/artefacts/golden_pig',
    image: 'https://www.olden-era.com/img/artefacts/golden_pig.webp',
    properties: {
      Slot: 'items',
      Effect: 'Приносит 500 золота в день.',
      Set: 'miloss_curse',
      Rarity: 'rare',
    },
  },
  {
    id: 'golden-moth',
    name: 'Золотой мотылёк',
    description: 'Золотой мотылёк — items slot artefact (Приносит 250 золота в день.)',
    url: 'https://www.olden-era.com/en/artefacts/golden_moth',
    image: 'https://www.olden-era.com/img/artefacts/golden_moth.webp',
    properties: {
      Slot: 'items',
      Effect: 'Приносит 250 золота в день.',
      Set: 'miloss_curse',
      Rarity: 'rare',
    },
  },
  {
    id: 'liquid-silence',
    name: 'Молчание в бутылке',
    description:
      'Молчание в бутылке — items slot artefact (Повышает время восстановления всех способностей существ противника на несколько раундов: +1.)',
    url: 'https://www.olden-era.com/en/artefacts/liquid_silence',
    image: 'https://www.olden-era.com/img/artefacts/liquid_silence.webp',
    properties: {
      Slot: 'items',
      Effect: 'Повышает время восстановления всех способностей существ противника на несколько раундов: +1.',
      Set: 'dominion_of_puppeteers',
      Rarity: 'rare',
    },
  },
  {
    id: 'deck-of-spells',
    name: 'Колода заклинаний',
    description: 'Колода заклинаний — items slot artefact (Позволяет герою использовать все заклинания 1‑го ранга.)',
    url: 'https://www.olden-era.com/en/artefacts/deck_of_spells',
    image: 'https://www.olden-era.com/img/artefacts/deck_of_spells.webp',
    properties: {
      Slot: 'items',
      Effect: 'Позволяет герою использовать все заклинания 1‑го ранга.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'runestone-shards',
    name: 'Осколки рун',
    description: 'Осколки рун — items slot artefact (Позволяет герою использовать все заклинания 2‑го ранга.)',
    url: 'https://www.olden-era.com/en/artefacts/runestone_shards',
    image: 'https://www.olden-era.com/img/artefacts/runestone_shards.webp',
    properties: {
      Slot: 'items',
      Effect: 'Позволяет герою использовать все заклинания 2‑го ранга.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'music-sheet',
    name: 'Нотный лист',
    description: 'Нотный лист — items slot artefact (Способности дружественных существ наносят +40% урона.)',
    url: 'https://www.olden-era.com/en/artefacts/music_sheet',
    image: 'https://www.olden-era.com/img/artefacts/music_sheet.webp',
    properties: {
      Slot: 'items',
      Effect: 'Способности дружественных существ наносят +40% урона.',
      Set: 'inner_song',
      Rarity: 'epic',
    },
  },
  {
    id: 'quivering-quiver',
    name: 'Чуткий колчан',
    description: 'Чуткий колчан — items slot artefact (Дружественные существа наносят +10% урона выстрелами.)',
    url: 'https://www.olden-era.com/en/artefacts/quivering_quiver',
    image: 'https://www.olden-era.com/img/artefacts/quivering_quiver.webp',
    properties: {
      Slot: 'items',
      Effect: 'Дружественные существа наносят +10% урона выстрелами.',
      Set: 'living_arrows',
      Rarity: 'epic',
    },
  },
  {
    id: 'drum-of-war',
    name: 'Барабан войны',
    description: 'Барабан войны — items slot artefact (Дружественные существа наносят +1 урона.)',
    url: 'https://www.olden-era.com/en/artefacts/drum_of_war',
    image: 'https://www.olden-era.com/img/artefacts/drum_of_war.webp',
    properties: {
      Slot: 'items',
      Effect: 'Дружественные существа наносят +1 урона.',
      Set: 'knights_honor',
      Rarity: 'epic',
    },
  },
  {
    id: 'ancient-idol',
    name: 'Древний идол',
    description:
      'Древний идол — items slot artefact (Снимает ограничение на повторное использование школы магии в бою.)',
    url: 'https://www.olden-era.com/en/artefacts/ancient_idol',
    image: 'https://www.olden-era.com/img/artefacts/ancient_idol.webp',
    properties: {
      Slot: 'items',
      Effect: 'Снимает ограничение на повторное использование школы магии в бою.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'orb-of-twilight',
    name: 'Сумеречная сфера',
    description:
      'Сумеречная сфера — items slot artefact (+1 к уровню всех известных герою заклинаний ночи. Герой противника получает –1 к уровню всех заклинаний ночи.)',
    url: 'https://www.olden-era.com/en/artefacts/orb_of_twilight',
    image: 'https://www.olden-era.com/img/artefacts/orb_of_twilight.webp',
    properties: {
      Slot: 'items',
      Effect:
        '+1 к уровню всех известных герою заклинаний ночи. Герой противника получает –1 к уровню всех заклинаний ночи.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'orb-of-dawn',
    name: 'Рассветная сфера',
    description:
      'Рассветная сфера — items slot artefact (+1 к уровню всех известных герою заклинаний дня. Герой противника получает –1 к уровню всех заклинаний дня.)',
    url: 'https://www.olden-era.com/en/artefacts/orb_of_dawn',
    image: 'https://www.olden-era.com/img/artefacts/orb_of_dawn.webp',
    properties: {
      Slot: 'items',
      Effect:
        '+1 к уровню всех известных герою заклинаний дня. Герой противника получает –1 к уровню всех заклинаний дня.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'orb-of-eternity',
    name: 'Сфера вечности',
    description:
      'Сфера вечности — items slot artefact (+1 к уровню всех известных герою арканных заклинаний. Герой противника получает –1 к уровню всех арканных заклинаний.)',
    url: 'https://www.olden-era.com/en/artefacts/orb_of_eternity',
    image: 'https://www.olden-era.com/img/artefacts/orb_of_eternity.webp',
    properties: {
      Slot: 'items',
      Effect:
        '+1 к уровню всех известных герою арканных заклинаний. Герой противника получает –1 к уровню всех арканных заклинаний.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'primordial-orb',
    name: 'Первородная сфера',
    description:
      'Первородная сфера — items slot artefact (+1 к уровню всех известных герою первородных заклинаний. Герой противника получает –1 к уровню всех первородных заклинаний.)',
    url: 'https://www.olden-era.com/en/artefacts/primordial_orb',
    image: 'https://www.olden-era.com/img/artefacts/primordial_orb.webp',
    properties: {
      Slot: 'items',
      Effect:
        '+1 к уровню всех известных герою первородных заклинаний. Герой противника получает –1 к уровню всех первородных заклинаний.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'tactical-guide',
    name: 'Руководство по тактике',
    description:
      'Руководство по тактике — items slot artefact (Противник не может расставлять отряды перед началом боя.)',
    url: 'https://www.olden-era.com/en/artefacts/tactical_guide',
    image: 'https://www.olden-era.com/img/artefacts/tactical_guide.webp',
    properties: {
      Slot: 'items',
      Effect: 'Противник не может расставлять отряды перед началом боя.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'voodoo-doll',
    name: 'Кукла вуду',
    description: 'Кукла вуду — items slot artefact (Когда герой проигрывает в бою, его можно снова нанять в таверне.)',
    url: 'https://www.olden-era.com/en/artefacts/voodoo_doll',
    image: 'https://www.olden-era.com/img/artefacts/voodoo_doll.webp',
    properties: {
      Slot: 'items',
      Effect: 'Когда герой проигрывает в бою, его можно снова нанять в таверне.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'mythic-magic-scroll',
    name: 'Mythic Magic Scroll',
    description: 'Mythic Magic Scroll — items slot artefact (Allows the hero a special global spell)',
    url: 'https://www.olden-era.com/en/artefacts/mythic_magic_scroll',
    image: 'https://www.olden-era.com/img/artefacts/mythic_magic_scroll.webp',
    properties: {
      Slot: 'items',
      Effect: 'Allows the hero a special global spell',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'diplomatic-gifts',
    name: 'Diplomatic Gifts',
    description: 'Diplomatic Gifts — items slot artefact (+10% to Persuasion Power in Diplomacy.)',
    url: 'https://www.olden-era.com/en/artefacts/diplomatic_gifts',
    image: 'https://www.olden-era.com/img/artefacts/diplomatic_gifts.webp',
    properties: {
      Slot: 'items',
      Effect: '+10% to Persuasion Power in Diplomacy.',
      Set: 'ambassadors_word',
      Rarity: 'legendary',
    },
  },
  {
    id: 'pole-star',
    name: 'Pole Star',
    description: 'Pole Star — items slot artefact (Global Map spells of the hero cost 0 mana.)',
    url: 'https://www.olden-era.com/en/artefacts/pole_star',
    image: 'https://www.olden-era.com/img/artefacts/pole_star.webp',
    properties: {
      Slot: 'items',
      Effect: 'Global Map spells of the hero cost 0 mana.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'orb-of-destruction',
    name: 'Orb of Destruction',
    description: 'Orb of Destruction — items slot artefact (Heroic Strike deals +10 basic Damage.)',
    url: 'https://www.olden-era.com/en/artefacts/orb_of_destruction',
    image: 'https://www.olden-era.com/img/artefacts/orb_of_destruction.webp',
    properties: {
      Slot: 'items',
      Effect: 'Heroic Strike deals +10 basic Damage.',
      Set: 'no_sets',
      Rarity: 'rare',
    },
  },
  {
    id: 'daylight-tome',
    name: 'Daylight Tome',
    description: 'Daylight Tome — items slot artefact (Allows the hero to cast all Daylight spells.)',
    url: 'https://www.olden-era.com/en/artefacts/daylight_tome',
    image: 'https://www.olden-era.com/img/artefacts/daylight_tome.webp',
    properties: {
      Slot: 'items',
      Effect: 'Allows the hero to cast all Daylight spells.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'nightshade-tome',
    name: 'Nightshade Tome',
    description: 'Nightshade Tome — items slot artefact (Allows the hero to cast all Nightshade spells.)',
    url: 'https://www.olden-era.com/en/artefacts/nightshade_tome',
    image: 'https://www.olden-era.com/img/artefacts/nightshade_tome.webp',
    properties: {
      Slot: 'items',
      Effect: 'Allows the hero to cast all Nightshade spells.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'primal-tome',
    name: 'Primal Tome',
    description: 'Primal Tome — items slot artefact (Allows the hero to cast all Primal spells.)',
    url: 'https://www.olden-era.com/en/artefacts/primal_tome',
    image: 'https://www.olden-era.com/img/artefacts/primal_tome.webp',
    properties: {
      Slot: 'items',
      Effect: 'Allows the hero to cast all Primal spells.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'arcane-tome',
    name: 'Arcane Tome',
    description: 'Arcane Tome — items slot artefact (Allows the hero to cast all Arcane spells.)',
    url: 'https://www.olden-era.com/en/artefacts/arcane_tome',
    image: 'https://www.olden-era.com/img/artefacts/arcane_tome.webp',
    properties: {
      Slot: 'items',
      Effect: 'Allows the hero to cast all Arcane spells.',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'demonic-heart',
    name: 'Demonic Heart',
    description:
      'Demonic Heart — items slot artefact (Replaces all the hero’s spells with their Masterful versions (if they exist).)',
    url: 'https://www.olden-era.com/en/artefacts/demonic_heart',
    image: 'https://www.olden-era.com/img/artefacts/demonic_heart.webp',
    properties: {
      Slot: 'items',
      Effect: 'Replaces all the hero’s spells with their Masterful versions (if they exist).',
      Set: 'no_sets',
      Rarity: 'legendary',
    },
  },
  {
    id: 'orb-of-inhibition',
    name: 'Orb of Inhibition',
    description:
      'Orb of Inhibition — items slot artefact (On the first round of the battle, heroes cannot use their Spellbook or active abilities.)',
    url: 'https://www.olden-era.com/en/artefacts/orb_of_inhibition',
    image: 'https://www.olden-era.com/img/artefacts/orb_of_inhibition.webp',
    properties: {
      Slot: 'items',
      Effect: 'On the first round of the battle, heroes cannot use their Spellbook or active abilities.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'golden-goose-egg',
    name: 'Golden Goose Egg',
    description:
      'Golden Goose Egg — items slot artefact (Grants a random wondrous reward after a random number of upgrades.)',
    url: 'https://www.olden-era.com/en/artefacts/golden_goose_egg',
    image: 'https://www.olden-era.com/img/artefacts/golden_goose_egg.webp',
    properties: {
      Slot: 'items',
      Effect: 'Grants a random wondrous reward after a random number of upgrades.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-roph',
    name: 'Holy Sigil of Roph',
    description:
      'Holy Sigil of Roph — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Ascension, Necromancy, Murmuring, Triumvirate’s Strength, Abyssal Communion, Summon Swarm.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_roph',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_roph.webp',
    properties: {
      Slot: 'relics',
      Effect:
        'While worn, grants all unlearned Subskills of the following Skills: Ascension, Necromancy, Murmuring, Triumvirate’s Strength, Abyssal Communion, Summon Swarm.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-mearea',
    name: 'Holy Sigil of Mearea',
    description:
      'Holy Sigil of Mearea — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Luck, Economy, Daylight Magic.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_mearea',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_mearea.webp',
    properties: {
      Slot: 'relics',
      Effect: 'While worn, grants all unlearned Subskills of the following Skills: Luck, Economy, Daylight Magic.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-insara',
    name: 'Holy Sigil of Insara',
    description:
      'Holy Sigil of Insara — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Leadership, Insight, Diplomacy, Tactics.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_insara',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_insara.webp',
    properties: {
      Slot: 'relics',
      Effect:
        'While worn, grants all unlearned Subskills of the following Skills: Leadership, Insight, Diplomacy, Tactics.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-the-second-man',
    name: 'Holy Sigil of The Second Man',
    description:
      'Holy Sigil of The Second Man — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Offense, Summon Avatar, Siegecraft, Combat.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_the_second_man',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_the_second_man.webp',
    properties: {
      Slot: 'relics',
      Effect:
        'While worn, grants all unlearned Subskills of the following Skills: Offense, Summon Avatar, Siegecraft, Combat.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-the-seven-magi',
    name: 'Holy Sigil of The Seven Magi',
    description:
      'Holy Sigil of The Seven Magi — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Sorcery, Nightshade Magic, Resistance.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_the_seven_magi',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_the_seven_magi.webp',
    properties: {
      Slot: 'relics',
      Effect:
        'While worn, grants all unlearned Subskills of the following Skills: Sorcery, Nightshade Magic, Resistance.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-quix',
    name: 'Holy Sigil of Quix',
    description:
      'Holy Sigil of Quix — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Arcane Magic, Scouting, Battlecraft, Thaumaturgy.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_quix',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_quix.webp',
    properties: {
      Slot: 'relics',
      Effect:
        'While worn, grants all unlearned Subskills of the following Skills: Arcane Magic, Scouting, Battlecraft, Thaumaturgy.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-uurdt',
    name: 'Holy Sigil of Uurdt',
    description:
      'Holy Sigil of Uurdt — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Defense, Primal Magic, Recruitment.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_uurdt',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_uurdt.webp',
    properties: {
      Slot: 'relics',
      Effect: 'While worn, grants all unlearned Subskills of the following Skills: Defense, Primal Magic, Recruitment.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
  {
    id: 'holy-sigil-of-eridore',
    name: 'Holy Sigil of Eridore',
    description:
      'Holy Sigil of Eridore — relics slot artefact (While worn, grants all unlearned Subskills of the following Skills: Logistics, Battle Magic, Wisdom.)',
    url: 'https://www.olden-era.com/en/artefacts/holy_sigil_of_eridore',
    image: 'https://www.olden-era.com/img/artefacts/holy_sigil_of_eridore.webp',
    properties: {
      Slot: 'relics',
      Effect: 'While worn, grants all unlearned Subskills of the following Skills: Logistics, Battle Magic, Wisdom.',
      Set: 'no_sets',
      Rarity: 'epic',
    },
  },
] satisfies EncyclopediaEntry[]

export const buildingEntries = [
  {
    id: 'abyssal-remnant',
    name: 'Abyssal Remnant',
    description: 'Abyssal Remnant — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/abyssal-remnant',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'abyssal-remnant-ii',
    name: 'Abyssal Remnant II',
    description: 'Abyssal Remnant II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/abyssal-remnant-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'abyssal-remnant-iii',
    name: 'Abyssal Remnant III',
    description: 'Abyssal Remnant III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/abyssal-remnant-iii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_main_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'agashoth-stables',
    name: 'Aga’Shoth Stables',
    description: 'Aga’Shoth Stables — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/agashoth-stables',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'agashoth-stables-ii',
    name: 'Aga’Shoth Stables II',
    description: 'Aga’Shoth Stables II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/agashoth-stables-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'alchemic-depot-demon-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-demon-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_resource_depot_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'alchemic-depot-undead-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-undead-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_resource_silo_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'alchemic-depot-nature-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-nature-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_resource_depot_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'alchemic-depot-dungeon-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-dungeon-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_resource_depot_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'alchemic-depot-unfrozen-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-unfrozen-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_resource_depot_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'alchemic-depot-human-build-resource-depot-level-2-l1',
    name: 'Alchemic Depot',
    description: 'Alchemic Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/alchemic-depot-human-build-resource-depot-level-2-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_resource_depot_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'amphitheater',
    name: 'Amphitheater',
    description: 'Amphitheater — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/amphitheater',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'amphitheater-ii',
    name: 'Amphitheater II',
    description: 'Amphitheater II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/amphitheater-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'apex',
    name: 'Apex',
    description: 'Apex — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/apex',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_5_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'apex-ii',
    name: 'Apex II',
    description: 'Apex II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/apex-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'apiarys-heart',
    name: 'Apiary’s Heart',
    description: 'Apiary’s Heart — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/apiarys-heart',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'apiarys-heart-ii',
    name: 'Apiary’s Heart II',
    description: 'Apiary’s Heart II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/apiarys-heart-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'apiarys-heart-iii',
    name: 'Apiary’s Heart III',
    description: 'Apiary’s Heart III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/apiarys-heart-iii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_main_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'artifact-merchant-unfrozen-build-artifact-market-l1',
    name: 'Artifact Merchant',
    description: 'Artifact Merchant — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/artifact-merchant-unfrozen-build-artifact-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_artifact_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'artifact-merchant-human-build-artifact-market-l1',
    name: 'Artifact Merchant',
    description: 'Artifact Merchant — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/artifact-merchant-human-build-artifact-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/human_build_artifact_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'artifact-merchant-nature-build-artifact-market-l1',
    name: 'Artifact Merchant',
    description: 'Artifact Merchant — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/artifact-merchant-nature-build-artifact-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_artifact_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'artifact-merchant-dungeon-build-artifact-market-l1',
    name: 'Artifact Merchant',
    description: 'Artifact Merchant — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/artifact-merchant-dungeon-build-artifact-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_artifact_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'bank-unfrozen-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-unfrozen-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'bank-human-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-human-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'bank-nature-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-nature-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'bank-demon-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-demon-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'bank-undead-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-undead-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'bank-dungeon-build-bank-l1',
    name: 'Bank',
    description: 'Bank — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bank-dungeon-build-bank-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_bank.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'beelzebubs-hand',
    name: 'Beelzebub’s Hand',
    description: 'Beelzebub’s Hand — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/beelzebubs-hand',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/demon_build_beelzebubs_hand_icon.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'bloated-mansion',
    name: 'Bloated Mansion',
    description: 'Bloated Mansion — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bloated-mansion',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'bloated-mansion-ii',
    name: 'Bloated Mansion II',
    description: 'Bloated Mansion II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bloated-mansion-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'blooming-pond',
    name: 'Blooming Pond',
    description: 'Blooming Pond — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/blooming-pond',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'blooming-pond-ii',
    name: 'Blooming Pond II',
    description: 'Blooming Pond II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/blooming-pond-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_4_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'bone-exchange',
    name: 'Bone Exchange',
    description: 'Bone Exchange — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bone-exchange',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'bone-exchange-ii',
    name: 'Bone Exchange II',
    description: 'Bone Exchange II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/bone-exchange-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_4_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'burning-soul-burrows',
    name: 'Burning Soul Burrows',
    description: 'Burning Soul Burrows — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/burning-soul-burrows',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'burning-soul-burrows-ii',
    name: 'Burning Soul Burrows II',
    description: 'Burning Soul Burrows II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/burning-soul-burrows-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'byzantine-palace',
    name: 'Byzantine Palace',
    description: 'Byzantine Palace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/byzantine-palace',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'byzantine-palace-ii',
    name: 'Byzantine Palace II',
    description: 'Byzantine Palace II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/byzantine-palace-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'byzantine-palace-iii',
    name: 'Byzantine Palace III',
    description: 'Byzantine Palace III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/byzantine-palace-iii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_main_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'carrion-lair',
    name: 'Carrion Lair',
    description: 'Carrion Lair — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/carrion-lair',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_2_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'carrion-lair-ii',
    name: 'Carrion Lair II',
    description: 'Carrion Lair II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/carrion-lair-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'cave-palace',
    name: 'Cave Palace',
    description: 'Cave Palace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/cave-palace',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'cave-palace-ii',
    name: 'Cave Palace II',
    description: 'Cave Palace II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/cave-palace-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'chateau-of-feasts',
    name: 'Chateau of Feasts',
    description: 'Chateau of Feasts — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chateau-of-feasts',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'chateau-of-feasts-ii',
    name: 'Chateau of Feasts II',
    description: 'Chateau of Feasts II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chateau-of-feasts-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'chitinous-ziggurat',
    name: 'Chitinous Ziggurat',
    description: 'Chitinous Ziggurat — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chitinous-ziggurat',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'chitinous-ziggurat-ii',
    name: 'Building',
    description: 'Building — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chitinous-ziggurat-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_4_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'chorus-conductor',
    name: 'Chorus Conductor',
    description: 'Chorus Conductor — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chorus-conductor',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_graal.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'chthonic-home',
    name: 'Chthonic Home',
    description: 'Chthonic Home — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chthonic-home',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'chthonic-home-ii',
    name: 'Chthonic Home II',
    description: 'Chthonic Home II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/chthonic-home-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'crypts-and-graves',
    name: 'Crypts and Graves',
    description: 'Crypts and Graves — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/crypts-and-graves',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'crypts-and-graves-ii',
    name: 'Crypts and Graves II',
    description: 'Crypts and Graves II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/crypts-and-graves-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'cultist-spire',
    name: 'Cultist Spire',
    description: 'Cultist Spire — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/cultist-spire',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_2_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'cultist-spire-ii',
    name: 'Cultist Spire II',
    description: 'Cultist Spire II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/cultist-spire-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'disturbing-summoning-rite',
    name: 'Disturbing Summoning Rite',
    description: 'Disturbing Summoning Rite — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/disturbing-summoning-rite',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'disturbing-summoning-rite-ii',
    name: 'Disturbing Summoning Rite II',
    description: 'Disturbing Summoning Rite II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/disturbing-summoning-rite-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_4_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'eerie-summoning-rite',
    name: 'Eerie Summoning Rite',
    description: 'Eerie Summoning Rite — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/eerie-summoning-rite',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'eerie-summoning-rite-ii',
    name: 'Eerie Summoning Rite II',
    description: 'Eerie Summoning Rite II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/eerie-summoning-rite-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'eternal-visage',
    name: 'Eternal Visage',
    description: 'Eternal Visage — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/eternal-visage',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'eternal-visage-ii',
    name: 'Eternal Visage II',
    description: 'Eternal Visage II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/eternal-visage-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'eternal-visage-iii',
    name: 'Eternal Visage III',
    description: 'Eternal Visage III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/eternal-visage-iii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_main_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'everserpent',
    name: 'Everserpent',
    description: 'Everserpent — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/everserpent',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_gaping_maw.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'faun-huts',
    name: 'Faun Huts',
    description: 'Faun Huts — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/faun-huts',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'faun-huts-ii',
    name: 'Faun Huts II',
    description: 'Faun Huts II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/faun-huts-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'firmaments-abyss',
    name: 'Firmament’s Abyss',
    description: 'Firmament’s Abyss — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/firmaments-abyss',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_frigid_firmament.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'fortifications-dungeon-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-dungeon-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'fortifications-undead-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-undead-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'fortifications-unfrozen-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-unfrozen-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'fortifications-nature-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-nature-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/n_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'fortifications-human-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-human-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'fortifications-demon-build-wall-l1',
    name: 'Fortifications',
    description: 'Fortifications — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-demon-build-wall-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_walls_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'fortifications-ii-nature-build-wall-l2',
    name: 'Fortifications II',
    description: 'Fortifications II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-ii-nature-build-wall-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/n_build_walls_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'fortifications-ii-undead-build-wall-l2',
    name: 'Fortifications II',
    description: 'Fortifications II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-ii-undead-build-wall-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_walls_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'fortifications-ii-dungeon-build-wall-l2',
    name: 'Fortifications II',
    description: 'Fortifications II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-ii-dungeon-build-wall-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_walls_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'fortifications-ii-human-build-wall-l2',
    name: 'Fortifications II',
    description: 'Fortifications II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-ii-human-build-wall-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_walls_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'fortifications-ii-demon-build-wall-l2',
    name: 'Fortifications II',
    description: 'Fortifications II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-ii-demon-build-wall-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_walls_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'fortifications-iii-nature-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-nature-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/n_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'fortifications-iii-demon-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-demon-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'fortifications-iii-unfrozen-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-unfrozen-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'fortifications-iii-human-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-human-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'fortifications-iii-dungeon-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-dungeon-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'fortifications-iii-undead-build-wall-l3',
    name: 'Fortifications III',
    description: 'Fortifications III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/fortifications-iii-undead-build-wall-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_walls_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'garrison',
    name: 'Garrison',
    description: 'Garrison — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/garrison',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'garrison-ii',
    name: 'Garrison II',
    description: 'Garrison II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/garrison-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'golden-calf',
    name: 'Golden Calf',
    description: 'Golden Calf — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/golden-calf',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_golden_calf.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'great-library',
    name: 'Great Library',
    description: 'Great Library — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/great-library',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_endless_library.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'griffin-rookery',
    name: 'Griffin Rookery',
    description: 'Griffin Rookery — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/griffin-rookery',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'griffin-rookery-ii',
    name: 'Griffin Rookery II',
    description: 'Griffin Rookery II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/griffin-rookery-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'grove-palace',
    name: 'Grove Palace',
    description: 'Grove Palace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/grove-palace',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'grove-palace-ii',
    name: 'Grove Palace II',
    description: 'Grove Palace II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/grove-palace-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'guild-of-six-winds',
    name: 'Guild of Six Winds',
    description: 'Guild of Six Winds — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/guild-of-six-winds',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_training_range.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'gymnasium',
    name: 'Gymnasium',
    description: 'Gymnasium — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/gymnasium',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_gymnasium.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'hippodrome',
    name: 'Hippodrome',
    description: 'Hippodrome — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/hippodrome',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_5_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'hippodrome-ii',
    name: 'Hippodrome II',
    description: 'Hippodrome II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/hippodrome-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'hop-patch-ii',
    name: 'Hop Patch II',
    description: 'Hop Patch II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/hop-patch-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'house-of-chains',
    name: 'House of Chains',
    description: 'House of Chains — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/house-of-chains',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_5_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'house-of-chains-ii',
    name: 'House of Chains II',
    description: 'House of Chains II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/house-of-chains-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'involuntary-summons',
    name: 'Involuntary Summons',
    description: 'Involuntary Summons — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/involuntary-summons',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_portal_summoning.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'kennel',
    name: 'Kennel',
    description: 'Kennel — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/kennel',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'kennel-ii',
    name: 'Kennel II',
    description: 'Kennel II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/kennel-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'labyrinth',
    name: 'Labyrinth',
    description: 'Labyrinth — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/labyrinth',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'labyrinth-ii',
    name: 'Labyrinth II',
    description: 'Labyrinth II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/labyrinth-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_4_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'lesser-summoning-rite',
    name: 'Lesser Summoning Rite',
    description: 'Lesser Summoning Rite — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/lesser-summoning-rite',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'lesser-summoning-rite-ii',
    name: 'Lesser Summoning Rite II',
    description: 'Lesser Summoning Rite II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/lesser-summoning-rite-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'lyceum',
    name: 'Lyceum',
    description: 'Lyceum — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/lyceum',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_lyceum.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'mage-guild-human-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-human-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_mage_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mage-guild-undead-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-undead-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_mage_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'mage-guild-demon-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-demon-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_mage_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'mage-guild-unfrozen-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-unfrozen-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_mage_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'mage-guild-nature-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-nature-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_magic_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mage-guild-dungeon-build-magic-guild-l1',
    name: 'Mage Guild',
    description: 'Mage Guild — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-dungeon-build-magic-guild-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_mage_guild_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'mage-guild-ii-nature-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-nature-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_magic_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mage-guild-ii-human-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-human-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_mage_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mage-guild-ii-demon-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-demon-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_mage_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'mage-guild-ii-unfrozen-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-unfrozen-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_mage_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'mage-guild-ii-dungeon-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-dungeon-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_mage_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'mage-guild-ii-undead-build-magic-guild-l2',
    name: 'Mage Guild II',
    description: 'Mage Guild II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-ii-undead-build-magic-guild-l2',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_mage_guild_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'mage-guild-iii-undead-build-magic-guild-l3',
    name: 'Mage Guild III',
    description: 'Mage Guild III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iii-undead-build-magic-guild-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_mage_guild_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'mage-guild-iii-demon-build-magic-guild-l3',
    name: 'Mage Guild III',
    description: 'Mage Guild III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iii-demon-build-magic-guild-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_mage_guild_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'mage-guild-iii-unfrozen-build-magic-guild-l3',
    name: 'Mage Guild III',
    description: 'Mage Guild III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iii-unfrozen-build-magic-guild-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_mage_guild_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'mage-guild-iii-nature-build-magic-guild-l3',
    name: 'Mage Guild III',
    description: 'Mage Guild III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iii-nature-build-magic-guild-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_magic_guild_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mage-guild-iii-human-build-magic-guild-l3',
    name: 'Mage Guild III',
    description: 'Mage Guild III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iii-human-build-magic-guild-l3',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_mage_guild_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mage-guild-iv-unfrozen-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-unfrozen-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_mage_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'mage-guild-iv-undead-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-undead-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_mage_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'mage-guild-iv-dungeon-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-dungeon-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_mage_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'mage-guild-iv-demon-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-demon-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_mage_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'mage-guild-iv-human-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-human-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_mage_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mage-guild-iv-nature-build-magic-guild-l4',
    name: 'Mage Guild IV',
    description: 'Mage Guild IV — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-iv-nature-build-magic-guild-l4',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_magic_guild_level_4.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mage-guild-v-dungeon-build-magic-guild-l5',
    name: 'Mage Guild V',
    description: 'Mage Guild V — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-v-dungeon-build-magic-guild-l5',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_mage_guild_level_5.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'mage-guild-v-unfrozen-build-magic-guild-l5',
    name: 'Mage Guild V',
    description: 'Mage Guild V — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-v-unfrozen-build-magic-guild-l5',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_mage_guild_level_5.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'mage-guild-v-nature-build-magic-guild-l5',
    name: 'Mage Guild V',
    description: 'Mage Guild V — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-v-nature-build-magic-guild-l5',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_magic_guild_level_5.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mage-guild-v-demon-build-magic-guild-l5',
    name: 'Mage Guild V',
    description: 'Mage Guild V — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-v-demon-build-magic-guild-l5',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_mage_guild_level_5.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'mage-guild-v-undead-build-magic-guild-l5',
    name: 'Mage Guild V',
    description: 'Mage Guild V — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mage-guild-v-undead-build-magic-guild-l5',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_mage_guild_level_5.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'marketplace-undead-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-undead-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_merchant.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'marketplace-dungeon-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-dungeon-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'marketplace-human-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-human-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_merchant.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'marketplace-demon-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-demon-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'marketplace-unfrozen-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-unfrozen-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_resource_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'marketplace-nature-build-market-l1',
    name: 'Marketplace',
    description: 'Marketplace — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/marketplace-nature-build-market-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_market.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'menhir-circle',
    name: 'Menhir Circle',
    description: 'Menhir Circle — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/menhir-circle',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'menhir-circle-ii',
    name: 'Menhir Circle II',
    description: 'Menhir Circle II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/menhir-circle-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mews',
    name: 'Mews',
    description: 'Mews — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mews',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_2_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mews-ii',
    name: 'Mews II',
    description: 'Mews II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mews-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'mother-nature',
    name: 'Mother Nature',
    description: 'Mother Nature — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mother-nature',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/build_mother_nature_icon.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'mycelium-roots',
    name: 'Mycelium Roots',
    description: 'Mycelium Roots — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/mycelium-roots',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_mycelium_roots.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'neglected-housing',
    name: 'Neglected Housing',
    description: 'Neglected Housing — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/neglected-housing',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'neglected-housing-ii',
    name: 'Neglected Housing II',
    description: 'Neglected Housing II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/neglected-housing-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'paper-nest',
    name: 'Paper Nest',
    description: 'Paper Nest — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/paper-nest',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_3_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'paper-nest-ii',
    name: 'Paper Nest II',
    description: 'Paper Nest II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/paper-nest-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_3_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'pyre',
    name: 'Pyre',
    description: 'Pyre — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/pyre',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'pyre-ii',
    name: 'Building',
    description: 'Building — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/pyre-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'quiet-pavilion',
    name: 'Quiet Pavilion',
    description: 'Quiet Pavilion — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/quiet-pavilion',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_2_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'quiet-pavilion-ii',
    name: 'Quiet Pavilion II',
    description: 'Quiet Pavilion II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/quiet-pavilion-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'radiant-forge',
    name: 'Radiant Forge',
    description: 'Radiant Forge — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/radiant-forge',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'radiant-forge-ii',
    name: 'Radiant Forge II',
    description: 'Radiant Forge II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/radiant-forge-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'resource-depot-unfrozen-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-unfrozen-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_resource_depot.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'resource-depot-nature-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-nature-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_resource_depot.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'resource-depot-demon-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-demon-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_resource_depot.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'resource-depot-dungeon-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-dungeon-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_resource_depot.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'resource-depot-undead-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-undead-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_resource_silo.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'resource-depot-human-build-resource-depot-l1',
    name: 'Resource Depot',
    description: 'Resource Depot — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/resource-depot-human-build-resource-depot-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_resource_depot.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'sacrarium-rediti',
    name: 'Sacrarium Rediti',
    description: 'Sacrarium Rediti — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/sacrarium-rediti',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/demon_build_rebirth_of_shrine_icon.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'safe-house',
    name: 'Safe House',
    description: 'Safe House — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/safe-house',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_2_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'safe-house-ii',
    name: 'Safe House II',
    description: 'Safe House II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/safe-house-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_2_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'scouting-skyship',
    name: 'Scouting Skyship',
    description: 'Scouting Skyship — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/scouting-skyship',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_intelligence_academy.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'shroomwood-shack-ii',
    name: 'Shroomwood Shack II',
    description: 'Shroomwood Shack II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/shroomwood-shack-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'solar-temple',
    name: 'Solar Temple',
    description: 'Solar Temple — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/solar-temple',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_main_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'solar-temple-ii',
    name: 'Solar Temple II',
    description: 'Solar Temple II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/solar-temple-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_main_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'solar-temple-iii',
    name: 'Solar Temple III',
    description: 'Solar Temple III — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/solar-temple-iii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_main_level_3.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'spy-network',
    name: 'Spy Network',
    description: 'Spy Network — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/spy-network',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/dungeon_build_spy_network.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'stilled-voices',
    name: 'Stilled Voices',
    description: 'Stilled Voices — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/stilled-voices',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_5_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'stilled-voices-ii',
    name: 'Stilled Voices II',
    description: 'Stilled Voices II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/stilled-voices-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'sundrop-chapel',
    name: 'Sundrop Chapel',
    description: 'Sundrop Chapel — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/sundrop-chapel',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_4_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'tavern-nature-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-nature-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'tavern-unfrozen-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-unfrozen-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'tavern-dungeon-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-dungeon-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'tavern-undead-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-undead-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'tavern-human-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-human-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'tavern-demon-build-tavern-l1',
    name: 'Tavern',
    description: 'Tavern — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tavern-demon-build-tavern-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tavern.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'threshold-basilica',
    name: 'Threshold Basilica',
    description: 'Threshold Basilica — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/threshold-basilica',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'threshold-basilica-ii',
    name: 'Threshold Basilica II',
    description: 'Threshold Basilica II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/threshold-basilica-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'thunder-lair',
    name: 'Thunder Lair',
    description: 'Thunder Lair — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/thunder-lair',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'thunder-lair-ii',
    name: 'Thunder Lair II',
    description: 'Thunder Lair II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/thunder-lair-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'timeless-mansion',
    name: 'Timeless Mansion',
    description: 'Timeless Mansion — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/timeless-mansion',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_5_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'timeless-mansion-ii',
    name: 'Timeless Mansion II',
    description: 'Timeless Mansion II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/timeless-mansion-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_5_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'tomb-of-warriors',
    name: 'Tomb of Warriors',
    description: 'Tomb of Warriors — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tomb-of-warriors',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_6_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'tomb-of-warriors-ii',
    name: 'Tomb of Warriors II',
    description: 'Tomb of Warriors II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tomb-of-warriors-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_tier_6_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'tower-of-love',
    name: 'Tower of Love',
    description: 'Tower of Love — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tower-of-love',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_7_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'tower-of-love-ii',
    name: 'Tower of Love II',
    description: 'Tower of Love II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/tower-of-love-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_tier_7_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'treasury-nature-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-nature-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/nature/nature_build_treasury.png',
    properties: {
      Kind: 'Building',
      Faction: 'nature',
    },
  },
  {
    id: 'treasury-unfrozen-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-unfrozen-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/unfrozen/u_build_treasury.png',
    properties: {
      Kind: 'Building',
      Faction: 'unfrozen',
    },
  },
  {
    id: 'treasury-human-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-human-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/human/h_build_treasury.png',
    properties: {
      Kind: 'Building',
      Faction: 'human',
    },
  },
  {
    id: 'treasury-dungeon-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-dungeon-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_treasury.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'treasury-demon-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-demon-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/demon/d_build_treasury.png',
    properties: {
      Kind: 'Building',
      Faction: 'demon',
    },
  },
  {
    id: 'treasury-undead-build-treasury-l1',
    name: 'Treasury',
    description: 'Treasury — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/treasury-undead-build-treasury-l1',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_treasure.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'undead-transformer',
    name: 'Undead Transformer',
    description: 'Undead Transformer — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/undead-transformer',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_skeleton_converter.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
  {
    id: 'warren',
    name: 'Warren',
    description: 'Warren — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/warren',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_1_level_1.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'warren-ii',
    name: 'Warren II',
    description: 'Warren II — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/warren-ii',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/dungeon/g_build_tier_1_level_2.png',
    properties: {
      Kind: 'Building',
      Faction: 'dungeon',
    },
  },
  {
    id: 'well-of-souls',
    name: 'Well of Souls',
    description: 'Well of Souls — town building entry with icon, source page, and build-tree grouping.',
    url: 'https://heroes-olden-era.com/en/building/well-of-souls',
    image:
      'https://heroes-olden-era.com/assets/explorer/Russian/building/icons/cities_buildings/undead/n_build_well_of_souls.png',
    properties: {
      Kind: 'Building',
      Faction: 'undead',
    },
  },
] satisfies EncyclopediaEntry[]

export const neutralObjectEntries = [
  {
    id: 'crystal-storage',
    name: 'Crystal Storage',
    description: 'Crystal Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/crystal_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'mercury-storage',
    name: 'Mercury Storage',
    description: 'Mercury Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/mercury_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'gold-storage',
    name: 'Gold Storage',
    description: 'Gold Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/gold_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'ore-storage',
    name: 'Ore Storage',
    description: 'Ore Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/ore_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'wood-storage',
    name: 'Wood Storage',
    description: 'Wood Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/wood_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'gem-storage',
    name: 'Gem Storage',
    description: 'Gem Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/gem_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'alchemical-storage',
    name: 'Alchemical Storage',
    description: 'Alchemical Storage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/alchemical_storage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'gingerbread-house',
    name: 'Gingerbread House',
    description: 'Gingerbread House — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/gingerbread_house',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'trophy-hunters-den',
    name: 'Trophy Hunters Den',
    description: 'Trophy Hunters Den — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/trophy_hunters_den',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'village',
    name: 'Village',
    description: 'Village — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/village',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'crystal-vein',
    name: 'Crystal Vein',
    description: 'Crystal Vein — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/crystal_vein',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'gem-mound',
    name: 'Gem Mound',
    description: 'Gem Mound — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/gem_mound',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'mercury-fissure',
    name: 'Mercury Fissure',
    description: 'Mercury Fissure — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/mercury_fissure',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'gold-mine',
    name: 'Gold Mine',
    description: 'Gold Mine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/gold_mine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'ore-mine',
    name: 'Ore Mine',
    description: 'Ore Mine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/ore_mine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'sawmill',
    name: 'Sawmill',
    description: 'Sawmill — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/sawmill',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'daylight-shrine',
    name: 'Daylight Shrine',
    description: 'Daylight Shrine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/daylight_shrine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'nightshade-shrine',
    name: 'Nightshade Shrine',
    description: 'Nightshade Shrine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/nightshade_shrine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'primal-shrine',
    name: 'Primal Shrine',
    description: 'Primal Shrine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/primal_shrine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'arcane-shrine',
    name: 'Arcane Shrine',
    description: 'Arcane Shrine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/arcane_shrine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'endless-scroll-of-bronze',
    name: 'Endless Scroll Of Bronze',
    description: 'Endless Scroll Of Bronze — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/endless_scroll_of_bronze',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'endless-scroll-of-platinum',
    name: 'Endless Scroll Of Platinum',
    description: 'Endless Scroll Of Platinum — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/endless_scroll_of_platinum',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'endless-scroll-of-silver',
    name: 'Endless Scroll Of Silver',
    description: 'Endless Scroll Of Silver — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/endless_scroll_of_silver',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'endless-scroll-of-gold',
    name: 'Endless Scroll Of Gold',
    description: 'Endless Scroll Of Gold — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/endless_scroll_of_gold',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'knowledge-garden',
    name: 'Knowledge Garden',
    description: 'Knowledge Garden — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/knowledge_garden',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'stinging-sword',
    name: 'Stinging Sword',
    description: 'Stinging Sword — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/stinging_sword',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'summit-automaton',
    name: 'Summit Automaton',
    description: 'Summit Automaton — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/summit_automaton',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'magic-wheel',
    name: 'Magic Wheel',
    description: 'Magic Wheel — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/magic_wheel',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'living-maze',
    name: 'Living Maze',
    description: 'Living Maze — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/living_maze',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'mountain-monastery',
    name: 'Mountain Monastery',
    description: 'Mountain Monastery — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/mountain_monastery',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'pauper-knight-order',
    name: 'Pauper Knight Order',
    description: 'Pauper Knight Order — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/pauper_knight_order',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'scales-of-worth',
    name: 'Scales Of Worth',
    description: 'Scales Of Worth — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/scales_of_worth',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'four-scholars-observatory',
    name: 'Four Scholars Observatory',
    description: 'Four Scholars Observatory — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/four_scholars_observatory',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'learing-stone',
    name: 'Learing Stone',
    description: 'Learing Stone — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/learing_stone',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'lost-library',
    name: 'Lost Library',
    description: 'Lost Library — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/lost_library',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'sacrificial-stone',
    name: 'Sacrificial Stone',
    description: 'Sacrificial Stone — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/sacrificial_stone',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'three-of-knowledge',
    name: 'Three Of Knowledge',
    description: 'Three Of Knowledge — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/three_of_knowledge',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'pile-of-books',
    name: 'Pile Of Books',
    description: 'Pile Of Books — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/pile_of_books',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'forge-of-the-second-man',
    name: 'Forge Of The Second Man',
    description: 'Forge Of The Second Man — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/forge_of_the_second_man',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'the-monty-hall',
    name: 'The Monty Hall',
    description: 'The Monty Hall — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/the_monty_hall',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'tomb-of-a-nameless-hero',
    name: 'Tomb Of A Nameless Hero',
    description: 'Tomb Of A Nameless Hero — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/tomb_of_a_nameless_hero',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'travelling-circus',
    name: 'Travelling Circus',
    description: 'Travelling Circus — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/travelling_circus',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'university',
    name: 'University',
    description: 'University — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/university',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'fountain',
    name: 'Fountain',
    description: 'Fountain — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/fountain',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'four-scholars-shrine',
    name: 'Four Scholars Shrine',
    description: 'Four Scholars Shrine — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/four_scholars_shrine',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'pandora',
    name: 'Pandora',
    description: 'Pandora — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/pandora',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'stables',
    name: 'Stables',
    description: 'Stables — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/stables',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'well',
    name: 'Well',
    description: 'Well — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/well',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'whispering-stone',
    name: 'Whispering Stone',
    description: 'Whispering Stone — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/whispering_stone',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'chimerologyst',
    name: 'Chimerologyst',
    description: 'Chimerologyst — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/chimerologyst',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'arborcopia',
    name: 'Arborcopia',
    description: 'Arborcopia — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/arborcopia',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'mercenary-guild',
    name: 'Mercenary Guild',
    description: 'Mercenary Guild — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/mercenary_guild',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    description: 'Marketplace — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/marketplace',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'alchemical-lab',
    name: 'Alchemical Lab',
    description: 'Alchemical Lab — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/alchemical_lab',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'pit-of-the-glory',
    name: 'Pit Of The Glory',
    description: 'Pit Of The Glory — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/pit_of_the_glory',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'hero-cage',
    name: 'Hero Cage',
    description: 'Hero Cage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/hero_cage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'mirage',
    name: 'Mirage',
    description: 'Mirage — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/mirage',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'remote-foothold',
    name: 'Remote Foothold',
    description: 'Remote Foothold — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/remote_foothold',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'goblin-cache',
    name: 'Goblin Cache',
    description: 'Goblin Cache — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/goblin_cache',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'tavern',
    name: 'Tavern',
    description: 'Tavern — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/tavern',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'beer-fountain',
    name: 'Beer Fountain',
    description: 'Beer Fountain — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/beer_fountain',
    properties: {
      Kind: 'Neutral object',
    },
  },
  {
    id: 'quixs-altar',
    name: 'Quixs Altar',
    description: 'Quixs Altar — neutral object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-neutral/quixs_altar',
    properties: {
      Kind: 'Neutral object',
    },
  },
] satisfies EncyclopediaEntry[]

export const combatObjectEntries = [
  {
    id: 'cursed-old-house',
    name: 'Cursed Old House',
    description: 'Cursed Old House — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/cursed_old_house',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'abnormal-structure',
    name: 'Abnormal Structure',
    description: 'Abnormal Structure — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/abnormal_structure',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'boreal-call',
    name: 'Boreal Call',
    description: 'Boreal Call — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/boreal_call',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'petrified-memorial',
    name: 'Petrified Memorial',
    description: 'Petrified Memorial — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/petrified_memorial',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'iridicent-abbey',
    name: 'Iridicent Abbey',
    description: 'Iridicent Abbey — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/iridicent_abbey',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'overgrown-vori-ruins',
    name: 'Overgrown Vori Ruins',
    description: 'Overgrown Vori Ruins — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/overgrown_vori_ruins',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'dragon-utopia',
    name: 'Dragon Utopia',
    description: 'Dragon Utopia — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/dragon_utopia',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'research-laboratory',
    name: 'Research Laboratory',
    description: 'Research Laboratory — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/research_laboratory',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'black-tower',
    name: 'Black Tower',
    description: 'Black Tower — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/black_tower',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'meareas-altar',
    name: 'Meareas Altar',
    description: 'Meareas Altar — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/meareas_altar',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'carrion-pile',
    name: 'Carrion Pile',
    description: 'Carrion Pile — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/carrion_pile',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'tomb-of-vigilance',
    name: 'Tomb Of Vigilance',
    description: 'Tomb Of Vigilance — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/tomb_of_vigilance',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'legions-memorial',
    name: 'Legions Memorial',
    description: 'Legions Memorial — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/legions_memorial',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'abandoned-mansion',
    name: 'Abandoned Mansion',
    description: 'Abandoned Mansion — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/abandoned_mansion',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'circle-of-life',
    name: 'Circle Of Life',
    description: 'Circle Of Life — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/circle_of_life',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'uncanny-rite',
    name: 'Uncanny Rite',
    description: 'Uncanny Rite — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/uncanny_rite',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'raiders-camp',
    name: 'Raiders Camp',
    description: 'Raiders Camp — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/raiders_camp',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'ritual-pyre',
    name: 'Ritual Pyre',
    description: 'Ritual Pyre — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/ritual_pyre',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'colosseum',
    name: 'Colosseum',
    description: 'Colosseum — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/colosseum',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'alvar-outpost',
    name: 'Alvar Outpost',
    description: 'Alvar Outpost — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/alvar_outpost',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'troglodyte-throne',
    name: 'Troglodyte Throne',
    description: 'Troglodyte Throne — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/troglodyte_throne',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'point-of-balance',
    name: 'Point Of Balance',
    description: 'Point Of Balance — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/point_of_balance',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'prismatic-nest',
    name: 'Prismatic Nest',
    description: 'Prismatic Nest — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/prismatic_nest',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'twilight-bloom',
    name: 'Twilight Bloom',
    description: 'Twilight Bloom — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/twilight_bloom',
    properties: {
      Kind: 'Combat object',
    },
  },
  {
    id: 'ancient-crypt',
    name: 'Ancient Crypt',
    description: 'Ancient Crypt — combat object reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/objects-combat/ancient_crypt',
    properties: {
      Kind: 'Combat object',
    },
  },
] satisfies EncyclopediaEntry[]

export const resourceEntries = [
  {
    id: 'gold',
    name: 'Gold',
    description: 'Gold — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/gold',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'ore',
    name: 'Ore',
    description: 'Ore — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/ore',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'wood',
    name: 'Wood',
    description: 'Wood — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/wood',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'dust',
    name: 'Dust',
    description: 'Dust — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/dust',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'mercury',
    name: 'Mercury',
    description: 'Mercury — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/mercury',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'gems',
    name: 'Gems',
    description: 'Gems — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/gems',
    properties: {
      Kind: 'Resource',
    },
  },
  {
    id: 'crystal',
    name: 'Crystal',
    description: 'Crystal — resource reference entry from the public community database.',
    url: 'https://www.olden-era.com/en/resources/crystal',
    properties: {
      Kind: 'Resource',
    },
  },
] satisfies EncyclopediaEntry[]
