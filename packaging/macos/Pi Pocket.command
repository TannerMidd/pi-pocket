#!/bin/sh
# Pi Pocket (console).app opens this file in Terminal: the launcher's menu, its keys, and the sign-in link show in the
# window.
# Press q, or close the window, to stop Pi Pocket. New sessions start in the home folder.
cd "$HOME" || exit 1
"$(dirname "$0")/pi-pocket" "$@"
code=$?

if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then
    exit "$code"
fi

echo
echo "Pi Pocket stopped with exit code $code."
printf "Press Return to close this window. "
read -r _
exit "$code"
