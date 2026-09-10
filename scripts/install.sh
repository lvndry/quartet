#!/usr/bin/env bash
#
# Quartet installer.
#
#   curl -fsSL https://github.com/lvndry/quartet/releases/latest/download/install.sh | bash
#
# Installs the quartet binary and, under the hood, the jazz binary into the same
# directory. Join stays a separate step: run `quartet connect` (or
# `quartet connect --hub …`) afterwards. This does not start a daemon and does
# not run `jazz daemon install`.
#
# Environment variables:
#   QUARTET_INSTALL_DIR   Directory to install into (default: $HOME/.local/bin)
#   QUARTET_VERSION       Quartet version to install, e.g. v0.2.0 (default: latest)
#   JAZZ_VERSION          Jazz version to install, e.g. v0.13.12 (default: latest)
#   QUARTET_SKIP_JAZZ     Set to 1 to install quartet only (escape hatch)

set -euo pipefail

REPO="lvndry/quartet"
JAZZ_REPO="lvndry/jazz"
INSTALL_DIR="${QUARTET_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${QUARTET_VERSION:-latest}"

# Global so the EXIT trap can still see it once main() has returned and its locals are gone.
tmp=""
trap 'rm -rf "$tmp"' EXIT

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

info() { printf '%s\n' "$1"; }
success() { printf '%s%s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$1" "$RESET"; }
fail() {
  printf '%s%s%s\n' "$RED" "$1" "$RESET" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "This installer needs '$1', which is not on your PATH."
}

# Picks the release asset for this machine.
#
# Bun's glibc binaries do not run on musl systems, so Alpine and friends get their own asset;
# the loader in /lib is what distinguishes them.
detect_asset() {
  local os arch libc=""
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "Unsupported architecture: $arch. Install from npm instead: npm install -g quartet-ai" ;;
  esac

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)
      os="linux"
      if [ -f /lib/ld-musl-x86_64.so.1 ] || [ -f /lib/ld-musl-aarch64.so.1 ] || [ -f /etc/alpine-release ]; then
        libc="-musl"
      fi
      ;;
    *) fail "Unsupported operating system: $os. Install from npm instead: npm install -g quartet-ai" ;;
  esac

  printf 'quartet-%s-%s%s' "$os" "$arch" "$libc"
}

# Verifies a downloaded file against the release SHA256SUMS.
#
# An installer that pipes a remote file straight into a directory on PATH has to check what it
# got, and a missing checksum is treated as failure rather than skipped: a release without one
# is a broken release, not an unverifiable file.
verify_checksum() {
  local file="$1" name="$2" sums="$3" expected actual

  expected="$(awk -v target="$name" '$2 == target || $2 == "*" target { print $1 }' "$sums" | head -n 1)"
  [ -n "$expected" ] || fail "Release has no checksum for $name — refusing to install."

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    fail "This installer needs 'sha256sum' or 'shasum' to verify the download."
  fi

  [ "$expected" = "$actual" ] || fail "Checksum mismatch for $name — refusing to install."
}

# Jazz is what answers turns. Quartet without it cannot connect, so a normal install
# fetches jazz's own installer and points it at the same directory. That keeps checksums
# and asset names owned by the jazz release, rather than duplicated here.
#
# Does not start the daemon and does not install a system service — `quartet connect`
# starts jazz for the session when nothing is listening.
install_jazz() {
  if [ "${QUARTET_SKIP_JAZZ:-}" = "1" ]; then
    warn "Skipping jazz (QUARTET_SKIP_JAZZ=1)."
    return 0
  fi

  local jazz_installer
  jazz_installer="$tmp/jazz-install.sh"

  info "Installing ${BOLD}jazz${RESET} into ${INSTALL_DIR}..."
  curl -fsSL --retry 3 -o "$jazz_installer" \
    "https://github.com/$JAZZ_REPO/releases/latest/download/install.sh" ||
    fail "Could not download the jazz installer from github.com/$JAZZ_REPO. Set QUARTET_SKIP_JAZZ=1 to install quartet alone, then install jazz yourself."

  # Same dir as quartet so one PATH entry covers both. JAZZ_VERSION passes through if set.
  if ! JAZZ_INSTALL_DIR="$INSTALL_DIR" bash "$jazz_installer"; then
    fail "Jazz install failed. Quartet needs jazz next to it — fix that, or set QUARTET_SKIP_JAZZ=1 and install jazz yourself."
  fi

  if [ ! -x "$INSTALL_DIR/jazz" ]; then
    fail "Jazz installer finished but $INSTALL_DIR/jazz is missing. Install jazz yourself, then re-run."
  fi
}

main() {
  require curl
  require gzip
  require uname

  local asset base
  asset="$(detect_asset)"

  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$VERSION"
  fi

  tmp="$(mktemp -d)"

  info "Downloading ${BOLD}${asset}${RESET} (${VERSION})..."
  curl -fsSL --retry 3 -o "$tmp/$asset.gz" "$base/$asset.gz" ||
    fail "Could not download $base/$asset.gz"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "Could not download $base/SHA256SUMS"

  verify_checksum "$tmp/$asset.gz" "$asset.gz" "$tmp/SHA256SUMS"

  gzip -dc "$tmp/$asset.gz" >"$tmp/quartet" || fail "Could not decompress $asset.gz"
  chmod 755 "$tmp/quartet"

  mkdir -p "$INSTALL_DIR" || fail "Could not create $INSTALL_DIR"
  # Move into place rather than writing over the target: rename is atomic, and it is the only
  # way to replace a binary that is currently running.
  mv -f "$tmp/quartet" "$INSTALL_DIR/quartet" ||
    fail "Could not write to $INSTALL_DIR. Choose another directory with QUARTET_INSTALL_DIR."

  success "Quartet installed to $INSTALL_DIR/quartet"

  install_jazz

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      warn "$INSTALL_DIR is not on your PATH. Add it with:"
      info "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
      ;;
  esac

  info ""
  info "Next: ${BOLD}quartet connect${RESET} to join a hub, or ${BOLD}quartet hub --name <name>${RESET} to run one."
  info "Connect will start the jazz daemon for the session if it is not already up."
}

main "$@"
