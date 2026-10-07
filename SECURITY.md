# Security

## Reporting a problem

Please report security problems privately through GitHub: on this repository, open **Security → Report a vulnerability**. Do not open a public issue. Include what you found, how to reproduce it, and what an attacker gains.

## What Pi Pocket protects, and what it does not

Pi Pocket runs a coding agent that executes commands on the machine it runs on, as the user who started it.

- **Signing in.** The owner's sign-in link is the key to the server. Invites are one-time links that expire after 15 minutes, or an hour, a day, or a week when whoever makes one picks that; the longer one lasts, the longer a link that leaks can be used. Their codes are stored hashed. An owner invite, which only the owner can make, always lasts 15 minutes and gives the device that opens it the owner token itself, and with it full control; starting with `--rotate-token` signs out every device that has it and ends owner invites not yet used. Tokens are random, stored hashed, and kept in an `HttpOnly` cookie.
- **Viewers** can read, react, and chat. They cannot make Pi do anything.
- **Anyone who can steer can do what you can.** Through Pi, they reach your files, Pi Pocket's settings and tokens, and its code. An invite to one session limits what someone sees in the app, not what Pi can reach. Neither do git worktrees or spend limits: a worktree keeps a session's files apart, and a run is stopped only after the request that crosses its limit.
- **Approvals.** Lancet Guard approvals can come from anyone who can steer, including the person who asked, unless the owner turns on "Approvals need someone else" (Menu → Extensions); then, when nobody is known to have asked, only the owner can allow. A notification offers Allow only for a call that fits on one short line; anything longer opens the app first. A "Done when" check command runs after every answer without asking, so with Lancet Guard on it must be one the guard allows outright.
- **The built-in browser** reaches what this machine reaches: `localhost`, your network, and the internet. Anyone who can steer can use it from the Browser panel, and Pi from its `browser` tool; Lancet Guard does not check either, and pages can hold whatever they show. The addresses people open show in the session's chat. Its pages run in Chromium on the server, not in your browser, so they cannot reach the app or its cookies. Only the owner opens files from the address bar or sees which servers run on the machine. If steering guests should not reach your network, turn Browser off in Menu → Extensions.
- **Plan mode** keeps Pi to planning; it is not a boundary. Programs that people configured to run on their own, such as a git diff driver, run as they would for anyone.
- **Drop-in extensions** in `~/.pi-pocket/extensions/` run inside the server with the owner's rights. They stay off until the owner turns them on.
- **Replies are untrusted.** Anything Pi reads can steer what it writes, so the app page loads nothing from other sites, and replies cannot contain forms, scripts, or styling. Artifacts run in a sandbox with no access to the app. An HTML block in a reply is previewed in a frame of its own with its scripts off and a policy that loads nothing, not even from the app; tapping **Run** runs it as an artifact runs, with scripts and the network but no access to the app, so a page Pi was steered into writing could then send what it shows elsewhere. SVG blocks show as images, which run nothing.

Problems within these limits are bugs we want to hear about: for example, a viewer making Pi act, a session-scoped person seeing another session, or a reply reaching the app's cookies or API.
