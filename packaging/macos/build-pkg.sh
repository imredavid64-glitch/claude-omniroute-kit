#!/bin/sh
# Builds dist/ClaudeOmniRouteSetup.pkg. Must run on macOS (needs pkgbuild).
# Usage: sh packaging/macos/build-pkg.sh [version]
#
# The package installs the kit to /usr/local/share/claude-omniroute-kit and a double-clickable
# "Claude OmniRoute Setup.command" to /Applications, then its postinstall opens that setup in the
# logged-in user's Terminal. The setup itself must run as the USER (it writes ~/.claude and ~/.omniroute),
# never as root, so the postinstall only launches it; it does not run it.
set -eu
VERSION="${1:-1.0.0}"
here="$(cd "$(dirname "$0")" && pwd)"
kit="$(cd "$here/../.." && pwd)"
out="$kit/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

command -v pkgbuild >/dev/null 2>&1 || { echo "pkgbuild not found: build this on macOS." >&2; exit 1; }
node "$kit/tools/scan-secrets.mjs" || { echo "Secret scan failed; not building." >&2; exit 1; }

share="$stage/root/usr/local/share/claude-omniroute-kit"
mkdir -p "$share" "$stage/root/Applications" "$stage/scripts" "$out"
rsync -a --exclude dist --exclude packaging --exclude .git --exclude node_modules --exclude '*.zip' "$kit/" "$share/"

cat > "$stage/root/Applications/Claude OmniRoute Setup.command" <<'EOF'
#!/bin/sh
clear
echo "Claude Code + OmniRoute setup"
echo
need_node() {
  command -v node >/dev/null 2>&1 || return 0
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit((a===22&&(b>22||(b===22&&c>=2)))||(a>=24&&a<27)?1:0)'
}
if need_node; then
  echo "OmniRoute needs Node.js 22.22.2+ (or 24-26)."
  if command -v brew >/dev/null 2>&1; then
    printf "Install it with Homebrew now? [Y/n] "; read a
    case "$a" in n|N) ;; *) brew install node ;; esac
  else
    echo "Opening https://nodejs.org - install Node.js LTS, then double-click this setup again."
    open "https://nodejs.org/en/download"
    exit 1
  fi
fi
sh /usr/local/share/claude-omniroute-kit/install.sh "$@"
echo
printf "Press Return to close. "; read _
EOF
chmod 755 "$stage/root/Applications/Claude OmniRoute Setup.command"

cat > "$stage/scripts/postinstall" <<'EOF'
#!/bin/sh
# Runs as root. Only launches the setup in the console user's Terminal.
user="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -n "$user" ] && [ "$user" != "root" ]; then
  uid="$(id -u "$user")"
  launchctl asuser "$uid" sudo -u "$user" open -a Terminal "/Applications/Claude OmniRoute Setup.command" || true
fi
exit 0
EOF
chmod 755 "$stage/scripts/postinstall"

pkgbuild --root "$stage/root" --identifier dev.omniroute.claude-kit --version "$VERSION" \
  --install-location / --scripts "$stage/scripts" "$out/ClaudeOmniRouteSetup.pkg"

# Optional signing (removes the Gatekeeper warning). Needs an Apple Developer ID Installer certificate.
if [ -n "${KIT_SIGN_IDENTITY:-}" ]; then
  productsign --sign "$KIT_SIGN_IDENTITY" "$out/ClaudeOmniRouteSetup.pkg" "$out/ClaudeOmniRouteSetup-signed.pkg"
  mv "$out/ClaudeOmniRouteSetup-signed.pkg" "$out/ClaudeOmniRouteSetup.pkg"
fi
echo "Built $out/ClaudeOmniRouteSetup.pkg"
echo "Unsigned packages: right-click > Open the first time (Gatekeeper)."
