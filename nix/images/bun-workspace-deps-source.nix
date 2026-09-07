{
  lib,
  repoRoot,
}:

let
  fileset = lib.fileset.unions [
    (lib.fileset.difference (lib.fileset.fileFilter (
      file: file.type == "regular" && file.name == "package.json"
    ) repoRoot) (lib.fileset.maybeMissing (repoRoot + "/.github/actions/tengri-acceptance")))
    (repoRoot + "/bun.lock")
    (lib.fileset.maybeMissing (repoRoot + "/bunfig.toml"))
    (lib.fileset.maybeMissing (repoRoot + "/.npmrc"))
    (lib.fileset.maybeMissing (repoRoot + "/patches"))
  ];
in
lib.fileset.toSource {
  root = repoRoot;
  inherit fileset;
}
