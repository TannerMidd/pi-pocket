# Security

## Reporting a problem

Please report security problems privately through GitHub: on this repository, open **Security → Report a vulnerability**. Do not open a public issue. Include what you found, how to reproduce it, and what an attacker gains.

## What Pi Pocket protects, and what it does not

Pi Pocket runs a coding agent that executes commands on the machine it runs on, as the user who started it.

- **Signing in.** The owner's sign-in link is the key to the server. Invites are one-time links that expire after 15 minutes. Tokens are random, stored hashed, and kept in an `HttpOnly` cookie.
- **Viewers** can read, react, and chat. They cannot make Pi do anything.
- **Anyone who can steer can do what you can.** Through Pi, they reach your files, Pi Pocket's settings and tokens, and its code. An invite to one session limits what someone sees in the app, not what Pi can reach. Lancet Guard approvals can come from anyone who can steer, including the person who asked.
- **Replies are untrusted.** Anything Pi reads can steer what it writes, so the app page loads nothing from other sites, and replies cannot contain forms, scripts, or styling. Artifacts run in a sandbox with no access to the app.

Problems within these limits are bugs we want to hear about: for example, a viewer making Pi act, a session-scoped person seeing another session, or a reply reaching the app's cookies or API.
