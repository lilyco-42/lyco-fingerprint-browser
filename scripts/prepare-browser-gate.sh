#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
test "$(id -u)" -ne 0
work="${RUNNER_TEMP:?}/lyco-real-browser-gate"
mkdir -p "$work/apt/partial" "$work/libs"
archive="$work/chrome-headless-shell.zip"
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 240 --retry 2 \
  https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-headless-shell-linux64.zip \
  --output "$archive"
printf '%s  %s\n' '0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa' "$archive" | sha256sum --check --status
python3 - "$archive" "$work" <<'PY'
import pathlib, sys, zipfile
destination = pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        (destination / entry.filename).resolve().relative_to(destination)
    archive.extractall(destination)
    for entry in archive.infolist():
        if not entry.is_dir() and (entry.external_attr >> 16) & 0o111:
            (destination / entry.filename).chmod(0o700)
PY
browser="$work/chrome-headless-shell-linux64/chrome-headless-shell"
chmod 0700 "$browser"

# Standard hosted runners often have all linked libraries already. Resolve
# private dependencies only when needed; never replace the pinned browser.
ldd "$browser" > "$work/host-linked-libraries.txt" || true
if grep -q 'not found' "$work/host-linked-libraries.txt"; then
# Resolve/download trusted Debian/Ubuntu packages only. No package installation,
# maintainer scripts, system library updates, apt index changes or sudo.
apt-get --download-only --no-install-recommends -y \
  -o Debug::NoLocking=1 -o "Dir::Cache::archives=$work/apt" \
  -o "Dir::Cache::pkgcache=$work/apt/pkgcache.bin" -o "Dir::Cache::srcpkgcache=$work/apt/srcpkgcache.bin" \
  install libatk1.0-0 libatk-bridge2.0-0 libcups2 libasound2 libgbm1 \
  libpango-1.0-0 libcairo2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0
find "$work/apt" -maxdepth 1 -name '*.deb' -type f -print0 |
  while IFS= read -r -d '' package; do dpkg-deb --extract "$package" "$work/libs"; done
fi
# Refuse an implicit libc replacement in the private loader path.
test ! -e "$work/libs/lib/x86_64-linux-gnu/libc.so.6"
test ! -e "$work/libs/usr/lib/x86_64-linux-gnu/libc.so.6"
libraries="$work/libs/usr/lib/x86_64-linux-gnu:$work/libs/lib/x86_64-linux-gnu"
LD_LIBRARY_PATH="$libraries" ldd "$browser" > "$work/linked-libraries.txt"
if grep -q 'not found' "$work/linked-libraries.txt"; then
  cat "$work/linked-libraries.txt"
  exit 1
fi
sha256sum "$archive" "$browser" > "$work/browser-sha256.txt"
find "$work/apt" -maxdepth 1 -name '*.deb' -type f -exec sha256sum {} + > "$work/dependency-sha256.txt"
printf 'LYCO_BROWSER_EXE=%s\nLYCO_BROWSER_LIBS=%s\n' "$browser" "$libraries" >> "${GITHUB_ENV:?}"
cat "$work/browser-sha256.txt"
