#!/usr/bin/env bash
#
# e2e-ssh-targets.sh — start/stop the throwaway SSH hosts the Playwright
# terminal suite connects to (docker-compose.dev.yml, profile `e2e`).
#
#   ./scripts/e2e-ssh-targets.sh up     # build + start, wait for sshd
#   ./scripts/e2e-ssh-targets.sh down   # remove them
#   ./scripts/e2e-ssh-targets.sh ip     # print each container's address
#
# `up` exists mostly to create ./data/e2e-ssh BEFORE Docker does. It is bind
# mounted into all three containers, and a bind mount whose host path is
# missing is created by the daemon as root — which the setup script (running
# as you) then cannot write the public key into.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO/docker-compose.dev.yml" --profile e2e)
HOSTS=(ssh-alpha ssh-bravo ssh-charlie)

container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "$(${COMPOSE[@]} ps -q "$1")" 2>/dev/null
}

case "${1:-up}" in
  up)
    mkdir -p "$REPO/data/e2e-ssh"
    "${COMPOSE[@]}" up -d --build "${HOSTS[@]}"

    # Wait for sshd to answer on each box rather than assuming it has, so a
    # failure here reads as "the container never came up" instead of as a
    # mysterious connect timeout inside a browser test 60 seconds later.
    for host in "${HOSTS[@]}"; do
      ip="$(container_ip "$host")"
      [ -n "$ip" ] || { echo "no address for $host — did it start?" >&2; exit 1; }
      for _ in $(seq 1 30); do
        if docker run --rm --network host busybox:1.36 sh -c "nc -z -w 2 $ip 22" 2>/dev/null; then
          echo "$host  $ip:22  ready"
          break
        fi
        sleep 1
      done
    done
    echo
    echo "next: (cd backend && node scripts/e2e-ssh-setup.mjs)"
    ;;
  down)
    "${COMPOSE[@]}" rm -sf "${HOSTS[@]}"
    ;;
  ip)
    for host in "${HOSTS[@]}"; do echo "$host  $(container_ip "$host")"; done
    ;;
  *)
    echo "usage: $0 [up|down|ip]" >&2
    exit 2
    ;;
esac
