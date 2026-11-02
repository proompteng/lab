local editor = "/opt/tengri/editor"
local building = vim.env.TENGRI_EDITOR_BUILD == "1"
vim.opt.rtp:prepend(editor .. "/plugins/lazy.nvim")
local plugins = building and {} or dofile(editor .. "/plugins.lua")

table.insert(plugins, {
  "AstroNvim/AstroNvim",
  version = "v6.1.0",
  commit = "aa0545fc8357009fc8a67e6cd93e7f8544e3aba9",
  import = "astronvim.plugins",
  opts = {
    mapleader = " ",
    maplocalleader = ",",
    icons_enabled = true,
  },
})
table.insert(plugins, {
  "AstroNvim/astrocore",
  opts = function(_, opts)
    opts.treesitter.auto_install = false
    opts.treesitter.ensure_installed = {}
  end,
})
require("lazy").setup(plugins, {
  root = building and editor .. "/plugins" or nil,
  lockfile = building and editor .. "/lazy-lock.json" or nil,
  install = { missing = building, colorscheme = { "astrotheme", "habamax" } },
  ui = { backdrop = 100 },
  performance = { rtp = { paths = { editor .. "/site" } } },
})
