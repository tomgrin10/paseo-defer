#!/bin/sh
set -eu

repository="tomgrin10/paseo-defer"
version="${PASEO_DEFER_VERSION:-v0.2.0}"
default_data_home="${XDG_DATA_HOME:-${HOME:?HOME must be set}/.local/share}"
install_dir="${PASEO_DEFER_DIR:-${default_data_home}/paseo-defer}"

fail() {
  printf 'paseo-defer: %s\n' "$1" >&2
  exit 1
}

for command_name in curl tar npm paseo; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

case "$version" in
  v[0-9]*) ;;
  *) fail "PASEO_DEFER_VERSION must be a tag such as v0.2.0" ;;
esac

case "$install_dir" in
  "" | / | "$HOME" | "$HOME"/) fail "refusing unsafe install directory: $install_dir" ;;
esac

if [ -e "$install_dir" ]; then
  fail "$install_dir already exists; remove it or set PASEO_DEFER_DIR"
fi

install_parent="$(dirname "$install_dir")"
install_name="$(basename "$install_dir")"
mkdir -p "$install_parent"
install_parent="$(cd "$install_parent" && pwd -P)"
install_dir="${install_parent}/${install_name}"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/paseo-defer.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM

archive="$temporary_dir/paseo-defer.tar.gz"
source_dir="$temporary_dir/source"
archive_url="${PASEO_DEFER_ARCHIVE_URL:-https://github.com/${repository}/archive/refs/tags/${version}.tar.gz}"

printf 'Downloading paseo-defer %s...\n' "$version"
curl -fsSL "$archive_url" -o "$archive"
mkdir "$source_dir"
tar -xzf "$archive" -C "$source_dir" --strip-components=1

(
  cd "$source_dir"
  npm ci
  npm run verify
)

mv "$source_dir" "$install_dir"
paseo plugin install "$install_dir"
paseo plugin ls

printf '\npaseo-defer %s installed in %s\n' "$version" "$install_dir"
printf 'If plugins are disabled, enable them in Paseo Settings -> Plugins.\n'
