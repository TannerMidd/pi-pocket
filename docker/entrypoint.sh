#!/bin/sh
# Chromium's Singleton* files point at the container that wrote them. A recreated container has a new hostname, so
# Chromium refuses the profile it finds in the bind mount. No browser runs in a fresh container: the locks are stale.
data="${PI_POCKET_DIR:-/data}"
rm -f \
    "$data/browser/profile/SingletonCookie" \
    "$data/browser/profile/SingletonLock" \
    "$data/browser/profile/SingletonSocket"

# Git identity for commits, like the one docker-compose.override.yml passes in via environment.
# Fall back to git config when not set on the host so pi-pocket always has a name and email.
export GIT_USER_NAME="${GIT_USER_NAME:-$(git config user.name 2>/dev/null || true)}"
export GIT_USER_EMAIL="${GIT_USER_EMAIL:-$(git config user.email 2>/dev/null || true)}"

exec node /app/bin/pi-pocket.js "$@"
