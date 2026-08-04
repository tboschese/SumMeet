#!/usr/bin/env bash
# Create a local self-signed code-signing identity in a *dedicated* keychain so TCC
# grants survive rebuilds AND signing never needs the login keychain unlocked.
#
# Ad-hoc signing keys every permission to the binary's cdhash, which changes each build,
# so Screen Recording and the microphone are re-approved every time. A stable certificate
# fixes that — but if it lives in the login keychain, macOS locks that keychain on sleep
# and codesign then fails (errSecInternalComponent) until someone unlocks it by hand.
#
# So the identity lives in its own keychain with a known password. bundle.sh unlocks it
# non-interactively before signing. The password has no security value: the cert is local,
# self-signed, not notarised, and does nothing for distribution — it exists only so a
# developer stops re-granting permissions and re-unlocking keychains. Shipping to other
# machines still needs a real Apple Developer ID.
set -euo pipefail

IDENTITY="SumMeet Dev"
KEYCHAIN="$HOME/Library/Keychains/summeet-signing.keychain-db"
KEYCHAIN_PASSWORD="summeet-local-signing"

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ '$IDENTITY' already in the dedicated keychain — nothing to do"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/cfg.conf" <<'CONF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = SumMeet Dev
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CONF

echo "→ generating a self-signed code-signing certificate (valid 10 years)"
openssl req -x509 -newkey rsa:2048 -keyout "$work/key.pem" -out "$work/cert.pem" \
  -days 3650 -nodes -config "$work/cfg.conf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/ident.p12" -name "$IDENTITY" -passout pass:summeet >/dev/null 2>&1

echo "→ creating the dedicated signing keychain"
# Recreate it fresh so re-running is idempotent. Its password is fixed (see the header).
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"  # no auto-lock timeout
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

# Add it to the search list so find-identity / codesign see it, without dropping the
# others.
existing="$(security list-keychains -d user | sed 's/[[:space:]]*"//g' | sed 's/"//g')"
security list-keychains -d user -s "$KEYCHAIN" $existing >/dev/null

echo "→ importing the identity"
security import "$work/ident.p12" -k "$KEYCHAIN" -P summeet -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 || true

echo "→ trusting it for code signing (macOS will ask for your login password, once)"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem"

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ '$IDENTITY' is ready in its own keychain. Rebuild with apps/desktop/bundle.sh —"
  echo "  it unlocks this keychain itself, so no keychain ever blocks a build again."
else
  echo "✗ the identity is still not usable for code signing — check the keychain" >&2
  exit 1
fi
