#!/bin/sh
set -eu

REPOSITORY="${FAYE_REPOSITORY:-tangsong404/tangs-toolbox}"
INSTALL_DIR="${FAYE_INSTALL_DIR:-${HOME}/.local/bin}"
VERSION="${1:-${FAYE_VERSION:-}}"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: install.sh [version]

Install the latest release by default. A version may be supplied as a bare
number or a v-prefixed tag. FAYE_INSTALL_DIR overrides the installation path.
EOF
    exit 0
    ;;
esac

case "$(uname -s)" in
  Linux)
    OS=linux
    ;;
  Darwin)
    OS=darwin
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64)
    ARCH=x86_64
    ;;
  arm64|aarch64)
    ARCH=aarch64
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

case "${OS}-${ARCH}" in
  linux-x86_64)
    TARGET=x86_64-unknown-linux-musl
    ;;
  linux-aarch64)
    TARGET=aarch64-unknown-linux-musl
    ;;
  darwin-x86_64)
    TARGET=x86_64-apple-darwin
    ;;
  darwin-aarch64)
    TARGET=aarch64-apple-darwin
    ;;
esac

ARCHIVE="faye-${TARGET}.tar.gz"
CHECKSUM="faye-${TARGET}.sha256"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT HUP INT TERM

download() {
  source_url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "${source_url}" --output "${destination}"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet "${source_url}" --output-document="${destination}"
  else
    echo "Installation requires curl or wget." >&2
    exit 1
  fi
}

if [ -n "${VERSION}" ]; then
  case "${VERSION}" in
    faye-v*) TAG="${VERSION}" ;;
    v*) TAG="faye-${VERSION}" ;;
    *) TAG="faye-v${VERSION}" ;;
  esac
else
  RELEASES="$(download "https://api.github.com/repos/${REPOSITORY}/releases?per_page=100" -)"
  TAG="$(printf '%s' "${RELEASES}" |
    tr '{},' '\n' |
    sed -n 's/.*"tag_name":[[:space:]]*"\(faye-v[^"]*\)".*/\1/p' |
    head -n 1)"
  if [ -z "${TAG}" ]; then
    echo "No Faye release was found in ${REPOSITORY}." >&2
    exit 1
  fi
fi

BASE_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}"

echo "Downloading Faye for ${OS}-${ARCH}..."
download "${BASE_URL}/${ARCHIVE}" "${TMP_DIR}/${ARCHIVE}"
download "${BASE_URL}/${CHECKSUM}" "${TMP_DIR}/${CHECKSUM}"

(
  cd "${TMP_DIR}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check "${CHECKSUM}"
  elif command -v shasum >/dev/null 2>&1; then
    shasum --algorithm 256 --check "${CHECKSUM}"
  else
    echo "Installation requires sha256sum or shasum." >&2
    exit 1
  fi
)

tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 755 "${TMP_DIR}/faye-${TARGET}/faye" "${INSTALL_DIR}/faye"

echo "Installed: ${INSTALL_DIR}/faye"

if [ "${INSTALL_DIR}" != "${HOME}/.local/bin" ]; then
  echo "Custom installation directory: add ${INSTALL_DIR} to PATH."
  exit 0
fi

if [ "${FAYE_NO_PATH_UPDATE:-0}" = "1" ]; then
  echo "PATH update disabled. Add ${INSTALL_DIR} to PATH manually."
  exit 0
fi

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
MARKER='# Added by Faye installer'
updated_profiles=""

add_profile() {
  profile=$1
  if [ -f "${profile}" ]; then
    if grep -Fq "${MARKER}" "${profile}" || grep -Fqx "${PATH_LINE}" "${profile}"; then
      return
    fi
  fi
  mkdir -p "$(dirname "${profile}")"
  if printf '\n%s\n%s\n' "${MARKER}" "${PATH_LINE}" >>"${profile}"; then
    updated_profiles="${updated_profiles} ${profile}"
  else
    echo "Could not update ${profile}; add ${INSTALL_DIR} to PATH manually." >&2
  fi
}

case "${SHELL##*/}" in
  zsh)
    add_profile "${ZDOTDIR:-${HOME}}/.zshrc"
    ;;
  bash)
    add_profile "${HOME}/.bashrc"
    add_profile "${HOME}/.profile"
    if [ -f "${HOME}/.bash_profile" ]; then
      add_profile "${HOME}/.bash_profile"
    fi
    ;;
  *)
    add_profile "${HOME}/.profile"
    ;;
esac

if [ -n "${updated_profiles}" ]; then
  echo "PATH configured in:${updated_profiles}"
else
  echo "PATH is already configured for future shells."
fi
echo "Open a new terminal, then run: faye login"
