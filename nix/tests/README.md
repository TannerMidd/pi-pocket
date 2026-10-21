# Installed-runtime tests

`nix build` runs the existing source checks and then `installed.mjs` against the
installed package, after development dependencies have been pruned. It starts the
wrapped executable outside the checkout, with an isolated home and no inherited
build tools or provider credentials. It checks HTTP assets, dependency resolution,
owner activation, automatic hot reload, and persistence of extension files,
enabled choices and a database session across restarts. No model calls
are needed.

The package preserves owner-created extensions and live edits. The NixOS module
also preserves owner additions across service starts and configuration changes.
It records declared filenames in `extensions/.nix-managed-extensions`: service
starts restore those copies from Nix and remove retired declarations. An empty
list removes only previously managed extensions. Pocket's in-app restart does
not reset managed edits. New declarations cannot overwrite unmanaged files;
move a colliding file aside before declaring it. Existing installations without
a manifest are treated as unmanaged too.

The `extension-management` flake check exercises the file reconciliation directly,
including collisions, invalid manifests and symlinks. It verifies that cleanup
never follows a file symlink or replaces an unmanaged extensions directory.
