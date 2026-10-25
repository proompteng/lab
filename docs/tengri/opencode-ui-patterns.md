# OpenCode patterns applied to Tengri

Source review dated 2026-10-24. The reference checkout is `anomalyco/opencode` at
`dbd99a940b8d92b403a77a0ce169e9a6861ba073`, cloned into `~/github.com/opencode`.
This comparison describes that revision's implementation. It does not establish the state of a deployed release.

## Execution state owns activity

OpenCode updates a session's shared activity state on execution start, success, failure, and interruption. The session
model and composer read that same state. Message streaming and message completion have their own timestamps;
receiving final text alone does not establish that execution ended.
See the [event reducer](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/client/src/solid/data.ts#L1059),
[session model](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/session/model.ts#L59),
and [composer adapter](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/session/composer/adapter.ts#L30).

Tengri had two competing clocks. Native completion cleared the active turn, but an older Restate status still kept
Thinking and Stop visible. Native completion now retires activity for that exact turn. The persisted user-message
client ID ties a run or pending send to its native turn even before its acknowledgement arrives. Recovered terminal
history retires the same turn, including one started while that history was loading. A stale poll cannot revive it.
For a known run, completion also refreshes the durable receipt immediately rather than waiting for the next polling
timer. Restate retains authority over admission and finalization. Cancellation continues to show Stopping until
command cleanup is confirmed.

## Drafts survive asynchronous work

OpenCode captures the submitted draft separately from the live composer. Session creation carries a temporary
composer that can transfer newer input to the created session or roll it back on failure. Focus restoration checks
which draft and route still own the editor.
See [submission handling](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/composer/submit.ts#L130),
[session creation handoff](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/shell/tabs/tabs.tsx#L325),
and the [preparing composer](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/session/preparing-composer.tsx#L27).

Tengri keeps its submitted prompt separate from the next text and image draft. Late creation, send, and failure
responses cannot replace the selected session or erase newer input. Archiving the selected session uses that same
draft ownership. It waits for any image read to finish before changing selection; restoring and selecting the session
restores its unsent draft. Submission does not disable the session list.

## Session metadata belongs to the server

OpenCode's home index filters archived sessions using native metadata and paginates history. Its archive helper
removes a row and notifies tabs only after the write succeeds. However, this revision's home controller explicitly
rejects archive requests because its V2 client lacks that API. A visible control is not proof of working behavior.
See the [index](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/home/sessions/index.ts#L52),
[archive helper](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/home/sessions/archive.ts#L7),
and [current API limitation](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/home/sessions/controller.tsx#L361).

Tengri removes its browser-only registry and reads native `thread/list` pages. Native names and previews provide
titles. Archive and Restore call the pinned Codex APIs through classified, authenticated controller operations.
Active turns and unfinished durable runs block archiving that session. A failed response retains the visible row;
Retry reads the index without resending the write. The sidebar has a New chat control and an Archived chats view,
without the redundant Conversations heading. Rows, paging, retry, and archive state have one owner in
`AgentSessionList`.

## Resource state has a scope and a kind

OpenCode stores tabs per window. Its file tree uses server-provided node types, deduplicates directory requests,
and discards a reply after its workspace scope changes.
See [tab persistence](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/shell/tabs/tabs.tsx#L77)
and the [file tree](https://github.com/anomalyco/opencode/blob/dbd99a940b8d92b403a77a0ce169e9a6861ba073/packages/app/src/workspaces/files/tree-store.ts#L39).

Tengri keeps window tabs separate from workspace pins. A resource link uses a direct filesystem metadata lookup before
choosing a directory listing, image, or text preview. It does not enumerate siblings, so a readable file in a directory
larger than the listing limit still opens. A folder named `empty.md` remains a folder. Directory views support
children, parent navigation, refresh, empty folders, and reload through pins. Workspace-root and trailing-slash links
normalize to canonical paths. Inactive tabs remain unfetched, and abandoned requests are cancelled.

## Verification boundaries

Browser regressions cover delayed durable finalization, recovered completed/failed/interrupted turns, unrelated turn
completion, navigation during submission, archive/restore at desktop and mobile widths, retained drafts, a separate
browser context, pagination, write failures, lost archive confirmations, and directory resources. A real signed guest
RPC test keeps the 10,000-entry listing limit while reading metadata and file bytes independently; hidden paths and
escaping symlinks remain rejected. The pinned Codex
contract test exercises actual native archive/list/restore behavior and verifies retained history. It also checks that
archiving an active native turn is rejected. Release and authenticated live evidence remain part of the
[durable execution plan](durable-agent-execution-plan.md).
