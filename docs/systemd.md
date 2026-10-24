# Running Pi Pocket as a systemd service

Pi Pocket ships a systemd template unit at [`contrib/systemd/pi-pocket@.service`](../contrib/systemd/pi-pocket@.service). The instance name is the access mode, so one file starts the server in any mode:

```bash
sudo systemctl enable --now pi-pocket@lan
```

The modes are `local`, `lan`, `cloudflare`, `tailscale`, and `tailscale-serve`. [Remote access](../README.md#remote-access) explains who can connect in each one.

Enable one instance at a time. Every instance uses the same port and data folder, so two of them would share both.

## Before you start

- Node.js 22.19 or newer, installed for the whole system and found through `PATH`. A copy in a home folder, such as one from `nvm` or `mise`, is not visible to the service.
- A checkout of Pi Pocket with its packages installed (`npm install`).
- A user for the service. Give it an account of its own: agents run commands as this user, and anyone who can steer a session can run them too.

The access mode also needs its own tools:

- `local`: nothing. Listens on `127.0.0.1`.
- `lan`: the port open in the firewall (TCP 8787 by default). Plain http.
- `cloudflare`: `cloudflared` on `PATH`, or in `/var/lib/pi-pocket/bin`. The service has no terminal, so it cannot download it. Run Pi Pocket once in a terminal as the service user, or install it yourself. The quick tunnel address changes each time the launcher starts.
- `tailscale`: Tailscale connected (`tailscale up`). Listens on the Tailscale address only.
- `tailscale-serve`: `tailscaled` running, HTTPS certificates enabled in the tailnet, and the service user as its operator: `sudo tailscale set --operator=pi-pocket`. The launcher adds and removes the Serve mapping.

Provider sign-in does not need a terminal: sign in from the app's Providers sheet after the first start.

## Install

From the checkout:

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/pi-pocket pi-pocket
sudo mkdir -p /srv/pi-pocket
sudo chown pi-pocket: /srv/pi-pocket
sudo cp contrib/systemd/pi-pocket@.service /etc/systemd/system/
```

Edit the copy in `/etc/systemd/system/` when your paths differ:

- `POCKET_HOME` is the checkout, `/opt/pi-pocket` in the unit. It must contain `bin/pi-pocket.js`.
- `HOME` and `--data` are `/var/lib/pi-pocket`: Pi's config, sign-ins, database, uploads, and extensions live there.
- `WorkingDirectory` and `--cwd` are `/srv/pi-pocket`: new sessions start there, and it must be writable by the service user.

Then start an instance:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-pocket@lan
```

To run as an existing user instead, change `User`, `Group`, and `HOME` together, and point `--data` at a folder that user can write. Remove `StateDirectory` when the data folder is not `/var/lib/pi-pocket`.

## Read the sign-in link

The owner's sign-in link is in the log and is printed again on every start. It is the key to this server, so keep it private:

```bash
journalctl -u pi-pocket@lan | grep '/login?token='
```

Open it once per browser. A cookie lasts a year.

## Use

```bash
systemctl status pi-pocket@lan
journalctl -u pi-pocket@lan -f
sudo systemctl restart pi-pocket@lan
sudo systemctl stop pi-pocket@lan
```

To change the access mode, disable the old instance first:

```bash
sudo systemctl disable --now pi-pocket@local
sudo systemctl enable --now pi-pocket@lan
```

The data folder stays the same, so sessions, people, and settings carry over.

## Settings and secrets

Put provider keys and other secrets in `/etc/pi-pocket.env`, one `KEY=VALUE` per line, and keep it readable by root only (`0600`). The unit reads it when the file exists. `PATH` must include the commands that the launcher and the agents use, such as `node`, `git`, `gh`, `tailscale`, and `cloudflared`.

The unit runs with `NoNewPrivileges=yes` and `PrivateTmp=yes`. Remove those lines if agents must use `sudo` or share the host's `/tmp`.

## Updating

Stop the service, back up the data folder, update the checkout, install its packages, and start the service again:

```bash
sudo systemctl stop pi-pocket@lan
sudo cp -a /var/lib/pi-pocket /var/lib/pi-pocket.backup
git pull
npm install
sudo systemctl start pi-pocket@lan
```

If the unit file changed, copy it again and run `sudo systemctl daemon-reload` before starting.

## When it does not start

The launcher has no terminal under systemd, so it uses the mode from `--access` and never shows its menu. When that mode is not ready, it exits with a message:

```bash
journalctl -u pi-pocket@lan -n 30 --no-pager
```

Check the prerequisites above: `cloudflared` for a tunnel, a connected Tailscale, or the operator for Tailscale Serve. A port already in use is another common cause. On NixOS, use the module instead of this unit: `services.pi-pocket.enable = true;`.
