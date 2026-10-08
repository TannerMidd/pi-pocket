# Installed-runtime tests

`nix build` runs the existing source checks and then `installed.mjs` against the
installed package, after development dependencies have been pruned. It starts the
wrapped executable outside the checkout, with an isolated home and no inherited
build tools or provider credentials. It checks HTTP assets, dependency resolution,
owner activation, automatic hot reload, and persistence of extension files,
enabled/disabled choices and a database session across restarts. No model calls
are needed.

On Linux, `nix flake check` also runs `service.py` in the NixOS VM configured by
`service.nix`. The Python test has annotated functions and response records and
must pass basedpyright in strict mode before the VM starts. To run just that check on an
x86-64 Linux host:

```sh
nix build .#checks.x86_64-linux.nixos-service -L
```

The VM exercises the actual service user, systemd startup, Pocket's server restart,
service restart, and switches to prebuilt NixOS specialisations with changed and
empty extension declarations. These are real configuration activations, without
needing a network-dependent `nixos-rebuild` inside the VM.

The tests deliberately distinguish package and module behaviour. The package
preserves owner-created extensions and live edits. **The current NixOS module
resets the entire extensions directory on every service start, even with
`extensions = []`: owner additions disappear and declared files revert to their
Nix sources.** The service test characterises this destructive behaviour; it does
not endorse it as the desired policy. Changing extension ownership should update
those assertions along with the module.
