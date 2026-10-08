# Desktop Geist fonts

Geist Sans and Geist Mono variable webfonts are bundled from the official `geist@1.7.2` package.
The desktop loads them through `next/font/local` and serves them from the same origin.
Code uses Geist Mono first. For symbols it does not contain, such as `✓`, the existing JetBrains Mono
webfont supplies the same 600/1000 em character advance. Its fallback face is restricted to U+2000–2BFF;
ordinary interface text and code characters use Geist.

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
