# Policies for extension authors and contributors

The guides tell how to do a thing. These policies tell what is permitted, and what Pi Pocket promises. They are for people who write extensions, share them in the gallery, review them, or change Pi Pocket itself.

## How to read them

- **Must** and **do not** are rules. **Should** is a strong recommendation. **Can** and **may** give a choice.
- Each rule has an ID: C for [core or extension](core-or-extension.md), A for [the API](api-stability.md), S for [security](security-model.md), and G for [the gallery](gallery-review.md). Use the ID in issues and reviews, for example "G14".
- Each rule has a reason. When a case is not in the rules, use the reasons to decide.
- These pages collect rules from [extensions.md](../../extensions.md), [SECURITY.md](../../../SECURITY.md), and the gallery's index, and add their own. When they do not agree, tell us in an issue. Until it is fixed, obey the stricter text.

## The policies

**[Core or extension](core-or-extension.md).** Where a change goes. Core keeps what must work the same for all people and all extensions: who may act, stored data and how it lasts, spend and the choice of models, and security. Extensions keep optional workflows, integrations, presentation preferences, and the process of one team. The page gives examples from Pi Pocket, such as linked sessions in core and Agent Teams as an extension, and tells how to ask for a new extension point.

**[The public API and how it changes](api-stability.md).** Which interfaces are for extensions: `host`, `web`, `pocket`, a command's `ctx`, some CSS names, events, the names for stored data, and the gallery entry format. All other code is internal. The page tells what `pocketApi` means, what is a breaking change, how a member is deprecated and removed, and how the release notes tell authors.

**[The security model for extension authors](security-model.md).** What a module can do, and who can reach it. A drop-in runs with the owner's rights, and a browser module with the rights of the person whose tab loads it. The page tells who reaches routes and commands, which input is untrusted, where secrets must not go, and what Lancet Guard does not see.

**[Gallery entries and their review](gallery-review.md).** The rules for an entry in the gallery's index, what its checks and its maintainers check, and what gets refused. It also tells how updates are reviewed, and what happens to entries that are abandoned, revoked, or removed.

## Changes to these pages

A change to a policy that gives authors less is told in the release notes, as a breaking change is ([api-stability.md](api-stability.md#release-notes-for-extension-authors)).
