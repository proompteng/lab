# Desktop app icons

Downloaded application artwork used by the Tengri Dock and Settings view. The PNG files are bundled with the app;
Next.js serves appropriately sized images from the same origin. Preserve the artwork's transparency, proportions,
and embedded shadows instead of drawing replacement shapes.

| File           | Source                                                                                                                | Original artwork / source notes                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finder.png`   | [Wikimedia Commons: Finder Icon macOS Big Sur](https://commons.wikimedia.org/wiki/File:Finder_Icon_macOS_Big_Sur.png) | Apple Inc.; Commons identifies the source as macOS system files and marks the image public domain as a simple work.                                                               |
| `chrome.png`   | [Google Chrome macOS download](https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg)               | Google LLC; extracted the 256-pixel `icon_128x128@2x.png` representation from `Contents/Resources/app.icns` in Chrome 152.0.7977.83 using macOS `iconutil`.                       |
| `code.png`     | [Microsoft VS Code app icon](https://code.visualstudio.com/assets/branding/app-icon.png)                              | Microsoft Corporation; downloaded the 188-pixel macOS app artwork from the [VS Code branding page](https://code.visualstudio.com/brand).                                          |
| `terminal.png` | [Wikimedia Commons: Terminalicon2](https://commons.wikimedia.org/wiki/File:Terminalicon2.png)                         | Commons describes the Big Sur revision as taken from the application contents and marks the image public domain as simple geometry; its older author field also says “Self-made.” |
| `settings.png` | [Wikimedia Commons: Settings (iOS)](<https://commons.wikimedia.org/wiki/File:Settings_(iOS).png>)                     | Apple Inc.; despite the historical filename, the page identifies this as the macOS Big Sur Settings artwork and marks it public domain as simple geometry.                        |

The Finder, Terminal, and Settings downloads retain their original 1,024-pixel PNGs. All files were retrieved on
2026-09-06. Brand names and artwork remain associated with their respective owners; the repository license does not
relicense third-party marks.

Finder uses `folder.png` from the [eth-p/mac-icons Big Sur folder template](https://github.com/eth-p/mac-icons/tree/master/Create/Templates/BigSur_Folder.iconset),
downloaded as its unmodified 256-pixel PNG representation. The upstream MIT notice is retained in
[`mac-icons-LICENSE.md`](mac-icons-LICENSE.md). `document.png` is the unmodified 256-pixel representation of Apple's
`GenericDocumentIcon.icns`, extracted with `iconutil` from macOS 26.5.2's
`/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/` on the reference host. These two assets were
retrieved on 2026-09-07; the repository license does not relicense Apple's artwork.

The menu bar, startup header, and lifecycle transition header use Pictogrammers' existing
[`fruit-pear` icon](https://pictogrammers.com/library/mdi/icon/fruit-pear/). `fruit-pear.svg` is the unmodified asset from
[`Templarian/MaterialDesign-SVG` at `9e04201d4557e729822fb57f62a316c3dea1d4a8`](https://github.com/Templarian/MaterialDesign-SVG/blob/9e04201d4557e729822fb57f62a316c3dea1d4a8/svg/fruit-pear.svg),
retrieved on 2026-09-08. CSS displays it in white without changing its geometry. The upstream notice is retained in
[`pictogrammers-LICENSE.txt`](pictogrammers-LICENSE.txt), with the full icon license in [`Apache-2.0.txt`](Apache-2.0.txt).
