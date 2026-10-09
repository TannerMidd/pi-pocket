set -euo pipefail

directory=$1
shift
manifest="$directory/.nix-managed-extensions"
previous=()
sources=()
names=()

if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    echo "Pi Pocket will not manage extensions through a symlink or non-directory: $directory" >&2
    exit 1
fi

if [ -L "$manifest" ] || { [ -e "$manifest" ] && [ ! -f "$manifest" ]; }; then
    echo "Pi Pocket requires a regular extensions manifest: $manifest" >&2
    exit 1
fi

if [ -f "$manifest" ]; then
    mapfile -t previous < "$manifest"
fi

while [ "$#" -gt 0 ]; do
    sources+=("$1")
    names+=("$2")
    shift 2
done

for name in "${previous[@]}" "${names[@]}"; do
    case "$name" in
        */* | *$'\n'* | *$'\r'* | '')
            echo "Invalid managed extension filename: $name" >&2
            exit 1
            ;;
        *.ts) ;;
        *)
            echo "Invalid managed extension filename: $name" >&2
            exit 1
            ;;
    esac

    if [ -e "$directory/$name" ] && [ ! -f "$directory/$name" ] && [ ! -L "$directory/$name" ]; then
        echo "Pi Pocket will not replace an extension directory: $directory/$name" >&2
        exit 1
    fi
done

for name in "${names[@]}"; do
    if { [ -e "$directory/$name" ] || [ -L "$directory/$name" ]; } &&
        ! { [ -f "$manifest" ] && grep -Fxq -- "$name" "$manifest"; }; then
        echo "Pi Pocket will not overwrite unmanaged extension $directory/$name; move it aside before declaring it." >&2
        exit 1
    fi
done

mkdir -p -- "$directory"
temporary=$(mktemp "$directory/.nix-managed-extensions.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT

# Record both generations first, so an interrupted start leaves no untracked copies.
for name in "${previous[@]}" "${names[@]}"; do
    printf '%s\n' "$name"
done > "$temporary"
mv -f -- "$temporary" "$manifest"

for name in "${previous[@]}"; do
    rm -f -- "$directory/$name"
done

for index in "${!names[@]}"; do
    rm -f -- "$directory/${names[$index]}"
    install -m 0600 -- "${sources[$index]}" "$directory/${names[$index]}"
done

temporary=$(mktemp "$directory/.nix-managed-extensions.XXXXXX")
for name in "${names[@]}"; do
    printf '%s\n' "$name"
done > "$temporary"
mv -f -- "$temporary" "$manifest"
