#!/bin/bash
# Turns the start of Pi Pocket at sign-in on or off: a LaunchAgent in ~/Library/LaunchAgents that opens
# "Pi Pocket at sign-in.command" in Terminal when the user signs in, from the next sign-in.
#
#   login-item.sh on | off | status
#
# The package's "Start Pi Pocket when I sign in" choice runs it with on (off by default), each install runs it with off
# first, and uninstall.sh runs it with off.
set -u

LABEL="io.github.tannermidd.pi-pocket"
APP="$HOME/Library/Application Support/Pi Pocket"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

xml() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

case "${1:-}" in
    on)
        mkdir -p "$HOME/Library/LaunchAgents" || exit 1
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
        <string>-a</string>
        <string>Terminal</string>
        <string>$(xml "$APP/Pi Pocket at sign-in.command")</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
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
        echo "Pi Pocket starts in Terminal when you sign in, from the next sign-in."
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
