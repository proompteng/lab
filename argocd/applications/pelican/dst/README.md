# Don't Starve Together

One Pelican server supervises the forest (`Master`) and caves (`Caves`) in the same
Docker container on the existing Wings VM. The game uses 4 GiB RAM, up to four CPUs,
12 GiB server storage, no swap, and the two existing UDP allocations 10999/11000.
Defaults: two players, Survival, PvP off, pause while empty, autosave, no mods.
Gameplay remains private to the tailnet at `pelican-games.ide-newton.ts.net`.

## Provision

After the reviewed commit passes CI, copy this directory into the Panel pod's `/tmp/dst`
and run `php /tmp/dst/provision.php` from `/var/www/html`. Remove `/tmp/dst` afterward.
The helper imports its Egg and creates `external_id=galactic-dst` through Pelican's
native services. A repeated invocation returns the existing server without reinstalling,
changing credentials, starting processes or overwriting saves. Inspect an uncertain
installation outcome in Pelican before retrying or using Reinstall.

This is application-data provisioning, not a Kubernetes release. Pelican owns the server
record, Wings owns its container, and Argo CD continues owning the existing platform.
No host configuration, public exposure, additional PVC or Kubernetes workload is required.

Runtime and installer images are digest-pinned. SteamCMD anonymously installs public
branch app 343050 and validates the files. The launcher is embedded from reviewed source.
Configuration files are created only when absent; a reinstall preserves worlds, passwords
and tokens. Steam updates can be requested with Pelican's `AUTO_UPDATE` startup setting;
it defaults to `0` so restarting does not implicitly change the installed build.

The upstream reference was `pelican-eggs/games-steamcmd` commit
`0547150ac32eceac7a1aefb2353aae36b5d2f321`, `dont_starve/egg-don-t-starve-together.json`.
That template downloads GitHub HTML `blob` URLs as configuration. This installation
instead creates explicit INI/Lua files, uses distinct Steam ports for both shards,
keeps shard traffic on loopback, and shuts down both shards when either exits.

## Activate online play

Generate a server token from the owning Klei account:
<https://accounts.klei.com/account/game/servers?game=DontStarveTogether>.
In Pelican's file manager, create/upload this file containing only that token:

```text
DoNotStarveTogether/config/server/cluster_token.txt
```

Keep the token out of Git, terminal output and chat. The initial install stays stopped
until activation. An attempted online start without the file exits with a clear error;
there is no automatic fallback to offline authentication.

The generated game password is the `cluster_password` value in the adjacent `cluster.ini`.
Retrieve it privately in the file manager. Start the server, then connect while Tailscale
is active, using DST's console with the resolved tailnet IPv4 address:

```lua
c_connect("<pelican-games tailnet IPv4>", 10999, "<cluster_password>")
```

Changing world generation after a world exists does not regenerate its saves. Preserve
the world unless an explicit reset is requested. Both shards and their configuration live
inside the server's persistent Wings volume on the existing Ceph-backed VM disk.
Three manual Pelican backup slots are allowed; scheduled/off-cluster backups remain a
separate task. Ceph replication is not a backup.

## Validate

```sh
bash -n argocd/applications/pelican/dst/{install,start}.sh
python3 -m unittest discover -s argocd/applications/pelican/dst -p 'test_*.py'
php -l argocd/applications/pelican/dst/provision.php
```

An offline smoke world must use a separate cluster directory, explicitly set
`offline_cluster=true`, and leave the real `server` cluster and its online setting unchanged.
Verify both shards generate, connect to one another, and save on shutdown. Such a test
does not establish online Klei authentication or a real player's end-to-end connectivity.
