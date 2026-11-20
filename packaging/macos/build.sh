#!/bin/bash
# Builds Pi-Pocket-<version>.pkg on macOS (pkgbuild and productbuild, from Xcode's command line tools). It downloads
# the pinned Node.js tarballs for arm64 and x64, checks each against the SHA256 below, and joins their two node
# executables into one universal file with lipo: one package for both kinds of Mac, with the official code in each half.
# The workflows run it (.github/workflows/macos*.yml).
#
#   packaging/macos/build.sh <version> [out folder] [--package <pi-pocket .tgz>]
#
# --package puts that tarball in the package, to install instead of pi-pocket@<version> from npm (the macOS CI job
# packs one from its checkout). The package is unsigned: the workflow signs it when it has the secrets.
set -euo pipefail

# To move to another Node.js, take the darwin-arm64.tar.xz and darwin-x64.tar.xz lines of
# https://nodejs.org/dist/v<version>/SHASUMS256.txt.
NODE_VERSION="26.13.1"
NODE_SHA256_ARM64="af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559"
NODE_SHA256_X64="2693310b2820f9350d29524f21344e1c623875bab773457d55b2aceb9670716f"

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
version=""
out="$here/out"
package=""

while [ $# -gt 0 ]; do
    case "$1" in
        --package)
            package="$2"
            shift 2
            ;;
        *)
            if [ -z "$version" ]; then
                version="$1"
            else
                out="$1"
            fi

            shift
            ;;
    esac
done

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "Version '$version' is not a version such as 0.29.0 or 0.30.0-beta.1" >&2
    exit 1
fi

if [ -n "$package" ] && [[ ! "$package" =~ \.tgz$ || ! -f "$package" ]]; then
    echo "--package $package is not a .tgz file" >&2
    exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/pi-pocket-pkg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"

download() {
    local url="$1" file="$2" sha256="$3" actual

    echo "Downloading $url"
    curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 -o "$file" "$url"
    actual="$(shasum -a 256 "$file" | cut -d ' ' -f 1)"

    if [ "$actual" != "$sha256" ]; then
        echo "SHA256 of $url is $actual, not the pinned $sha256" >&2
        exit 1
    fi

    echo "SHA256 matches: $actual"
}

for arch in arm64 x64; do
    name="node-v$NODE_VERSION-darwin-$arch"
    sha256="$NODE_SHA256_ARM64"

    if [ "$arch" = x64 ]; then
        sha256="$NODE_SHA256_X64"
    fi

    download "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" "$work/$name.tar.xz" "$sha256"
    mkdir "$work/$arch"
    tar -xJf "$work/$name.tar.xz" -C "$work/$arch"
    mv "$work/$arch/$name" "$work/$arch/node"
done

# The two trees must differ only in the executable and in the build settings of the headers, which keep the arm64
# ones (node-gyp reads them only with --nodedir).
differ="$(diff -rq "$work/arm64/node" "$work/x64/node" | sed "s|$work/||g" || true)"
expected="Files arm64/node/bin/node and x64/node/bin/node differ
Files arm64/node/include/node/config.gypi and x64/node/include/node/config.gypi differ"

if [ "$differ" != "$expected" ]; then
    echo "The arm64 and x64 Node.js trees differ in more than bin/node:" >&2
    echo "$differ" >&2
    exit 1
fi

node_dir="$work/arm64/node"
lipo -create "$work/arm64/node/bin/node" "$work/x64/node/bin/node" -output "$work/node-universal"

# Each half must be the official file, byte for byte, with its signature.
for arch in arm64 x86_64; do
    official="$work/x64/node/bin/node"

    if [ "$arch" = arm64 ]; then
        official="$work/arm64/node/bin/node"
    fi

    lipo -thin "$arch" "$work/node-universal" -output "$work/node-$arch"
    cmp "$work/node-$arch" "$official"
done

codesign --verify --strict --all-architectures --verbose=2 "$work/node-universal"
mv -f "$work/node-universal" "$node_dir/bin/node"
chmod 755 "$node_dir/bin/node"
lipo -info "$node_dir/bin/node"

# The payload: the folder ~/Library/Application Support/Pi Pocket.
root="$work/root"
mkdir -p "$root"
mv "$node_dir" "$root/node"
cp "$here/pi-pocket" "$here/Pi Pocket.command" "$here/install-app.mjs" "$here/stop-pi-pocket.sh" \
    "$here/login-item.sh" "$here/uninstall.sh" "$root/"
chmod 755 "$root/pi-pocket" "$root/Pi Pocket.command" "$root/login-item.sh" "$root/uninstall.sh"
spec="pi-pocket@$version"

if [ -n "$package" ]; then
    cp "$package" "$root/"
    spec="./$(basename "$package")"
fi

# The app's icon, made from the web app's.
iconset="$work/pi-pocket.iconset"
mkdir "$iconset"

for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$repo/web/icon-512.png" --out "$iconset/icon_${size}x${size}.png" > /dev/null

    if [ "$size" -le 256 ]; then
        sips -z $((size * 2)) $((size * 2)) "$repo/web/icon-512.png" --out "$iconset/icon_${size}x${size}@2x.png" \
            > /dev/null
    fi
done

iconutil --convert icns --output "$work/pi-pocket.icns" "$iconset"

# Pi Pocket.app: the desktop app (app/main.swift), for arm64 and x86_64 in one file. Signed ad hoc, as Apple silicon
# needs, or with APP_SIGN_IDENTITY (a "Developer ID Application" identity in the keychain search list) and the hardened
# runtime, which notarization needs.
bundle="$root/Pi Pocket.app/Contents"
mkdir -p "$bundle/MacOS" "$bundle/Resources"
sed -e "s/@VERSION@/$version/g" -e "s/@BUNDLE_VERSION@/${version%%-*}/g" "$here/Info.plist" > "$bundle/Info.plist"
plutil -lint "$bundle/Info.plist"
sed -e "s/^let appVersion = \"0.0.0-dev\"/let appVersion = \"$version\"/" "$here/app/main.swift" > "$work/main.swift"
grep -q "^let appVersion = \"$version\"" "$work/main.swift"

for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos13.5" -framework Cocoa -framework WebKit \
        -framework UserNotifications -o "$work/app-$arch" "$work/main.swift"
done

lipo -create "$work/app-arm64" "$work/app-x86_64" -output "$bundle/MacOS/Pi Pocket"
chmod 755 "$bundle/MacOS/Pi Pocket"
lipo -info "$bundle/MacOS/Pi Pocket"
cp "$work/pi-pocket.icns" "$bundle/Resources/pi-pocket.icns"
if [ -n "${APP_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$APP_SIGN_IDENTITY" --options runtime --timestamp "$root/Pi Pocket.app"
else
    codesign --force --sign - --timestamp=none "$root/Pi Pocket.app"
fi

codesign --verify --strict --all-architectures --verbose=2 "$root/Pi Pocket.app"

# Pi Pocket (console).app: a shell script that opens the launcher in Terminal, for access modes, tunnels, and the
# sign-in QR code.
console="$root/Pi Pocket (console).app/Contents"
mkdir -p "$console/MacOS" "$console/Resources"
cp "$bundle/Info.plist" "$console/Info.plist"
plutil -replace CFBundleIdentifier -string io.github.tannermidd.pi-pocket.console "$console/Info.plist"
plutil -replace CFBundleName -string "Pi Pocket (console)" "$console/Info.plist"
plutil -replace CFBundleDisplayName -string "Pi Pocket (console)" "$console/Info.plist"
plutil -replace CFBundleExecutable -string "Pi Pocket (console)" "$console/Info.plist"
plutil -remove NSAppTransportSecurity "$console/Info.plist"
plutil -insert LSUIElement -bool true "$console/Info.plist"
plutil -lint "$console/Info.plist"
cp "$here/app-executable" "$console/MacOS/Pi Pocket (console)"
chmod 755 "$console/MacOS/Pi Pocket (console)"
cp "$work/pi-pocket.icns" "$console/Resources/pi-pocket.icns"

# The package scripts, with the version and the spec in place.
scripts="$work/scripts"
cp -R "$here/scripts" "$scripts"
cp "$here/stop-pi-pocket.sh" "$scripts/app/"
sed -i '' -e "s|@VERSION@|$version|g" -e "s|@PACKAGE@|$spec|g" "$scripts/app/postinstall"
chmod 755 "$scripts/app/preinstall" "$scripts/app/postinstall" "$scripts/login/postinstall"

# The two apps must stay where the payload puts them: the installer would otherwise move them onto older copies that it
# finds elsewhere, such as ~/Applications.
pkgbuild --analyze --root "$root" "$work/components.plist"
index=0

while plutil -extract "$index" xml1 -o /dev/null "$work/components.plist" 2> /dev/null; do
    plutil -replace "$index.BundleIsRelocatable" -bool false "$work/components.plist"
    index=$((index + 1))
done

if [ "$index" = 0 ]; then
    echo "pkgbuild found no Pi Pocket.app in the payload" >&2
    exit 1
fi

packages="$work/packages"
mkdir "$packages"
pkgbuild --root "$root" --component-plist "$work/components.plist" --scripts "$scripts/app" \
    --compression latest --min-os-version 13.5 \
    --identifier io.github.tannermidd.pi-pocket --version "$version" \
    --install-location "/Library/Application Support/Pi Pocket" "$packages/pi-pocket-app.pkg"
pkgbuild --nopayload --scripts "$scripts/login" --identifier io.github.tannermidd.pi-pocket.login \
    --version "$version" "$packages/pi-pocket-login.pkg"

resources="$work/resources"
cp -R "$here/resources" "$resources"
cp "$repo/LICENSE" "$resources/LICENSE.txt"
sed -e "s/@VERSION@/$version/g" "$here/distribution.xml" > "$work/distribution.xml"
product="$out/Pi-Pocket-$version.pkg"
productbuild --distribution "$work/distribution.xml" --resources "$resources" --package-path "$packages" "$product"

echo "Built $product ($(du -h "$product" | cut -f 1))"
echo "SHA256 $(shasum -a 256 "$product" | cut -d ' ' -f 1)"
