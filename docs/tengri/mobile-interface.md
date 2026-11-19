# Stable Tengri mobile interface

The mobile chat uses the same components and operations as the desktop. Phone windows fill the available application
area, editing controls use 16 CSS px, and each chat has a direct archive/restore icon. Pointer users reveal the icon
on row hover or keyboard focus; touch users receive a persistent 44 by 44 CSS px target.
Touch surfaces keep this full-window layout in landscape. Mobile viewport changes do not overwrite stored desktop
window bounds; returning to desktop restores those bounds. Window actions share the last desktop viewport, while
mobile CSS owns the visible frame. Mobile minimize/restore fades instead of applying a desktop-geometry transform.
Transient zero-sized visual viewport measurements are ignored until the browser reports a visible area again.

## Browser evidence

- The on-screen keyboard can shrink the visual viewport without resizing the layout viewport. Fixed elements and
  viewport-sized pages can otherwise remain behind the keyboard. Use the actual visible geometry, rather than
  assuming `100dvh` describes keyboard clearance.
  [Chrome viewport behavior](https://developer.chrome.com/blog/viewport-resize-behavior),
  [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).
- The visible viewport has both a height and an offset from the layout viewport. Its `resize` and `scroll` events
  describe keyboard changes and panning. Tengri updates the mobile surface from those measurements, coalesces changes
  into one animation frame, and changes window geometry only when dimensions change. Dock clearance shrinks
  continuously as the visible area shrinks, avoiding a keyboard-threshold layout jump. Native pinch zoom is retained;
  the application does not follow viewport geometry while `scale` differs from one.
  [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).
- Focus scrolls by default. Composer focus requests use `preventScroll`. Touch window activation and existing-chat
  selection keep focus out of text editing; tapping New chat or the composer still enters editing explicitly.
  [MDN focus](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus).
- WebKit's iOS focused-element zoom calculation uses a standard 16px font size divided by the control font size.
  Tengri therefore gives text-entry controls a consistent 16px mobile editing size. This is a product constraint,
  not a promise that every browser version has identical keyboard behavior.
  [WebKit iOS source](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm).
- Keep browser zoom available. Do not hide focus zoom by setting `user-scalable=no` or a restrictive maximum scale.
  [W3C viewport zoom rule](https://www.w3.org/WAI/standards-guidelines/act/rules/b4f0c3/).
- Large touch targets can surround a visually small icon. The archive control uses a 44px target on coarse pointers,
  following the enhanced target-size guidance.
  [W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced).
- Safe area defaults already inset Safari content. Do not add `viewport-fit=cover` without accounting for the device
  safe areas, or duplicate safe-area padding when the browser already owns it.
  [WebKit safe areas](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).

## Acceptance checks

Exercise phone widths 320, 390 and 430px with touch input. Verify text-entry size, retained drafts, no horizontal
page overflow, an accessible direct archive icon, and no composer focus merely from reading another chat. Exercise
visual viewport height and offset changes through keyboard open/close and verify composer bounds, unchanged document
scroll and preservation of the reader's position. Keep existing transcript follow behavior only while the reader is
at the end. Exercise zero-sized viewport events, portrait/landscape rotation and a desktop/phone/desktop round trip.
Desktop pointer and keyboard interactions must continue to work.

Playwright exercises browser rendering and emulates VisualViewport events because a headless browser cannot display
a physical phone's operating-system keyboard. Those tests establish the layout and event contract; they do not prove
all native iOS keyboard animations. Record a real-device observation separately when one is available.
