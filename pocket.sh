#!/usr/bin/env bash
#
# Run this checkout of pi-pocket with the environment of the host it sits on.
#
# Compose already loads docker-compose.yml and, next to it, docker-compose.override.yml
# — that file is the service's extra mounts and identity. What it cannot know is what
# a login shell carries, so this does the `-e VAR` pass-through the same way run-opencode
# does in the dotfiles: values stay in the shell, never in a file in the repo.
#
#   ./pocket.sh                 up -d --build, the default
#   ./pocket.sh up -d           start, reusing the image as it is
#   ./pocket.sh down            stop
#   ./pocket.sh ps              is it up?
#   ./pocket.sh link            print the owner sign-in link (it is the server key)
#   ./pocket.sh logs -f         follow the logs
#
# Anything else is passed to `docker compose` unchanged. Runs from wherever it is
# called: the working directory is this checkout, which is where both compose files
# live.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${here}"

# The override writes into host-owned mounts as the invoking user rather than root.
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

## Make the host pi configs available
export PI_POCKET_PI_DIR="${HOME}/dotfiles/pi-harness/.pi/"
export PI_POCKET_EXTENSIONS="${HOME}/dotfiles/pi-pocket/.pi-pocket/extensions"

# Identity for commits, read the way run-opencode reads it in the dotfiles: from git
# itself, so no compose file has to hold it. Left blank when git has no answer.
export GIT_USER_NAME="${GIT_USER_NAME:-$(git config user.name 2>/dev/null || true)}"
export GIT_USER_EMAIL="${GIT_USER_EMAIL:-$(git config user.email 2>/dev/null || true)}"

compose() {
    docker compose "$@"
}

# No argument: bring it up, rebuilding when the source changed.
if [[ $# -eq 0 ]]; then
    set -- up -d --build
fi

case "$1" in
link)
    # The owner link is the key to this server. It is reprinted on every start, and in
    # `lan` mode it names the container's own address: keep the path and token, swap
    # the host for the one you open it at.
    compose logs pi-pocket | grep -o 'http://[^ ]*/login?token=[^ ]*' | tail -1
    ;;
*)
    compose "$@"
    ;;
esac
