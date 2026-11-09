# Running Pi Pocket in Docker or Podman

Pi Pocket runs from its source with Node.js, so the container is thin: Node, Chromium for the Browser panel, and the command-line tools the built-in extensions use (`git`, `gh`, `ripgrep`, `fd`, and `cloudflared`).

The image is built from the repository root. [`docker-compose.yml`](../docker-compose.yml) is the usual way to run it; [`docker/Dockerfile`](../docker/Dockerfile) works with plain `docker run` or `podman run` too.

## Start it

```bash
cp .env.example .env    # optional, but it is where the external folders are set
docker compose up -d --build
# or
podman compose up -d --build
```

Then read the owner's sign-in link from the log. It is the key to this server, so keep it private:

```bash
docker compose logs pi-pocket | grep '/login?token='
podman logs pi-pocket | grep '/login?token='
```

The link is printed again on every start. Open it once per browser. The launcher's interactive menu is not available in a container, so the access mode comes from `PI_POCKET_ACCESS` (default `lan`).

In `lan` mode the printed link names the container's own address (often `172.x.x.x`), which other devices cannot reach. Keep its path and token, and change the address to the host's: `http://localhost:8787/login?token=…` on the host, or the host's address on the local network for a phone. Invite links use the address the app is open at, so open it at the host's network address before you invite someone.

Stop it with `docker compose down` or `podman compose down`. `down -v` is not needed for anything here: the state is in the host folders, not in an anonymous volume.

The container's entrypoint clears Chromium's stale `Singleton*` locks in `./data/browser/profile`. Without that, a recreated container can refuse to start the embedded browser, because the old locks name the previous container.

## Folders from the host

Every folder that matters is a bind mount, so it stays outside the container and outside the image. Change the left-hand side in `.env` to use a folder anywhere on the host.

| Variable               | Default             | In the container   | Holds                                                                                             |
| ---------------------- | ------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `PI_POCKET_DATA`       | `./data`            | `/data`            | `pocket.sqlite`, `config.json`, `push.json`, uploads, worktrees, the browser profile, and logging |
| `PI_POCKET_EXTENSIONS` | `./data/extensions` | `/data/extensions` | The owner's drop-in extensions, loaded from this folder                                           |
| `PI_POCKET_THEMES`     | `./data/themes`     | `/data/themes`     | The owner's themes, loaded from this folder                                                       |
| `PI_POCKET_PI_DIR`     | `./data/pi`         | `/home/node/.pi`   | Pi's `agent/` folder: `auth.json`, `settings.json`, skills, prompts, trust, sessions, packages    |
| `PI_POCKET_WORKSPACE`  | `./data/workspace`  | `/workspace`       | The projects Pi works on, and where new sessions start                                            |

The mounts are nested on purpose: `extensions`, `themes`, `pi`, and `workspace` are separate host folders under `./data`, even though the app reads them inside `/data` or `/home/node`. Dropping a `.ts` file into `./data/extensions` makes it appear in Menu → Extensions, off until the owner turns it on. The gallery's **Install** writes there too.

Pi's sign-ins live in `./data/pi/agent/auth.json`, not in Pi Pocket's database. Keeping that folder means a fresh database reuses the same sign-ins, and a Pi CLI on the host can share it (`PI_CODING_AGENT_DIR=/absolute/path/to/data/pi/agent`).

Provider keys can go in `.env` and the `environment:` block of the Compose file instead. Keys are not written to the image.

## Access and ports

`PI_POCKET_BIND` is the host address the port is published on, and `PI_POCKET_PORT` is the port on both sides (default `8787`). For phones on the same network, leave the default `0.0.0.0` and `PI_POCKET_ACCESS=lan`.

For a single machine only, publish the port on the host's loopback address and keep `lan` inside the container:

```dotenv
PI_POCKET_BIND=127.0.0.1
PI_POCKET_ACCESS=lan
```

Do not use `PI_POCKET_ACCESS=local` with the published port: `local` listens on the container's own `127.0.0.1`, which the host cannot reach.

`cloudflare` works in the container: the image already contains `cloudflared`, so the launcher does not need a terminal to download it. The tunnel runs inside the container, and the published port is not used. `tailscale` looks for a Tailscale address in the container, which it usually does not have. Run Tailscale on the host instead: publish the port on `127.0.0.1` as above and point `tailscale serve` at it, or run the container with `network_mode: host`.

`tailscale-serve` does not work from the container as shipped: the image has no `tailscale` command, and it would need the host's `tailscaled` socket as well. Keep Tailscale on the host and mount the port by hand, as above; the launcher's own mode is for a native install.

## Permissions

Compose runs the container as root. With rootless Podman, root inside the container is your own host user, so the bind-mounted folders are writable without extra work. This is why the default is root, despite the Browser panel being a Chromium process.

With Docker, root is root. The app still works, but files created in the mounts belong to root on the host. To run as your user instead, make sure the external folders are owned by that user and add this to the service:

```yaml
user: "1000:1000"
```

Then set `HOME` to a writable folder (`HOME: /home/node` works when the uid is `1000`, the image's `node` user) and make `./data` writable by it. Leave `--no-sandbox` in `PI_POCKET_BROWSER_ARGS` in that case too, unless you have added the kernel's user-namespace permissions the Chromium sandbox needs.

The service sets `no-new-privileges`: no process in the container can gain privileges through setuid programs or file capabilities. Chromium runs with `--no-sandbox` in the container, so this, and not running as root, are what limit a page that breaks out of the browser.

On an SELinux host, add `:Z` to bind mounts, or run `chcon` on the folders yourself.

## Updating

The source is copied into the image, so rebuild after pulling:

```bash
git pull
docker compose up -d --build
```

The external folders and the database are untouched. Extensions are live-edited without a rebuild only once they are mounted; the built-in code and the web app are read from the image, so a rebuild is needed for changes to `src/` and `web/`.

## Python tools

The stock image has no python and no `uv` on PATH. [`docker/tools.dockerfile`](../docker/tools.dockerfile) adds both. It repeats the stock file's stages, line for line, and then continues the `app` stage with python3 and uv. `docker-compose.override.yml` builds it as `pi-pocket:tools`, so nothing is copied a second time and the stock stages are not built twice:

```bash
./pocket.sh
```

Compose builds the image a service names before it creates the container. `pi-pocket:local` is built first in the same build, and the tools image is layered on it.

The stage's lines are kept identical to `docker/Dockerfile` on purpose. A line that differs in the copy makes Docker build the stage again, and the tools would sit on a different base.

What a session gets:

- `python3`, `python3-venv`, and `build-essential`, so `uv venv` works and a package without a wheel can still compile. `UV_PYTHON_DOWNLOADS=0` is set for the session, so a `uv python install` download is not available: it lives in the container's writable layer and a recreate erases it.
- `uv` and `uvx` in `/usr/local/bin`, and `/opt/uv-bin` (the folder `UV_TOOL_BIN_DIR` names) at the start of PATH. Both folders are on the image, so the PATH comes from the image and no compose variable sets it.
- `/opt/uv-bin` is writable by every uid, so a tool that the host's uid installs with `uv tool install ruff` lands on PATH in the same container.
- `kubectl` in `/usr/local/bin`, placed by architecture as `glab` is. It is pinned to `v1.32.5`, the cluster's version, because a client may only be one minor ahead of or behind its server. It needs no cluster at build time. A kubeconfig in `~/.kube` is on the home bind mount, so contexts and logins survive a recreate.
- `hugo` in `/usr/local/bin`, the extended build, pinned to `v0.169.0`. The extended build is the one that processes images and renders maths, and a blog whose templates use both needs it.
- `obsidian-export` in `/usr/local/bin`, pinned to `v25.3.0`. It is the step before Hugo: it rewrites a vault's Obsidian Markdown into the standard Markdown that Hugo renders, so the two build a blog from an Obsidian vault, as the LLMWiki blog does with `blog/ponym.work/.site/build.sh`. Both versions are the ones that project pins in its `.gitlab-ci.yml`.

`obsidian-export` is a glibc binary, so it needs this Debian image and not Alpine. GitHub publishes it for x86_64 linux only: an arm64 image gets Hugo and no export step, and the blog's `build.sh` names the tool it lacks. The vault must be inside a bind mount for a session to reach it.

A project venv works as usual. `UV_PROJECT_ENVIRONMENT=.venv` puts it at the project folder, and `.venv` is the name uv and every editor expect by default, so `uv run` and `uv sync` find it without a PATH entry. Scripts in a venv are not reachable by name from outside it: use `uv run` in the project folder, or activate the venv with `source .venv/bin/activate`.

Check that a running container has them:

```bash
docker compose exec pi-pocket sh -c 'python3 --version && uv --version && kubectl version --client && hugo version && obsidian-export --version'
```

## Security

Anyone who can steer a session can run commands in this container as its user. With the default root user that means every file in the mounted folders, and every provider key in the environment. Mount only the projects you would trust Pi with, keep the port off the public internet unless you use a tunnel, and read [SECURITY.md](../SECURITY.md) before inviting other people.
