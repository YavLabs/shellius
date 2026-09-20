#!/usr/bin/env bash
#
# Fixture harness for shellius-posture-scan.sh.
#
# Stubs ss / ufw / docker on PATH so the correlation logic can be exercised
# against synthetic hosts — no server, no root, no Docker required. This is how
# we iterate on the finding taxonomy before any of it touches the agent.
#
#   ./test/run-tests.sh          # run all scenarios
#   ./test/run-tests.sh 1        # run scenario 1 and show its full report
#
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCAN="$HERE/../shellius-posture-scan.sh"
STUBS="$HERE/stubs"
ONLY=${1:-}

PASS=0; FAIL=0
RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'

# --- scenario fixtures -----------------------------------------------------
# Each scenario sets FX_SS / FX_UFW / FX_DOCKER_PS, runs the scanner with the
# stubs first on PATH, and asserts on the emitted finding codes.

run_scan() {
  PATH="$STUBS:$PATH" FX_SS="$FX_SS" FX_UFW="$FX_UFW" FX_DOCKER_PS="$FX_DOCKER_PS" \
    bash "$SCAN" --json --no-color --unprivileged 2>/dev/null
}

assert_finding() {
  local out=$1 code=$2 want_sev=$3 label=$4
  local got
  got=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
for f in d['findings']:
    if f['code']=='$code': print(f['severity']); break
else: print('ABSENT')
" <<<"$out")
  if [[ "$got" == "$want_sev" ]]; then
    echo "  ${GRN}✓${RST} $label ${DIM}($code = $got)${RST}"; PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RST} $label ${DIM}($code: expected $want_sev, got $got)${RST}"; FAIL=$((FAIL+1))
  fi
}

assert_absent() {
  local out=$1 code=$2 label=$3
  if python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if not any(f['code']=='$code' for f in d['findings']) else 1)
" <<<"$out"; then
    echo "  ${GRN}✓${RST} $label"; PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RST} $label ${DIM}($code should not fire)${RST}"; FAIL=$((FAIL+1))
  fi
}

assert_reach() {
  local out=$1 proto=$2 port=$3 want=$4 label=$5
  local got
  got=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
r=[l['reachability'] for l in d['listeners'] if l['proto']=='$proto' and l['port']==$port]
print(r[0] if r else 'ABSENT')
" <<<"$out")
  if [[ "$got" == "$want" ]]; then
    echo "  ${GRN}✓${RST} $label ${DIM}($proto/$port = $got)${RST}"; PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RST} $label ${DIM}($proto/$port: expected $want, got $got)${RST}"; FAIL=$((FAIL+1))
  fi
}

assert_service() {
  local out=$1 port=$2 want=$3 label=$4
  local got
  got=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
r=[l['service'] for l in d['listeners'] if l['port']==$port]
print(r[0] if r else 'ABSENT')
" <<<"$out")
  if [[ "$got" == "$want" ]]; then
    echo "  ${GRN}✓${RST} $label ${DIM}(:$port -> $got)${RST}"; PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RST} $label ${DIM}(:$port expected '$want', got '$got')${RST}"; FAIL=$((FAIL+1))
  fi
}

scenario() { echo; echo "${BLD}Scenario $1:${RST} $2"; }

# Regression guard for the class of bug that silently blanked every pm2
# listener: a subshell dying under `set -u` produces stderr noise and empty
# fields, but the report still renders and looks plausible. Any unexpected
# stderr is a failure.
assert_quiet() {
  local label=$1 noise
  noise=$(PATH="$STUBS:$PATH" FX_SS="$FX_SS" FX_UFW="$FX_UFW" FX_DOCKER_PS="$FX_DOCKER_PS" \
            FX_DOCKER_WD="${FX_DOCKER_WD:-}" bash "$SCAN" --json --no-color --unprivileged 2>&1 >/dev/null \
          | grep -vE '^(collecting|correlating|warning:|         re-run)' | grep -v '^$')
  if [[ -z "$noise" ]]; then
    echo "  ${GRN}✓${RST} $label"; PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RST} $label ${DIM}(stderr: $(head -2 <<<"$noise" | tr '\n' ' '))${RST}"; FAIL=$((FAIL+1))
  fi
}

# ===========================================================================
# 1. The headline case: Docker publishes Postgres, ufw explicitly denies it,
#    and the deny is silently ineffective because DNAT skips the INPUT chain.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 1 ]]; then
scenario 1 "Docker -p 5432 with an explicit 'ufw deny 5432' (the classic footgun)"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))
tcp   LISTEN 0      4096   0.0.0.0:5432      0.0.0.0:*     users:(("docker-proxy",pid=1500,fd=4))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
5432/tcp                   DENY IN     Anywhere'
FX_DOCKER_PS='abc123def456	pg-main	postgres:16-alpine	0.0.0.0:5432->5432/tcp'
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_finding "$OUT" DOCKER_FIREWALL_BYPASS CRITICAL "ufw bypass is flagged CRITICAL"
assert_reach   "$OUT" tcp 5432 INTERNET "port 5432 is INTERNET despite the deny rule"
assert_finding "$OUT" EXPECTED_PUBLIC INFO "SSH on :22 stays INFO"
[[ -n "$ONLY" ]] && { PATH="$STUBS:$PATH" FX_SS="$FX_SS" FX_UFW="$FX_UFW" FX_DOCKER_PS="$FX_DOCKER_PS" bash "$SCAN" --all --unprivileged; }
fi

# ===========================================================================
# 2. Remapped ports: Postgres on 5433, Redis on 6380. A port-number-only
#    scanner reports these as "unknown service on a high port".
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 2 ]]; then
scenario 2 "Non-standard host ports still resolve to the real service"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere'
FX_DOCKER_PS='aaa111bbb222	db	postgres:16-alpine	0.0.0.0:5433->5432/tcp
ccc333ddd444	cache	redis:7-alpine	0.0.0.0:6380->6379/tcp'
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_service "$OUT" 5433 "PostgreSQL" "5433 identified via container port"
assert_service "$OUT" 6380 "Redis"      "6380 identified via container port"
assert_finding "$OUT" DOCKER_FIREWALL_BYPASS CRITICAL "both are flagged as bypassing ufw"
[[ -n "$ONLY" ]] && { PATH="$STUBS:$PATH" FX_SS="$FX_SS" FX_UFW="$FX_UFW" FX_DOCKER_PS="$FX_DOCKER_PS" bash "$SCAN" --all --unprivileged; }
fi

# ===========================================================================
# 3. Correctly-bound Docker: published to 127.0.0.1 only. Must be silent.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 3 ]]; then
scenario 3 "Docker published to 127.0.0.1 — the correct pattern, must not warn"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere'
FX_DOCKER_PS='eee555fff666	db	postgres:16-alpine	127.0.0.1:5432->5432/tcp'
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_reach   "$OUT" tcp 5432 LOOPBACK "loopback-published port is LOOPBACK"
assert_absent  "$OUT" DOCKER_FIREWALL_BYPASS "no bypass finding for a loopback publish"
assert_absent  "$OUT" SENSITIVE_PORT_EXPOSED "no exposure finding for a loopback publish"
fi

# ===========================================================================
# 4. Native service on a wildcard bind, saved only by a firewall rule.
#    Not an incident, but one `ufw disable` away from one.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 4 ]]; then
scenario 4 "Native Postgres on 0.0.0.0, firewall denies — fragile, not critical"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))
tcp   LISTEN 0      244    0.0.0.0:5432      0.0.0.0:*     users:(("postgres",pid=900,fd=5))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere'
FX_DOCKER_PS=''
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_reach   "$OUT" tcp 5432 FIREWALLED "default-deny makes it FIREWALLED"
assert_service "$OUT" 5432 "PostgreSQL" "identified from the process name"
assert_finding "$OUT" SENSITIVE_PORT_WILDCARD_BIND MEDIUM "flagged MEDIUM, not CRITICAL"
fi

# ===========================================================================
# 5. Same service, but the firewall explicitly allows it from anywhere.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 5 ]]; then
scenario 5 "Native Postgres on 0.0.0.0 with 'ufw allow 5432' — genuinely exposed"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))
tcp   LISTEN 0      244    0.0.0.0:5432      0.0.0.0:*     users:(("postgres",pid=900,fd=5))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
5432/tcp                   ALLOW IN    Anywhere'
FX_DOCKER_PS=''
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_reach   "$OUT" tcp 5432 INTERNET "explicit allow makes it INTERNET"
assert_finding "$OUT" SENSITIVE_PORT_EXPOSED CRITICAL "flagged CRITICAL"
fi

# ===========================================================================
# 6. Firewall hygiene: a rule for a port nothing listens on.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 6 ]]; then
scenario 6 "Stale ufw rule — allows 8080, nothing is listening"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=800,fd=3))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
8080/tcp                   ALLOW IN    Anywhere'
FX_DOCKER_PS=''
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_finding "$OUT" STALE_FIREWALL_RULE LOW "stale rule is reported"
fi

# ===========================================================================
# 7. Multi-port and range rules, plus IPv6 duplicate rows.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 7 ]]; then
scenario 7 "Multi-port rules (80,443/tcp) and v4/v6 duplicate sockets collapse"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:80        0.0.0.0:*     users:(("nginx",pid=700,fd=6))
tcp   LISTEN 0      4096   [::]:80           [::]:*        users:(("nginx",pid=700,fd=7))
tcp   LISTEN 0      4096   0.0.0.0:443       0.0.0.0:*     users:(("nginx",pid=700,fd=8))
tcp   LISTEN 0      4096   [::]:443          [::]:*        users:(("nginx",pid=700,fd=9))'
FX_UFW='Status: active

Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
80,443/tcp                 ALLOW IN    Anywhere'
FX_DOCKER_PS=''
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_reach  "$OUT" tcp 80  INTERNET "multi-port rule matches :80"
assert_reach  "$OUT" tcp 443 INTERNET "multi-port rule matches :443"
assert_absent "$OUT" STALE_FIREWALL_RULE "no stale-rule false positive from 80,443"
assert_absent "$OUT" PORT_EXPOSED "nginx on 80/443 is expected, not a finding"
fi

# ===========================================================================
# 8. No firewall at all.
# ===========================================================================
if [[ -z "$ONLY" || "$ONLY" == 8 ]]; then
scenario 8 "No host firewall present"
FX_SS='tcp   LISTEN 0      4096   0.0.0.0:6379      0.0.0.0:*     users:(("redis-server",pid=910,fd=6))'
FX_UFW='__ABSENT__'
FX_DOCKER_PS=''
OUT=$(run_scan)
assert_quiet "scan produced no stderr noise"
assert_finding "$OUT" SENSITIVE_PORT_EXPOSED CRITICAL "Redis with no firewall is CRITICAL"
fi

echo
echo "${BLD}$PASS passed, $FAIL failed${RST}"
[[ $FAIL -eq 0 ]] || exit 1
