#!/bin/sh
set -eu

INSTALL_DIR="${FAYE_INSTALL_DIR:-${HOME}/.local/bin}"
DATA_DIR="${FAYE_HOME:-${HOME}/.faye}"
PURGE=0

case "${1:-}" in
  "")
    ;;
  --purge)
    PURGE=1
    ;;
  -h|--help)
    cat <<'EOF'
Usage: uninstall.sh [--purge]

Remove the Faye executable and its installer-managed PATH entry. Configuration,
sessions, and memory under FAYE_HOME are preserved unless --purge is supplied.
EOF
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
esac

MARKER='# Added by Faye installer'

remove_path_block() {
  profile=$1
  if [ ! -f "${profile}" ] || ! grep -Fq "${MARKER}" "${profile}"; then
    return
  fi
  temporary="${profile}.faye-uninstall.$$"
  awk -v marker="${MARKER}" '
    remove_next == 1 { remove_next = 0; next }
    $0 == marker { remove_next = 1; next }
    { print }
  ' "${profile}" >"${temporary}"
  cat "${temporary}" >"${profile}"
  rm -f "${temporary}"
  echo "Removed PATH entry from ${profile}"
}

remove_path_block "${HOME}/.bashrc"
remove_path_block "${HOME}/.profile"
if [ -f "${HOME}/.bash_profile" ]; then
  remove_path_block "${HOME}/.bash_profile"
fi
if [ -n "${ZDOTDIR:-}" ]; then
  remove_path_block "${ZDOTDIR}/.zshrc"
else
  remove_path_block "${HOME}/.zshrc"
fi

if [ -e "${INSTALL_DIR}/faye" ]; then
  rm -f "${INSTALL_DIR}/faye"
  echo "Removed: ${INSTALL_DIR}/faye"
else
  echo "Faye executable was not installed in ${INSTALL_DIR}"
fi
rmdir "${INSTALL_DIR}" 2>/dev/null || true

if [ "${PURGE}" -eq 1 ]; then
  case "${DATA_DIR}" in
    ""|"/"|"${HOME}")
      echo "Refusing to remove unsafe data directory: ${DATA_DIR}" >&2
      exit 1
      ;;
  esac
  if [ -d "${DATA_DIR}" ]; then
    rm -rf "${DATA_DIR}"
    echo "Removed data: ${DATA_DIR}"
  fi
else
  echo "Preserved configuration and sessions in ${DATA_DIR}"
  echo "Run with --purge to remove them."
fi

echo "Open a new terminal to refresh PATH."
