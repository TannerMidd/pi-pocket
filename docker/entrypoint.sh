#!/bin/sh
# Chromium's Singleton* files point at the container that wrote them. A recreated container has a new hostname, so
# Chromium refuses the profile it finds in the bind mount. No browser runs in a fresh container: the locks are stale.
data="${PI_POCKET_DIR:-/data}"
rm -f \
    "$data/browser/profile/SingletonCookie" \
    "$data/browser/profile/SingletonLock" \
    "$data/browser/profile/SingletonSocket"

exec node /app/bin/pi-pocket.js "$@"
