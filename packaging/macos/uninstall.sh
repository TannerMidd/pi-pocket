#!/bin/bash
# Removes what the macOS package installed: Pi Pocket stops, then Pi Pocket.app, Pi Pocket (console).app, the sign-in item,
# the package receipts, and this folder go. Then it asks whether to delete the data in ~/.pi-pocket (default: No).
#
#   "$HOME/Library/Application Support/Pi Pocket/uninstall.sh" [--yes] [--keep-data | --delete-data]
#
# Without a terminal it asks nothing and keeps the data, unless --delete-data says otherwise. A data folder chosen with
# PI_POCKET_DIR or --data stays.
set -u

APP="$HOME/Library/Application Support/Pi Pocket"
DATA="$HOME/.pi-pocket"
PACKAGES="io.github.tannermidd.pi-pocket io.github.tannermidd.pi-pocket.login"
yes=0
data=ask

for arg in "$@"; do
    case "$arg" in
        --yes | -y) yes=1 ;;
        --keep-data) data=keep ;;
        --delete-data) data=delete ;;
        --help | -h)
            sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg (see --help)" >&2
            exit 2
            ;;
    esac
done

if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ] || [ "$(id -u)" = 0 ]; then
    echo "Run this as the user who installed Pi Pocket, without sudo." >&2
    exit 1
fi

interactive=0

if [ -t 0 ] && [ -t 1 ]; then
    interactive=1
fi

ask() {
    local answer

    printf '%s [y/N] ' "$1"
    read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ] || [ "$answer" = yes ]
}

if [ ! -f "$APP/pi-pocket" ] || [ ! -f "$APP/place-app.mjs" ]; then
    echo "No Pi Pocket package install in $APP." >&2
    exit 1
fi

if [ "$yes" = 0 ] && [ "$interactive" = 1 ] && ! ask "Uninstall Pi Pocket from $APP?"; then
    echo "Nothing changed."
    exit 0
fi

# shellcheck source=packaging/macos/stop-pi-pocket.sh
. "$APP/stop-pi-pocket.sh"

if pi_pocket_running; then
    echo "Stopping Pi Pocket…"
fi

stop_pi_pocket
stopped=$?

if [ "$stopped" = 2 ]; then
    exit 1
elif [ "$stopped" != 0 ]; then
    echo "Pi Pocket still runs. Quit it (Pi Pocket in the menu bar, then Quit), then run this again." >&2
    exit 1
fi

"$APP/login-item.sh" off > /dev/null

# Only Pi Pocket's own apps, not other apps of the same names.
for pair in "Pi Pocket.app:io.github.tannermidd.pi-pocket.launcher" \
    "Pi Pocket (console).app:io.github.tannermidd.pi-pocket.console"; do
    bundle="$HOME/Applications/${pair%%:*}"

    if [ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$bundle/Contents/Info.plist" 2>/dev/null)" = \
        "${pair#*:}" ]; then
        rm -rf "$bundle"
    fi
done

ID=io.github.tannermidd.pi-pocket.launcher
rm -rf "$HOME/Library/WebKit/$ID" "$HOME/Library/HTTPStorages/$ID" "$HOME/Library/HTTPStorages/$ID.binarycookies" \
    "$HOME/Library/Caches/$ID" "$HOME/Library/Saved Application State/$ID.savedState" \
    "$HOME/Library/Preferences/$ID.plist" "$HOME/Library/Logs/Pi Pocket"

for package in $PACKAGES; do
    /usr/sbin/pkgutil --volume "$HOME" --forget "$package" > /dev/null 2>&1
done

# This script is in the folder: bash has it open and reads on from it.
rm -rf "$APP"

if [ -e "$APP" ]; then
    echo "Could not remove all of $APP." >&2
    exit 1
fi

echo "Removed Pi Pocket."

if [ ! -d "$DATA" ]; then
    exit 0
fi

if [ "$data" = ask ] && [ "$interactive" = 1 ]; then
    echo
    echo "Your Pi Pocket data is in $DATA. It holds your sessions, sign-ins, settings, extensions, and the git"
    echo "worktrees of sessions, with any work in them that is not committed. Another Pi Pocket install on this"
    echo "account uses it too."

    if ask "Also delete your Pi Pocket data?"; then
        data=delete
    fi
fi

if [ "$data" = delete ]; then
    rm -rf "$DATA"
    echo "Deleted $DATA."
else
    echo "Your data stays in $DATA."
fi
