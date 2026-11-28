# Original v39 execution evidence

These seven synthetic fixtures were captured from unchanged production constructors and the strict original
execution decoder at `3975040a9cc70d62397a8bb0d139410e14c67593`. Relative imports were resolved directly from that
Git tree, bundled with the pinned Bayn dependencies, and executed under production Nix Node 24.11.1
(shared zlib 1.3.1). They contain no live account data.

`index.json` records the source revision, runtime, exact protocol/model identity, decompressed byte lengths,
canonical JSON digests and document content hashes. Gzip is deterministic. Do not regenerate these identities
from a successor implementation. The production runtime test replays all seven documents through the retained
financial decoder and public performance projection, rejects current execution admission and rehashed tampering,
and checks that planned execution evidence is retained. The v38 fixtures remain unchanged.
