#!/usr/bin/env bash
# Self-contained runner for scripts/e2e-ssh-engine.mjs.
#
# Builds throwaway fixtures (CA + user keys), starts three disposable sshd
# containers, runs the engine e2e against them, and always cleans up:
#
#   A  cert/plain/password host  — trusts an ed25519 CA and an RSA CA,
#      authorizes the plain user key, password auth on
#   B  "both" host               — AuthenticationMethods publickey,password
#   C  rsa-sha2-256-only host    — trusts the RSA CA, PubkeyAcceptedAlgorithms
#      rsa-sha2-256-cert-v01@openssh.com (proves 256 negotiation)
#
# Usage: npm run test:e2e:ssh   (requires docker + ssh-keygen)
set -euo pipefail

IMAGE="lscr.io/linuxserver/openssh-server:latest"
E2E_USER="deploy"
E2E_PASSWORD="E2ePass!2026"
PREFIX="shellius-e2e-$$"
HERE="$(cd "$(dirname "$0")" && pwd)"

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

FIX="$(mktemp -d)"
chmod 700 "$FIX"
CONTAINERS=()
cleanup() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  rm -rf "$FIX"
}
trap cleanup EXIT

echo "[e2e-ssh] generating fixture keys in $FIX"
ssh-keygen -q -t ed25519 -N '' -C e2e-ca -f "$FIX/ca_key"
ssh-keygen -q -t rsa -b 3072 -N '' -C e2e-rsa-ca -f "$FIX/rsa_ca_key"
ssh-keygen -q -t ed25519 -N '' -C e2e-user -f "$FIX/user_key"
ssh-keygen -q -t rsa -b 3072 -N '' -C e2e-rsa-user -f "$FIX/rsa_user_key"
for bits in 256 384 521; do
  ssh-keygen -q -t ecdsa -b "$bits" -N '' -C "e2e-ecdsa-$bits" -f "$FIX/ecdsa_${bits}_key"
done
cat "$FIX/ca_key.pub" "$FIX/rsa_ca_key.pub" > "$FIX/trusted_cas.pub"

# start <name> <port> <sshd_config lines...>
start() {
  local name="$1" port="$2"; shift 2
  local cname="$PREFIX-$name"
  docker run -d --name "$cname" -p "127.0.0.1:$port:2222" \
    -e USER_NAME="$E2E_USER" -e PASSWORD_ACCESS=true -e USER_PASSWORD="$E2E_PASSWORD" \
    -e PUBLIC_KEY="$(cat "$FIX/user_key.pub")" \
    "$IMAGE" >/dev/null
  CONTAINERS+=("$cname")
  # Wait for the image to generate its sshd_config, then append ours.
  for _ in $(seq 1 60); do
    docker exec "$cname" test -f /config/sshd/sshd_config 2>/dev/null && break
    sleep 1
  done
  docker cp "$FIX/trusted_cas.pub" "$cname:/config/trusted_cas.pub"
  docker cp "$FIX/rsa_ca_key.pub" "$cname:/config/rsa_ca.pub"
  for line in "$@"; do
    docker exec "$cname" sh -c "printf '%s\n' '$line' >> /config/sshd/sshd_config"
  done
  docker restart "$cname" >/dev/null
}

wait_ssh() {
  local port="$1"
  for _ in $(seq 1 60); do
    if ssh-keyscan -T 2 -p "$port" 127.0.0.1 >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "[e2e-ssh] sshd on :$port did not come up" >&2
  return 1
}

PORT_A="$(free_port)"; PORT_B="$(free_port)"; PORT_C="$(free_port)"
echo "[e2e-ssh] starting sshd containers on :$PORT_A :$PORT_B :$PORT_C"
start cert "$PORT_A" "TrustedUserCAKeys /config/trusted_cas.pub"
start both "$PORT_B" "AuthenticationMethods publickey,password"
start rsa256 "$PORT_C" "TrustedUserCAKeys /config/rsa_ca.pub" "PubkeyAcceptedAlgorithms rsa-sha2-256-cert-v01@openssh.com"
wait_ssh "$PORT_A"; wait_ssh "$PORT_B"; wait_ssh "$PORT_C"

SSH_E2E_PORT="$PORT_A" SSH_E2E_BOTH_PORT="$PORT_B" SSH_E2E_CERT256_PORT="$PORT_C" \
SSH_E2E_USER="$E2E_USER" SSH_E2E_PASSWORD="$E2E_PASSWORD" SSH_E2E_FIXTURE_DIR="$FIX" \
  node "$HERE/e2e-ssh-engine.mjs"
