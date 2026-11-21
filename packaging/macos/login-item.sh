#!/bin/bash
# Turns the start of Pi Pocket at sign-in on or off: a LaunchAgent that opens Pi Pocket.app in the menu bar only
# (--hidden) from the next sign-in.
#
#   login-item.sh on | off | status
set -u

LABEL="io.github.tannermidd.pi-pocket"
APP="$HOME/Library/Application Support/Pi Pocket"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

xml() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Pi Pocket.app where postinstall put it: ~/Applications, or this folder when another app has its name there.
bundle() {
    local each

    for each in "$HOME/Applications/Pi Pocket.app" "$APP/Pi Pocket.app"; do
        if [ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$each/Contents/Info.plist" 2>/dev/null)" = \
            io.github.tannermidd.pi-pocket.launcher ]; then
            echo "$each"

            return 0
        fi
    done

    return 1
}

case "${1:-}" in
    on)
        if ! app="$(bundle)"; then
            echo "Pi Pocket.app is not installed." >&2
            exit 1
        fi

        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Pi Pocket" || exit 1
        cat > "$PLIST.tmp" <<EOF || exit 1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-g</string>
        <string>-a</string>
        <string>$(xml "$app")</string>
        <string>--args</string>
        <string>--hidden</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>$(xml "$HOME/Library/Logs/Pi Pocket/sign-in-item.log")</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
EOF
        if ! /usr/bin/plutil -lint -s "$PLIST.tmp"; then
            rm -f "$PLIST.tmp"
            exit 1
        fi

        mv -f "$PLIST.tmp" "$PLIST"
        echo "Pi Pocket starts in the menu bar when you sign in, from the next sign-in."
        ;;
    off)
        /bin/launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
        rm -f "$PLIST" "$PLIST.tmp"
        echo "Pi Pocket does not start when you sign in."
        ;;
    status)
        if [ -f "$PLIST" ]; then
            echo "on"
        else
            echo "off"
        fi
        ;;
    *)
        echo "Usage: $0 on | off | status" >&2
        exit 2
        ;;
esac
