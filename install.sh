#!/usr/bin/env sh
# claude-omniroute-kit bootstrap (macOS/Linux). Passes all arguments through to the Node installer.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.22.2+ (or 24.x-26.x) is required by OmniRoute."
  echo "Install it from https://nodejs.org (or: brew install node) and run this script again."
  exit 1
fi

ok=$(node -e '
const [a,b,c]=process.versions.node.split(".").map(Number);
console.log((a===22&&(b>22||(b===22&&c>=2)))||(a>=24&&a<27)?"yes":"no")')
if [ "$ok" != "yes" ]; then
  echo "Node $(node -v) is not supported (need >=22.22.2 <23 or >=24 <27)."
  exit 1
fi

exec node "$here/installer/install.mjs" "$@"
