# Desktop Geist fonts

Geist Sans and Geist Mono variable webfonts are bundled from the official `geist@1.7.2` package.
The desktop loads them through `next/font/local` and serves them from the same origin.
Code uses Geist Mono first. For symbols it does not contain, such as `✓`, the existing JetBrains Mono
webfont supplies the same 600/1000 em character advance. Its fallback face is restricted to U+2000–2BFF;
ordinary interface text and code characters use Geist.

The terminal adds Symbols Nerd Font Mono from Nerd Fonts v3.5.1 for private-use icons, including AstroNvim's
file, folder, language, and status glyphs. Its 2048/2048 em advance is scaled to 60% to match Geist Mono's
600/1000 em cells. The terminal loads ASCII and both private-use ranges without delaying its connection. When the fonts
arrive, it clears xterm's glyph atlas, fits the cells, and redraws existing output. The symbols do not change interface
or ordinary code typography.

The font is converted without subsetting from the upstream TTF with FontTools 4.60.1 and Brotli:

```python
from fontTools.ttLib import TTFont
font = TTFont('SymbolsNerdFontMono-Regular.ttf')
font.flavor = 'woff2'
font.save('SymbolsNerdFontMono-Regular.woff2')
```

- [Nerd Fonts v3.5.1 symbols archive](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz).
- [Upstream icon sets and licenses](NerdFontsSymbols.README.md) and [MIT license](NerdFontsSymbols.LICENSE) from the symbols archive.
- Source TTF SHA-256: `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749`.
- `SymbolsNerdFontMono-Regular.woff2` SHA-256: `dd1df4b5fdc5760cd0e9020422bc7f3c0e8230784537bd8422e3dc97a71ed586`.

- [Vercel font guidance](https://vercel.com/font)
- [Geist source](https://github.com/vercel/geist-font/tree/main/packages/next)
- [SIL Open Font License](OFL.txt), copied unchanged from the package.
- [JetBrains Mono v2.304](https://github.com/JetBrains/JetBrainsMono/blob/v2.304/fonts/webfonts/JetBrainsMono-Regular.woff2)
  and its [SIL Open Font License](JetBrainsMono.OFL.txt).

| File                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| GeistSans.woff2             | `a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8` |
| GeistMono.woff2             | `fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab` |
| JetBrainsMono-Regular.woff2 | `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2` |
