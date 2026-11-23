# Running Pi Pocket

For the first launch, see the [quick start](../README.md#quick-start). This guide covers updates, Android, remote access, and reverse proxies.

## Updates and backups

Menu → **Update Pi Pocket** updates a git checkout run with `npm start`, or a global npm install (`npm install -g pi-pocket`) that your user can write, and restarts. It goes back by itself if the new version does not start ([features](features.md)). A local install (`npm install pi-pocket` in a project) and `npx pi-pocket` do not update from the app: the sheet says what to run, `npm install pi-pocket@latest` or `npx pi-pocket@latest`. By hand: stop the server, back up `~/.pi-pocket`, pull, run `npm install`, and start again; for a global install, run `npm install -g pi-pocket@latest`. If the machine stops at the very moment of the switch, `pi-pocket` may not start; `npm install -g pi-pocket` restores it. Read the [release notes](https://github.com/TannerMidd/pi-pocket/releases) first: 0.21.0 and 0.28.0 upgrade the data one way, so going back needs the backup.

## Android (Termux)

```bash
pkg update && pkg upgrade && pkg install nodejs git
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi    # /login, then quit
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket && npm install --ignore-scripts && termux-wake-lock && npm start
```

Lancet Guard may not load on Android. If it is on but fails, start with `PI_POCKET_GUARD=off`.

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode              | Who can connect      | Notes                                                      |
| ----------------- | -------------------- | ---------------------------------------------------------- |
| `local`           | This machine         | `127.0.0.1`; bring your own tunnel to port 8787            |
| `lan`             | Your local network   | Plain http                                                 |
| `cloudflare`      | Anyone with the link | Free https quick tunnel, no account; needs `cloudflared`   |
| `tailscale`       | Your tailnet         | Plain http on the tailnet address                          |
| `tailscale-serve` | Your tailnet         | https at the tailnet name; needs `tailscale` 1.52 or newer |

`tailscale-serve` needs the `tailscale` command on your `PATH`, signed in, with MagicDNS and HTTPS certificates enabled in the tailnet, and, when the launcher does not run as root, that user as tailscaled's operator (`sudo tailscale set --operator=$USER`). It serves port 443 at the machine's tailnet name, and a server restart keeps the address. When the launcher quits it takes down the mount it made; one it found already in place is left where it is. Without the command the launcher says so and stops rather than falling back to this device only when nobody is there to pick another mode. `--host` cannot be combined with it: serve always listens on `127.0.0.1` and lets tailscaled reach it. For another tunnel (ngrok), choose `local` and point it at port 8787.

Other options: `--port` (8787), `--cwd`, `--data` (`~/.pi-pocket`), `--host`, `--socket` ([below](#behind-a-reverse-proxy-on-a-unix-socket)), and `-y` to reuse the last access choice. `--host` overrides the address a named mode would listen on, and one launcher runs per data folder (a second one says which pid holds it). `npm start -- --help` lists them all. `PI_POCKET_BROWSER` and `PI_POCKET_BROWSER_ARGS` pick the built-in browser and its flags when Chromium or Chrome is not found by itself. `PI_POCKET_PROMPT_DATE=1` puts today's date in Pi's system prompt; it is left out by default, so the prompt cache does not start over when the date changes. `PI_POCKET_SESSION_CACHE=off` keeps browsers from saving the sessions they open on the device (IndexedDB), so that they keep them in each tab's memory only; it is on by default. `PI_POCKET_CACHE_KEEPER=off` turns off the prompt cache keeper, which keeps a model's prompt cache warm while a run waits on a tool call ([features](features.md)). `PI_POCKET_KEEPALIVE_SECONDS` (default `5`, from `1` to `3600`) is how long the server keeps an idle connection open for its next request. Behind a reverse proxy of your own (Caddy, nginx, a load balancer), set it above the proxy's idle timeout, or set the proxy's below it: otherwise the proxy can send a request on a connection as the server closes it, and answers with a 502. Caddy keeps idle connections for 2 minutes by default, so `PI_POCKET_KEEPALIVE_SECONDS=125`, or `keepalive 4s` in Caddy's `transport http` block.

> [!WARNING]
> Anyone who can steer a session can make Pi run commands on this machine, as you. That reaches your files, Pi Pocket's own settings and tokens, and its code. Invite only people you would trust at your keyboard. View-only users cannot make Pi act. [SECURITY.md](../SECURITY.md) says what is protected and what is not.

### Behind a reverse proxy on a Unix socket

`--socket PATH` (or `PI_POCKET_SOCKET`) makes the server listen on a Unix socket instead of a TCP port, for a reverse proxy on the same machine, such as Caddy or nginx. Use it on a machine that other people use too: while the server restarts, any user can take a free TCP port and get the requests meant for Pi Pocket, sign-in cookies too. A socket's folder keeps them out.

`--socket` replaces `--access`, `--host`, and `--port`: it cannot be combined with them, and their environment variables are ignored. The launcher starts no tunnel and runs no `tailscale serve`, and its `a` and `o` keys do nothing. It prints the owner's sign-in path (`/login?token=…`): open it at the proxy's address.

The folder is the security boundary. Pi Pocket checks it before it listens, and does not start when:

- the folder is a symlink, or the path goes through one;
- another user than the server's (or root) owns the folder, or its group or others can write to it;
- another user can write to a folder above it, unless that folder is sticky, as `/tmp` is;
- the path is a file, a folder, or a symlink: Pi Pocket never follows or removes one;
- a server answers on the socket already.

A socket that nothing answers on, as a killed server leaves, is replaced. The new socket gets mode `0660`, so the folder's group can connect. Give the folder the proxy's group and mode `2750`: then only the server's user and the proxy can reach the socket. Pi Pocket removes the socket when it stops.

An example on Linux, with the server as `alice` and Caddy as `caddy`:

```bash
# /run is empty after a reboot: a tmpfiles.d line (d /run/pi-pocket 2750 alice caddy -) makes the folder again.
sudo install -d -o alice -g caddy -m 2750 /run/pi-pocket
pi-pocket --socket /run/pi-pocket/pocket.sock
```

```caddyfile
pocket.example.com {
    reverse_proxy unix//run/pi-pocket/pocket.sock
}
```

Caddy keeps idle connections longer than Pi Pocket does: also set `PI_POCKET_KEEPALIVE_SECONDS=125`, as [Remote access](#remote-access) says.

With nginx (as the user `www-data`, in that group):

```nginx
location / {
    proxy_pass http://unix:/run/pi-pocket/pocket.sock:;
    proxy_http_version 1.1;
    # Uploads: nginx takes only 1 MB by default.
    client_max_body_size 50m;
    # $http_host keeps a port that is not the default one.
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Sign-in works as it does on a port: the owner's link, invites, the `HttpOnly` cookie, and the `X-Pocket` header on every change. Pi Pocket trusts no client address, on a port or on a socket, so the socket lets nobody past sign-in. Invite links and the cookie's `Secure` flag come from the `X-Forwarded-Host` (else `Host`) and `X-Forwarded-Proto` headers. Caddy sets them by itself, and nginx needs the lines above. Let the proxy set them, and not pass on a client's: a wrong value gives wrong invite links, not access.
