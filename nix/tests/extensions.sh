set -euo pipefail

manager=$1
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
directory="$root/extensions"
manifest="$directory/.nix-managed-extensions"

manage() {
    bash "$manager" "$directory" "$@"
}

refuse() {
    if manage "$@"; then
        echo "Expected extension reconciliation to fail" >&2
        exit 1
    fi
}

printf 'declared v1\n' > "$root/v1.ts"
printf 'declared v2\n' > "$root/v2.ts"
mkdir "$directory"
printf 'owner edit\n' > "$directory/owner.ts"
cp "$directory/owner.ts" "$root/owner-saved.ts"
ln -s "$root/owner-saved.ts" "$directory/owner-link.ts"
mkdir "$directory/owner-assets"
printf 'asset\n' > "$directory/owner-assets/data"
ln -s "$root/owner-assets-missing" "$directory/node_modules"

# An empty initial declaration neither adopts nor deletes existing files.
manage
test ! -s "$manifest"
cmp "$directory/owner.ts" "$root/owner-saved.ts"
test -L "$directory/owner-link.ts"
test -L "$directory/node_modules"
test -f "$directory/owner-assets/data"

manage "$root/v1.ts" 'declared file.ts'
cmp "$directory/declared file.ts" "$root/v1.ts"
test "$(stat -c %a "$directory/declared file.ts")" = 600
test "$(stat -c %a "$manifest")" = 600
test "$(< "$manifest")" = 'declared file.ts'

printf 'live edit\n' > "$directory/declared file.ts"
manage "$root/v2.ts" 'declared file.ts'
cmp "$directory/declared file.ts" "$root/v2.ts"
cmp "$directory/owner.ts" "$root/owner-saved.ts"

# Check every collision before resetting any managed file or changing the manifest.
printf 'live edit\n' > "$directory/declared file.ts"
cp "$directory/declared file.ts" "$root/live-saved.ts"
cp "$manifest" "$root/manifest-saved"
refuse "$root/v1.ts" 'declared file.ts' "$root/v1.ts" owner.ts
refuse "$root/v1.ts" owner-link.ts
ln -s "$root/missing.ts" "$directory/dangling.ts"
refuse "$root/v1.ts" dangling.ts
cmp "$directory/declared file.ts" "$root/live-saved.ts"
cmp "$manifest" "$root/manifest-saved"
cmp "$directory/owner.ts" "$root/owner-saved.ts"
test -L "$directory/dangling.ts"

manage "$root/v2.ts" replacement.ts
test ! -e "$directory/declared file.ts"
cmp "$directory/replacement.ts" "$root/v2.ts"
test "$(< "$manifest")" = replacement.ts

# Managed file symlinks are unlinked, never followed during installation or removal.
rm "$directory/replacement.ts"
ln -s "$root/owner-saved.ts" "$directory/replacement.ts"
manage "$root/v1.ts" replacement.ts
test ! -L "$directory/replacement.ts"
cmp "$directory/replacement.ts" "$root/v1.ts"
cmp "$directory/owner.ts" "$root/owner-saved.ts"
rm "$directory/replacement.ts"
ln -s "$root/owner-saved.ts" "$directory/replacement.ts"
manage
test ! -L "$directory/replacement.ts"
test ! -s "$manifest"
cmp "$directory/owner.ts" "$root/owner-saved.ts"

# Do not recursively delete a directory even when its name is in the manifest.
printf 'blocked.ts\n' > "$manifest"
mkdir "$directory/blocked.ts"
printf 'keep\n' > "$directory/blocked.ts/data"
refuse
test -f "$directory/blocked.ts/data"

# Corrupt manifests must not allow cleanup outside the extensions directory.
printf '../owner-saved.ts\n' > "$manifest"
refuse
test -f "$root/owner-saved.ts"
printf '\n' > "$manifest"
refuse
: > "$manifest"
refuse "$root/v1.ts" $'bad\nname.ts'
refuse "$root/v1.ts" $'bad\rname.ts'

# Neither the manifest nor the directory may redirect management to another path.
rm "$manifest"
ln -s "$root/owner-saved.ts" "$manifest"
refuse
test -f "$root/owner-saved.ts"
mv "$directory" "$root/real-extensions"
ln -s "$root/real-extensions" "$directory"
refuse
test -f "$root/real-extensions/owner.ts"

# With no declarations, repeated starts leave owner files and dependency links intact.
rm "$directory"
mv "$root/real-extensions" "$directory"
rm "$manifest"
manage
manage
cmp "$directory/owner.ts" "$root/owner-saved.ts"
test -L "$directory/owner-link.ts"
test -L "$directory/node_modules"
test -f "$directory/owner-assets/data"
test ! -s "$manifest"

# A failed install records ownership first, allowing the next start to recover.
refuse "$root/v1.ts" first.ts "$root/nonexistent.ts" second.ts
test "$(< "$manifest")" = $'first.ts\nsecond.ts'
manage "$root/v2.ts" second.ts
test ! -e "$directory/first.ts"
cmp "$directory/second.ts" "$root/v2.ts"
cmp "$directory/owner.ts" "$root/owner-saved.ts"
test "$(< "$manifest")" = second.ts
