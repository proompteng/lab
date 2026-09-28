{
  lib,
  repoRoot,
}:

let
  fileset = lib.fileset.unions [
    (lib.fileset.fileFilter (file: file.type == "regular" && file.name == "package.json") repoRoot)
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
