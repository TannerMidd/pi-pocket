# Stops a running Pi Pocket of this install. The package's preinstall and uninstall.sh source it, with APP set to the
# install folder. Bash 3.2 (macOS's /bin/bash): no newer syntax.
#
# It finds the processes by the executable file that they run (lsof, the txt descriptor), whatever their command line says:
# a program that only reads the file, such as a backup, stays. It also stops what they started and the launcher's tunnel.

pp_running_file() {
    if [ -e "$1" ]; then
        /usr/sbin/lsof -a -d txt -t -- "$1" 2>/dev/null | sort -un
    fi
}

pp_node_pids() {
    pp_running_file "$APP/node/bin/node"
}

# Pi Pocket.app starts a launcher of its own: found by its executable, and by its command line.
pp_app_pids() {
    local each

    for each in "$HOME/Applications/Pi Pocket.app/Contents/MacOS/Pi Pocket" "$APP/Pi Pocket.app/Contents/MacOS/Pi Pocket"; do
        pp_running_file "$each"
        /usr/bin/pgrep -f -- "^$each( |\$)" 2>/dev/null
    done | sort -un
}

pp_tree() {
    local pid child

    for pid in "$@"; do
        echo "$pid"

        for child in $(/usr/bin/pgrep -P "$pid" 2>/dev/null); do
            pp_tree "$child"
        done
    done
}

pi_pocket_running() {
    [ -n "$(pp_node_pids)$(pp_app_pids)" ]
}

# Each process given, as "<pid> <start time>": the pair stays the same process if its number is used again later.
pp_started() {
    local pid

    for pid in "$@"; do
        echo "$pid $(ps -o lstart= -p "$pid" 2>/dev/null)"
    done
}

# This shell and its parents: a script run from a Pi Pocket session is a child of the server that it stops.
pp_ancestors() {
    local pid=$$

    while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
        echo "$pid"
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    done
}

# The launchers first, with SIGTERM: each stops its tunnel and its server in order. Then SIGKILL for what is left, as the
# launcher can start a new server. Not 0 when Pi Pocket still runs at the end, and 2 when this shell is one of its processes.
stop_pi_pocket() {
    local _ pid nodes apps all before roots parent

    for _ in 1 2 3 4 5; do
        nodes="$(pp_node_pids)"
        apps="$(pp_app_pids)"
        # Found now: a child that outlives its parent goes to launchd, and pgrep -P no longer finds it.
        # shellcheck disable=SC2046,SC2086
        all="$(pp_tree $apps $nodes $(pp_running_file "$HOME/.pi-pocket/bin/cloudflared") | sort -un)"

        if [ -z "$all" ]; then
            return 0
        fi

        if pp_ancestors | grep -qxF -f - <(echo "$all"); then
            echo "This runs inside Pi Pocket, which it must stop: run it in Terminal, outside Pi Pocket." >&2

            return 2
        fi

        # shellcheck disable=SC2086
        before="$(pp_started $all)"
        roots="$(echo $apps)"

        for pid in $nodes; do
            parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"

            if ! echo "$nodes" | grep -qx -- "$parent"; then
                roots="$roots $pid"
            fi
        done

        if [ -n "$roots" ]; then
            # shellcheck disable=SC2086
            kill -TERM $roots 2>/dev/null
        fi

        # The launcher waits up to 10 seconds for its server.
        for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
            if [ -z "$(pp_node_pids)$(pp_app_pids)" ]; then
                break
            fi

            sleep 1
        done

        for pid in $all; do
            # An installer command run from a session must finish the install that stops Pi Pocket.
            if [ "$(ps -o comm= -p "$pid" 2>/dev/null)" = /usr/sbin/installer ]; then
                continue
            fi

            if echo "$before" | grep -qxF -- "$(pp_started "$pid")"; then
                kill -KILL "$pid" 2>/dev/null
            fi
        done

        sleep 1
    done

    ! pi_pocket_running
}
