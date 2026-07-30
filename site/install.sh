#!/bin/sh
set -eu

repository_api="${GLOSSA_RELEASES_API:-https://api.github.com/repos/ariobarin/glossa/releases?per_page=20}"
install_directory="${GLOSSA_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) operating_system="macos" ;;
  Linux) operating_system="linux" ;;
  *) echo "The Glossa direct installer supports macOS and Linux. Use npm on this platform." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) echo "The Glossa direct installer does not support $(uname -m). Use npm instead." >&2; exit 1 ;;
esac

asset="glossa-${operating_system}-${architecture}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
releases="$temporary_directory/releases.json"

curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: glossa-installer" \
  "$repository_api" -o "$releases"

binary_url="$(sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\\([^\"]*/${asset}\\)\".*|\\1|p" "$releases" | head -n 1)"
checksum_url="$(sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\\([^\"]*/${asset}\\.sha256\\)\".*|\\1|p" "$releases" | head -n 1)"
if [ -z "$binary_url" ] || [ -z "$checksum_url" ]; then
  echo "No Glossa direct-install release supports this computer yet. Use npm or try again after the next release." >&2
  exit 1
fi

download="$temporary_directory/$asset"
checksum_file="$temporary_directory/$asset.sha256"
curl -fsSL -H "User-Agent: glossa-installer" "$binary_url" -o "$download"
curl -fsSL -H "User-Agent: glossa-installer" "$checksum_url" -o "$checksum_file"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$checksum_file")"
if [ -z "$expected" ]; then
  echo "The Glossa checksum file was invalid." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$download" | awk '{ print tolower($1) }')"
else
  actual="$(shasum -a 256 "$download" | awk '{ print tolower($1) }')"
fi
if [ "$actual" != "$expected" ]; then
  echo "Glossa refused to install because the SHA-256 checksum did not match." >&2
  exit 1
fi

mkdir -p "$install_directory"
chmod 755 "$download"
mv "$download" "$install_directory/glossa"

case ":$PATH:" in
  *":$install_directory:"*) ;;
  *)
    shell_name="$(basename "${SHELL:-sh}")"
    if [ "$shell_name" = "zsh" ]; then
      profile="$HOME/.zshrc"
    elif [ "$shell_name" = "bash" ]; then
      profile="$HOME/.bashrc"
    else
      profile="$HOME/.profile"
    fi
    path_line='export PATH="$HOME/.local/bin:$PATH"'
    if [ "$install_directory" = "$HOME/.local/bin" ] && ! grep -F "$path_line" "$profile" >/dev/null 2>&1; then
      printf '\n%s\n' "$path_line" >> "$profile"
    fi
    ;;
esac

version="$("$install_directory/glossa" --version)"
echo "Installed Glossa $version."
echo "Next: open a new terminal in a project and run glossa."
echo "Press Ctrl+C to disconnect."
