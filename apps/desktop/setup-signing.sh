#!/usr/bin/env bash
# Create a local self-signed code-signing identity so TCC grants survive rebuilds.
#
# Ad-hoc signing keys every permission to the binary's cdhash, which changes on every
# build — so Screen Recording and the microphone have to be re-approved each time,
# while System Settings shows a ticked "SumMeet" that no longer matches. Signing with a
# stable certificate makes the code requirement key on the certificate instead, and the
# grant sticks. Run this once; bundle.sh picks the identity up automatically.
#
# The certificate is local and self-signed. It is not Apple-notarised and does nothing
# for distribution — it exists only so a developer stops re-granting permissions.
set -euo pipefail

IDENTITY="SumMeet Dev"
KC="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ '$IDENTITY' already exists — nothing to do"
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

echo "→ importing into the login keychain"
security import "$work/ident.p12" -k "$KC" -P summeet -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KC" >/dev/null 2>&1 || true

echo "→ trusting it for code signing (macOS will ask for your login password, once)"
security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$work/cert.pem"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ '$IDENTITY' is ready. Rebuild with apps/desktop/bundle.sh and grant permissions one last time."
else
  echo "✗ the identity is still not usable for code signing — check the keychain" >&2
  exit 1
fi
