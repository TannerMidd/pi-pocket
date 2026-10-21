# Making it built in

A built-in module is a part of Pi Pocket itself, for each person who uses this copy. Make a module built in only when it changes Pi Pocket itself ([Core or extension](policies/core-or-extension.md)).

## Write it as a drop-in first

The running server loads a new file in `src/server/extensions/` a moment after you first save it. It is on, for everyone. There is no way to try it there first. So:

1. Write the module as a drop-in.
2. Check it on a copy of Pi Pocket ([self-editing.md](../self-editing.md#check-it-on-a-copy)).
3. Move it into `src/server/extensions/` when it works.

## Register it

In `src/server/reload.ts`:

1. Give the module its place in `ORDER`, and its title in `TITLES`.
2. If it must start off, add it to `OFF_BY_DEFAULT`.
3. Add the names of its tools to `BUILT_IN_TOOLS`, so that no drop-in takes them, and plan mode trusts no read-only hint a drop-in's wrap puts on them. No test checks this list: keep it in step by hand.

Name the extension `pocket-…`.

`reload.ts` is not an extension, so these changes take effect at the next restart.
