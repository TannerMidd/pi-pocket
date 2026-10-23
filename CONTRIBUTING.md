# Contributing to Pi Pocket

Thank you for your help. This page tells how to send a change.

## Before you start

- Read the [policies](docs/extensions/policies/index.md). They tell what belongs in core and what belongs in an extension, which interfaces are public, and how they change.
- For a large change, open an issue first. Tell what you want to change, and why.
- If an extension cannot do what you need, ask for an extension point ([how](docs/extensions/policies/core-or-extension.md#ask-for-a-new-extension-point)).
- To report a security problem, do not open an issue. Read [SECURITY.md](SECURITY.md).

## Make the change

- [AGENTS.md](AGENTS.md) and [docs/self-editing.md](docs/self-editing.md) tell how to work on the code. [docs/map.md](docs/map.md) tells where things are.
- Add one small test for each real risk that the change brings. The test must fail before the change.
- Run `npm run format`, `npm run check`, `npm run lint`, and `npm test`.

## Send it

- Open a pull request with a short title, and a brief note: what changed, why, and what you tested.
- Maintainers merge with a merge commit, so your commits keep your name.
- A release pull request's description is the release notes: [docs/release-notes.md](docs/release-notes.md) tells how to write them.
