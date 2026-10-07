# Tengri browser and computer use

Chrome opens a persistent, headed Chromium browser in the owner's MicroVM. The separate Tengri application owns
Codex chat. Closing Chrome disconnects its preview and revokes the view grant. The browser process, cookies,
local storage, profile, and downloaded files remain in the guest until the guest stops. The profile and downloaded
files survive sleep and resume on the retained workspace.

## Research

The public product documentation establishes a shared computer experience. It does not identify the private
protocol or encoder used to stream the preview.

| Product     | Documented browser and preview behavior                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Dots | Each Dot has its own cloud computer. The profile opens a computer preview which the user can view and operate. Sensitive steps can hand control to the user. [OpenAI documentation](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).                                                                                          |
| Grok Bot    | Bots share an account's persistent computer, files, cookies, and credentials. Each Bot has a separate screen, with one computer task at a time on that screen. Agent Computer shows live browser input and supports human takeover. The screens are not security isolation boundaries. [xAI documentation](https://docs.x.ai/grok-bot/computer-and-apps). |
| Meta Muse   | The agent has a persistent, isolated Linux environment and a full browser shared with the user. The user can intervene while work continues. [Meta documentation](https://ai.meta.com/muse/).                                                                                                                                                             |

Tengri uses this shared browser pattern with its existing owner MicroVM. TigerVNC and noVNC are Tengri's transport
choice. The public sources above do not establish that those products use VNC, WebRTC, or CDP.

## Browser display and identity

`IssueBrowserSession` checks the authenticated owner, opens the guest browser through `OpenBrowser`, and issues an
owner-bound preview grant for the reserved browser port `13339`. Generic workspace previews cannot select that
port. The grant bootstraps a cookie on its isolated preview origin. Chrome renders noVNC in an iframe on that origin.

Nanoagent forwards authenticated preview WebSocket traffic to TigerVNC's private Unix socket. TigerVNC exposes no
TCP listener. Its socket has mode `0600`, and the X display requires the guest's Xauthority cookie. The gateway
retains its origin checks, owner authorization, grant revocation, and SPIFFE mutual TLS to Nanoagent. The browser
preview does not contain control-plane credentials.

Sites load inside Chromium. Their framing restrictions do not prevent normal browser navigation. Chromium owns
its native tabs, history, address bar, cookies, JavaScript, forms, and downloads. Its process keeps the user namespace
sandbox enabled. The display uses X11 at `:91`, resizes to the preview, and streams through
[noVNC's RFB client](https://novnc.com/noVNC/docs/API.html). Mac Command shortcuts delivered to the preview map to
Chromium's Linux Control shortcuts. The outer browser can reserve shortcuts such as Command-L; click the remote
address bar to navigate. Text paste uses the browser's clipboard permission, and received text has an explicit copy
control. The display does not forward audio.

## Persistent installation

The guest image includes a checksummed noVNC `1.7.0` client and bootstrap scripts. Playwright Core `1.59.1` selects
the Chromium build. The first launch installs the engine under `~/.tengri/browser` from Microsoft's browser download
service. `browser-runtime-manifest.py` records exact Ubuntu graphics package URLs and SHA-256 hashes during the
image build. The guest verifies those hashes before extracting packages into a private directory on the retained
home. The graphics runtime has scoped library, font, and keyboard paths. The `xkbcomp` wrapper handles TigerVNC's
compiled absolute executable path.

This arrangement preserves the existing 512 MiB root filesystem and its enforced headroom. The image build
validates the engine and extracted runtime through `browser-smoke`. A cold start requires network access to the
pinned Ubuntu packages and Chromium download service. Startup failures remain visible and retryable.
Downloads use the owner's `Downloads` folder. Closing the desktop view does not erase the profile.

## Agent computer tool

Nanoagent registers `nanoagent browser-mcp` as a required server with each Codex app-server process. The 300-second
tool timeout covers a cold browser installation. These settings use [Codex's documented MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
The stdio MCP server exposes one
`computer` tool with `screenshot`, `click`, `double_click`, `drag`, `scroll`, `key`, `type`, `navigate`, and `status`
actions. Each successful input action returns a screenshot and its dimensions. Coordinates include the native
browser toolbar. Input validation rejects missing coordinates, invalid buttons, unsupported key syntax, and
navigation URLs outside HTTP and HTTPS.

The MCP process reaches only the current guest's `~/.tengri/browser/control.sock`, with mode `0600`. It has no
control-plane connection or credentials. Actions serialize on the shared display. **Take control** pauses both
agent input and screenshots, including after guest restart. **Let agent use browser** returns control. The status
action remains available while the user has control.

Takeover is enforced by this computer tool. The agent already has shell access to its own guest, so takeover is
not an operating system isolation boundary against that shell. MCP instructions tell the agent to respect takeover,
treat page contents as untrusted, and hand passwords, MFA, CAPTCHAs, and consequential actions to the user.
Existing Codex approval settings remain in effect.

## Acceptance boundary

`test-vscode-browser.sh` starts the real Nanoagent, Rust preview gateway, and desktop. On Linux, the Chromium suite
uses the native remote display and the production stdio MCP socket. Its test website denies framing and reports
JavaScript form input. The suite verifies manual navigation, text clipboard, agent screenshots and mouse input, native tabs and history, cookies,
local storage, workspace downloads, takeover, grant revocation, and reopening the same browser.

The guest image independently validates its extracted graphics runtime and 512 MiB filesystem. The requested
production rollout still requires the selected Kargo Freight, exact deployed images, a refreshed retained guest,
and actual browser and agent interaction on `proompteng.ai`.

CI runs the guest fixture in a disposable Docker container. ARC's Talos host disables user namespaces, so the fixture
installs Chromium's root-owned setuid sandbox and gives that container `SYS_ADMIN` for its PID and network namespaces.
Chromium's sandbox remains enabled. The production MicroVM uses user namespaces and does not receive this test
configuration. Browser and editor startup logs are copied out before the fixture container is removed.
