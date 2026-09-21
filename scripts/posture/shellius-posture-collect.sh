#!/usr/bin/env bash
#
# shellius-posture-collect — host posture collector (agent-mode, JSON only).
#
# This is the production packaging of the reference collector at
# .posture-wip/shellius-posture-scan.sh, cut down to exactly what the
# Shellius host agent needs. It differs from the reference script in one
# deliberate way, per docs/posture/posture-spec.md §1 decision 2:
#
#   NO root requirement, NO docker group, NO Docker socket access.
#   Runs as the unprivileged 'shellius-posture' system account and reaches
#   for root only through a narrow, named sudoers drop-in (see
#   shellius-posture.sudoers) for exactly: ss, ufw status, firewall-cmd
#   --list-all, systemctl show, iptables -t nat -S, nft list table ip nat.
#   Nothing else.
#
# Consequences of that trade-off, reported honestly rather than hidden:
#   - Container id -> name/image resolution is NEVER available (would
#     require talking to the Docker/Podman socket). Every container is
#     reported as owner "docker:<12-char-id>" / "podman:<12-char-id>".
#     collectorOk=false and degradedReason is set whenever this happens.
#   - Docker's userland-proxy=false / DNAT-only published ports (no host
#     listener, no docker-proxy process) ARE now visible: the NAT table
#     (read via the sudoers grant above, `iptables -t nat -S`, falling back
#     to `nft list table ip nat` on nft-native hosts) is parsed for DNAT
#     rules to recover host proto/port -> container ip:port, and emitted as
#     listeners with "source":"nat". This closes the blind spot documented
#     in docs/posture/posture-spec.md §4/§5 and .posture-wip/posture-design.md
#     §3.1/§3.3 — DOCKER_FIREWALL_BYPASS now fires for these too. What is
#     still NOT available for a NAT-derived row, for the same socket-access
#     reason as above: the container's name/image, and — unless a listening
#     process inside that container's own netns can be matched by port on
#     the container-side port via /proc (best-effort, no socket) — the
#     container id itself, in which case the row is reported as owner
#     "docker:runtime:<ip>:<port>" rather than dropped. The common case
#     (userland-proxy=true, the Docker default) still shows a docker-proxy
#     process in `ss` and IS fully detected, including the
#     DOCKER_FIREWALL_BYPASS evidence (docker-proxy's own /proc/<pid>/cmdline
#     is world-readable and needs no socket access at all); a NAT-derived row
#     for the same port is deduplicated in favor of that richer ss-sourced
#     attribution (see dedupe_endpoints()), never double-counted.
#   - Cross-user attribution that needs /proc/<pid>/environ (pm2's pm_id,
#     PM2_HOME) is only available for processes owned by the collector's own
#     user — the kernel restricts environ to the owning uid or root. Other
#     users' pm2 apps still get a partial "pm2" label via the God Daemon
#     parent-cmdline check (cmdline is world-readable), just without the
#     exact app name/id.
#
# This script only ever READS. It writes nothing to disk and changes
# nothing on the host. Findings/severity are NOT computed here — this
# emits evidence only (listeners + firewall state); postureService.ingest()
# on the backend is the trust boundary that recomputes findings from this
# payload. See docs/posture/posture-spec.md §3.
#
# Output: a single JSON object on stdout. Exit 0 on a completed scan (even
# a degraded one — degradation is a field, not a failure), non-zero only
# if the scan itself could not run at all (e.g. 'ss' missing).

set -uo pipefail

VERSION="1.0.0"

have() { command -v "$1" >/dev/null 2>&1; }

# Run a command with the privilege it needs. If we're already root (e.g. an
# operator chose to run this by hand as root) skip sudo entirely; otherwise
# go through the narrow sudoers grant. -n (non-interactive) means a missing
# grant fails fast instead of hanging on a password prompt.
# sudo's own stderr from the most recent privileged call.
#
# It used to go to /dev/null, and that is what made the NoNewPrivileges bug
# so expensive: sudo said exactly what was wrong ("The 'no new privileges'
# flag is set, which prevents sudo from running as root") and every host
# reported only "sudo grant missing?". run_priv runs inside $(…) subshells,
# so a variable cannot carry the message back out — a file can. Set once the
# temp dir exists; read with priv_err() straight after the failing call.
PRIV_ERR=""
run_priv() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif [ -n "$PRIV_ERR" ]; then
    sudo -n "$@" 2>"$PRIV_ERR"
  else
    sudo -n "$@" 2>/dev/null
  fi
}

# ": <what sudo said>", or nothing. Bounded, single-line, for a reason string.
priv_err() {
  [ -n "$PRIV_ERR" ] && [ -s "$PRIV_ERR" ] || return 0
  local e
  e=$(head -c 240 "$PRIV_ERR" | tr '\n\r\t' '   ' | sed 's/  */ /g; s/ *$//')
  [ -n "$e" ] && printf ': %s' "$e"
}

DEGRADED=0
DEGRADED_REASONS=()
note_degraded() {
  DEGRADED=1
  DEGRADED_REASONS+=("$1")
}

TMP=$(mktemp -d) || { echo '{"error":"cannot create temp dir"}' >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT
PRIV_ERR="$TMP/priv.err"

ENDPOINTS="$TMP/endpoints.tsv"  # proto bind port pids pname kind owner detail user cport oid src csrc
ENRICHED="$TMP/enriched.tsv"    # ... + bindclass reach service dockerpub bypass source
FWRULES="$TMP/fw.tsv"           # portspec proto action from engine
declare -A FW_SEEN=()           # v4/v6 rule pairs collapse to one row
NATRULES="$TMP/nat.tsv"         # proto hostbind hostport containerip containerport (DNAT, from iptables/nft)
: > "$ENDPOINTS"; : > "$FWRULES"; : > "$ENRICHED"; : > "$NATRULES"

# Every value ends up in a TAB-separated record; a single embedded tab
# silently shifts every later column. Strip whitespace control chars at the
# point of collection rather than trusting the source (see
# shellius-posture-scan.sh's identical note — same hazard, same fix).
clean() {
  local v=${1-}
  v=${v//$'\t'/ }; v=${v//$'\n'/ }; v=${v//$'\r'/ }
  printf '%s' "$v"
}

# ---------------------------------------------------------------------------
# Port knowledge base (identical taxonomy to the reference collector)
# ---------------------------------------------------------------------------

declare -A SENSITIVE=(
  [5432]="PostgreSQL"    [3306]="MySQL/MariaDB"  [1433]="MSSQL"
  [27017]="MongoDB"      [27018]="MongoDB"       [6379]="Redis"
  [11211]="Memcached"    [9200]="Elasticsearch"  [9300]="Elasticsearch cluster"
  [5984]="CouchDB"       [8086]="InfluxDB"       [9042]="Cassandra"
  [2375]="Docker API (plaintext)" [2376]="Docker API (TLS)"
  [2379]="etcd"          [8500]="Consul"         [4646]="Nomad"
  [5672]="RabbitMQ AMQP" [15672]="RabbitMQ mgmt"
  [9090]="Prometheus"    [9093]="Alertmanager"   [9100]="node_exporter"
  [5601]="Kibana"        [3389]="RDP"            [5900]="VNC"
  [2049]="NFS"           [445]="SMB"             [139]="NetBIOS"
  [25]="SMTP"            [10250]="kubelet"       [6443]="Kubernetes API"
  [7474]="Neo4j"         [8009]="AJP"            [50070]="Hadoop NN"
)
declare -A EXPECTED_PUBLIC=( [22]="SSH" [80]="HTTP" [443]="HTTPS" )

port_label() { echo "${SENSITIVE[$1]:-}"; }

name_sensitive() {
  local s; s=$(tr '[:upper:]' '[:lower:]' <<<"${1:-}")
  case "$s" in
    *postgres*|*timescale*|*pgvector*|*postgis*) echo "PostgreSQL" ;;
    *redis*|*valkey*)                            echo "Redis" ;;
    *mongo*)                                     echo "MongoDB" ;;
    *mysql*|*mariadb*|*percona*)                 echo "MySQL/MariaDB" ;;
    *elasticsearch*|*opensearch*)                echo "Elasticsearch" ;;
    *clickhouse*)                                echo "ClickHouse" ;;
    *rabbitmq*)                                  echo "RabbitMQ" ;;
    *memcached*)                                 echo "Memcached" ;;
    *cassandra*)                                 echo "Cassandra" ;;
    *influxdb*)                                  echo "InfluxDB" ;;
    *neo4j*)                                     echo "Neo4j" ;;
    *couchdb*)                                   echo "CouchDB" ;;
    *minio*)                                     echo "MinIO" ;;
    *etcd*)                                      echo "etcd" ;;
    *mssql*|*sqlserver*)                         echo "MSSQL" ;;
    *) echo "" ;;
  esac
}

service_identity() {
  local hostport=$1 cport=${2:-} owner=${3:-} detail=${4:-} pname=${5:-}
  local s
  if [[ -n "$cport" ]]; then
    s=$(port_label "$cport"); [[ -n "$s" ]] && { echo "$s"; return; }
  else
    s=$(port_label "$hostport"); [[ -n "$s" ]] && { echo "$s"; return; }
  fi
  s=$(name_sensitive "$detail"); [[ -n "$s" ]] && { echo "$s"; return; }
  s=$(name_sensitive "$owner");  [[ -n "$s" ]] && { echo "$s"; return; }
  s=$(name_sensitive "$pname");  [[ -n "$s" ]] && { echo "$s"; return; }
  echo ""
}

# ---------------------------------------------------------------------------
# Process ownership resolution — /proc only, no docker/podman socket calls
# ---------------------------------------------------------------------------

read_env() {
  local pid=$1 var=$2
  [[ -r "/proc/$pid/environ" ]] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n "s/^${var}=//p" | head -1
}

proc_user() {
  local pid=$1
  [[ -r "/proc/$pid/status" ]] || { echo "-"; return; }
  local uid; uid=$(awk '/^Uid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)
  [[ -n "$uid" ]] || { echo "-"; return; }
  id -nu "$uid" 2>/dev/null || echo "uid:$uid"
}

proc_cmdline() {
  local pid=$1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/ *$//'
}

proc_ppid() {
  local pid=$1
  [[ -r "/proc/$pid/status" ]] || return 1
  awk '/^PPid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null
}

# Where the service was started from — systemd only (docker/pm2 source
# paths need environ or the docker socket, neither of which we have for
# other users; they fall back to "-" and that is expected, not a bug).
resolve_source() {
  local kind=$1 pid=$2 unit=${3:-}
  local src=""
  case "$kind" in
    systemd|systemd-user)
      if [[ -n "$unit" ]] && have systemctl; then
        local uflag=""
        [[ "$kind" == "systemd-user" ]] && uflag="--user"
        if [[ "$kind" == "systemd-user" ]]; then
          # --user units belong to the owning user's manager, not root's —
          # not sudo-able (sudoers only names the system-wide invocation).
          src=$(systemctl $uflag show -p FragmentPath --value "$unit" 2>/dev/null)
        else
          src=$(run_priv systemctl show -p FragmentPath --value "$unit" 2>/dev/null)
        fi
      fi
      ;;
  esac
  if [[ -z "$src" || "$src" == "-" ]]; then
    [[ -n "$pid" && "$pid" != "-" ]] && src=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "")
  fi
  printf '%s' "${src:--}"
}

# Resolve a pid to owner kind + name + detail + id. Emits:
#   kind<TAB>name<TAB>detail<TAB>id
CONTAINERS_SEEN=0
resolve_owner() {
  local pid=$1 pname=${2:-}

  # docker-proxy is special: it's a shim for a published port, and its own
  # cmdline (world-readable, no socket needed) names the real container's
  # ip:port — this is precisely how DOCKER_FIREWALL_BYPASS evidence survives
  # without Docker socket access.
  if [[ "$pname" == "docker-proxy" ]]; then
    local cmd; cmd=$(proc_cmdline "$pid" 2>/dev/null || echo "")
    local cip cport
    cip=$(grep -oE '\-container-ip [0-9.]+' <<<"$cmd" | awk '{print $2}')
    cport=$(grep -oE '\-container-port [0-9]+' <<<"$cmd" | awk '{print $2}')
    printf 'docker-proxy\tdocker-proxy\t-> %s:%s\t-\n' "${cip:-?}" "${cport:-?}"
    return
  fi

  local cg="" cid="" unit=""
  [[ -r "/proc/$pid/cgroup" ]] && cg=$(cat "/proc/$pid/cgroup" 2>/dev/null)

  if [[ -n "$cg" ]]; then
    cid=$(grep -oE '[0-9a-f]{64}' <<<"$cg" | head -1)
    if [[ -n "$cid" ]]; then
      # No socket access — container name/image can NEVER be resolved here.
      CONTAINERS_SEEN=$((CONTAINERS_SEEN + 1))
      local runtime="docker"
      [[ "$cg" == *libpod* ]] && runtime="podman"
      printf 'container\t%s:%s\t-\t%s\n' "$runtime" "${cid:0:12}" "${cid:0:12}"
      return
    fi
    unit=$(grep -oE '[^/]+\.(service|scope)' <<<"$cg" | grep -vE '^user@[0-9]+\.service$' | tail -1)
  fi

  # pm2: only resolvable for processes the collector's own user owns
  # (environ is root/same-uid only). Cross-user pm2 apps fall through to
  # the God Daemon parent-cmdline check below, which needs no privilege.
  local pm_id; pm_id=$(read_env "$pid" "pm_id" 2>/dev/null || echo "")
  if [[ -n "$pm_id" ]]; then
    local pm_name pm_exec pm_home
    pm_name=$(read_env "$pid" "name" 2>/dev/null || echo "")
    pm_exec=$(read_env "$pid" "pm_exec_path" 2>/dev/null || echo "")
    pm_home=$(read_env "$pid" "PM2_HOME" 2>/dev/null || echo "")
    local pm_ref="#$pm_id"
    [[ -n "$pm_home" ]] && pm_ref="#$pm_id@$pm_home"
    printf 'pm2\t%s\t%s\t%s\n' "${pm_name:-pm_id:$pm_id}" "${pm_exec:--}" "$pm_ref"
    return
  fi
  local ppid pcmd
  ppid=$(proc_ppid "$pid" 2>/dev/null || echo "")
  if [[ -n "$ppid" && "$ppid" != "0" ]]; then
    pcmd=$(proc_cmdline "$ppid" 2>/dev/null || echo "")
    if [[ "$pcmd" == *"God Daemon"* || "$pcmd" == *"PM2 v"* ]]; then
      printf 'pm2\t%s\t%s\t-\n' "${pname:-node}" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)"
      return
    fi
  fi

  if [[ -n "$unit" && "$unit" != "-.scope" && "$unit" != "init.scope" ]]; then
    local ukind="systemd"
    [[ "$cg" == *"user@"* ]] && ukind="systemd-user"
    printf '%s\t%s\t%s\t%s\n' "$ukind" "$unit" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)" "$unit"
    return
  fi

  printf '%s\t%s\t%s\t-\n' "process" "${pname:-unknown}" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)"
}

# ---------------------------------------------------------------------------
# Listening sockets via ss (privileged: needs to see every user's pids)
# ---------------------------------------------------------------------------

normalize_bind() {
  local b=$1
  b=${b%\%*}; b=${b#[}; b=${b%]}
  [[ "$b" == "*" ]] && b="0.0.0.0"
  echo "$b"
}

bind_class() {
  case "$1" in
    0.0.0.0|::|"*")            echo "wildcard" ;;
    127.*|::1)                 echo "loopback" ;;
    10.*|192.168.*|169.254.*)  echo "private"  ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) echo "private" ;;
    fe80:*|fc*|fd*)            echo "private"  ;;
    *)                         echo "specific" ;;
  esac
}

SS_OK=1
collect_listeners() {
  have ss || { SS_OK=0; note_degraded "'ss' not found"; return 1; }

  local raw
  raw=$(run_priv ss -H -tulpn 2>/dev/null) || raw=""
  if [[ -z "$raw" ]]; then
    SS_OK=0
    note_degraded "could not run 'ss' with the privilege needed to see other users' sockets (sudo grant missing or ss not on sudoers path)$(priv_err)"
    # Still try unprivileged — partial (own-user-only) attribution beats none.
    raw=$(ss -H -tulpn 2>/dev/null) || raw=""
    [[ -n "$raw" ]] && note_degraded "listener owners limited to the collector's own user"
  fi

  local netid state rq sq local_addr peer rest
  while read -r netid state rq sq local_addr peer rest; do
    [[ -z "${netid:-}" ]] && continue
    case "$netid" in
      tcp|tcp6) [[ "$state" == "LISTEN" ]] || continue ;;
      udp|udp6) ;;
      *) continue ;;
    esac

    local port bind
    port=${local_addr##*:}
    bind=${local_addr%:*}
    bind=$(normalize_bind "$bind")
    [[ "$port" =~ ^[0-9]+$ ]] || continue

    local pids pname
    pids=$(grep -oE 'pid=[0-9]+' <<<"${rest:-}" | cut -d= -f2 | paste -sd, - 2>/dev/null)
    pname=$(grep -oE '\("[^"]+"' <<<"${rest:-}" | head -1 | tr -d '("')

    local first_pid=${pids%%,*}
    local kind owner detail oid user
    if [[ -n "$first_pid" ]]; then
      IFS=$'\t' read -r kind owner detail oid < <(resolve_owner "$first_pid" "$pname")
      user=$(proc_user "$first_pid")
    else
      kind="unknown"; owner="${pname:-unknown}"; detail=""; oid="-"; user="-"
      pids=""
    fi

    owner=$(clean "$owner"); detail=$(clean "$detail")
    pname=$(clean "$pname");  oid=$(clean "$oid")
    kind=${kind:-unknown}; owner=${owner:-unknown}
    detail=${detail:--}; oid=${oid:--}; user=${user:--}

    local src="-"
    if [[ -n "$first_pid" ]]; then
      local unit=""
      [[ "$kind" == systemd* ]] && unit=$oid
      src=$(clean "$(resolve_source "$kind" "$first_pid" "$unit")")
    fi

    local proto=${netid%6}
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$proto" "$bind" "$port" "${pids:--}" "${pname:--}" \
      "${kind:-unknown}" "${owner:-unknown}" "${detail:--}" "${user:--}" "-" \
      "${oid:--}" "${src:--}" "ss" >> "$ENDPOINTS"
  done <<<"$raw"
}

# ---------------------------------------------------------------------------
# Firewall state — ufw and firewalld, both via the narrow sudoers grant
# ---------------------------------------------------------------------------

FW_ENGINE="none"
FW_ACTIVE=0
FW_DEFAULT_IN="unknown"

collect_firewall_ufw() {
  have ufw || return 1
  local status
  status=$(run_priv ufw status verbose 2>/dev/null) || status=""
  [[ -n "$status" ]] || { note_degraded "ufw present but 'sudo ufw status verbose' failed (sudoers grant missing?)$(priv_err)"; return 1; }

  FW_ENGINE="ufw"
  grep -q "^Status: active" <<<"$status" && FW_ACTIVE=1
  FW_DEFAULT_IN=$(grep -oE 'Default: [a-z]+ \(incoming\)' <<<"$status" | awk '{print $2}')
  [[ -n "$FW_DEFAULT_IN" ]] || FW_DEFAULT_IN="unknown"

  local line spec action from fwkey
  while IFS= read -r line; do
    [[ "$line" =~ (ALLOW|DENY|REJECT|LIMIT)[[:space:]] ]] || continue
    [[ "$line" =~ (ALLOW|DENY|REJECT|LIMIT)[[:space:]]+OUT ]] && continue
    action=$(grep -oE '(ALLOW|DENY|REJECT|LIMIT)' <<<"$line" | head -1)
    spec=$(sed -E "s/[[:space:]]+(ALLOW|DENY|REJECT|LIMIT).*//" <<<"$line" | sed 's/ *$//')
    from=$(sed -E "s/.*(ALLOW|DENY|REJECT|LIMIT)([[:space:]]+IN)?[[:space:]]+//" <<<"$line" | sed 's/ *$//')
    # Strip the marker from BOTH columns: ufw writes the twin as
    # "8083/tcp (v6) ALLOW IN Anywhere (v6)", so stripping only the port spec
    # leaves the two rows differing by the source and the dedupe never fires.
    spec=$(sed 's/ *(v6)//' <<<"$spec")
    from=$(sed 's/ *(v6)//' <<<"$from")
    local pspec proto
    if [[ "$spec" == */* ]]; then pspec=${spec%%/*}; proto=${spec##*/}; else pspec=$spec; proto="any"; fi
    [[ "$pspec" =~ ^[0-9,:]+$ ]] || continue
    # ufw prints an IPv4 rule and its IPv6 twin as two lines differing only
    # by the "(v6)" marker stripped above — so without this, every port
    # produces TWO identical rows and every stale-rule finding fires twice.
    fwkey="${pspec}|${proto}|${action}|${from:-Anywhere}"
    if [[ -z "${FW_SEEN[$fwkey]:-}" ]]; then
      FW_SEEN[$fwkey]=1
      printf '%s\t%s\t%s\t%s\t%s\n' "$pspec" "$proto" "$action" "${from:-Anywhere}" "ufw" >> "$FWRULES"
    fi
  done <<<"$status"
  return 0
}

collect_firewall_firewalld() {
  have firewall-cmd || return 1
  local out
  out=$(run_priv firewall-cmd --list-all 2>/dev/null) || out=""
  [[ -n "$out" ]] || { note_degraded "firewalld present but 'sudo firewall-cmd --list-all' failed (sudoers grant missing?)$(priv_err)"; return 1; }

  FW_ENGINE="firewalld"
  local target
  target=$(grep -oE 'target:[[:space:]]*[A-Za-z%]+' <<<"$out" | awk '{print $2}')
  case "$target" in
    DROP|REJECT|"%%REJECT%%") FW_ACTIVE=1; FW_DEFAULT_IN="deny" ;;
    ACCEPT|default|"")        FW_ACTIVE=1; FW_DEFAULT_IN="allow" ;;
    *)                        FW_DEFAULT_IN="unknown" ;;
  esac

  local ports_line services_line
  ports_line=$(grep -E '^[[:space:]]*ports:' <<<"$out" | sed 's/^[[:space:]]*ports:[[:space:]]*//')
  services_line=$(grep -E '^[[:space:]]*services:' <<<"$out" | sed 's/^[[:space:]]*services:[[:space:]]*//')

  local p
  for p in $ports_line; do
    [[ "$p" == */* ]] || continue
    local pspec=${p%%/*} proto=${p##*/}
    [[ "$pspec" =~ ^[0-9]+$ ]] || continue
    printf '%s\t%s\t%s\t%s\t%s\n' "$pspec" "$proto" "ALLOW" "zone" "firewalld" >> "$FWRULES"
  done
  # Named services (ssh, http, https, ...) map to well-known ports; only the
  # handful relevant to EXPECTED_PUBLIC / sensitive checks are worth the
  # lookup, so we don't carry a full /etc/services table onto the host.
  local svc
  for svc in $services_line; do
    case "$svc" in
      ssh)   printf '22\ttcp\tALLOW\tzone\tfirewalld\n'  >> "$FWRULES" ;;
      http)  printf '80\ttcp\tALLOW\tzone\tfirewalld\n'  >> "$FWRULES" ;;
      https) printf '443\ttcp\tALLOW\tzone\tfirewalld\n' >> "$FWRULES" ;;
    esac
  done
  return 0
}

collect_firewall() {
  # Prefer whichever engine is actually installed; if both are (rare), ufw
  # wins — same precedence as the reference collector.
  if collect_firewall_ufw; then return; fi
  if collect_firewall_firewalld; then return; fi

  if have nft && run_priv nft list ruleset >/dev/null 2>&1; then
    FW_ENGINE="nftables"
    note_degraded "nftables detected but not parsed — no usable firewall data (v1 supports ufw/firewalld only)"
  elif have iptables; then
    FW_ENGINE="iptables"
    note_degraded "raw iptables detected but not parsed — no usable firewall data (v1 supports ufw/firewalld only)"
  fi
}

# proto+port -> ALLOW / DENY / NONE, across whichever engine populated FWRULES
fw_verdict() {
  local port=$1 proto=$2
  [[ -s "$FWRULES" ]] || { echo "NONE"; return; }
  local pspec rproto action from engine
  while IFS=$'\t' read -r pspec rproto action from engine; do
    [[ "$rproto" == "any" || "$rproto" == "$proto" ]] || continue
    local match=0
    if [[ "$pspec" == *:* ]]; then
      local lo=${pspec%%:*} hi=${pspec##*:}
      (( port >= lo && port <= hi )) && match=1
    elif [[ "$pspec" == *,* ]]; then
      local p; for p in ${pspec//,/ }; do [[ "$p" == "$port" ]] && match=1; done
    else
      [[ "$pspec" == "$port" ]] && match=1
    fi
    if [[ $match -eq 1 ]]; then
      case "$action" in
        ALLOW|LIMIT) echo "ALLOW"; return ;;
        DENY|REJECT) echo "DENY";  return ;;
      esac
    fi
  done < "$FWRULES"
  echo "NONE"
}

# ---------------------------------------------------------------------------
# NAT table (DNAT) — recovers Docker's userland-proxy=false published ports,
# which have NO host listener and NO docker-proxy process: only a
# nat/PREROUTING DNAT rule. Read via the narrow sudoers grant (same
# discipline as ss/ufw/firewall-cmd above): `iptables -t nat -S` preferred
# (iptables-save-style, stable to parse), falling back to
# `nft list table ip nat` on nft-native hosts. See
# docs/posture/posture-spec.md §4/§5 and
# .posture-wip/posture-design.md §3.1/§3.3.
# ---------------------------------------------------------------------------

# Best-effort: does this pid's OWN network namespace show a LISTEN socket on
# the given hex-encoded port? /proc/<pid>/net/{tcp,tcp6} reflect the target
# pid's netns (not the reader's) and are readable without extra privilege —
# no sudo, no socket, no nsenter. This is how a NAT-derived container ip:port
# can sometimes be tied back to a container id purely from /proc.
match_container_listen_port() {
  local pid=$1 hexport=$2
  local nf
  for nf in "/proc/$pid/net/tcp" "/proc/$pid/net/tcp6"; do
    [[ -r "$nf" ]] || continue
    awk -v p=":$hexport" 'NR>1 && $2 ~ (p"$") && $4=="0A" { found=1; exit } END { exit !found }'       "$nf" 2>/dev/null && return 0
  done
  return 1
}

# Resolve a NAT-derived container-ip:container-port to the best owner we can
# get from /proc alone. Emits kind<TAB>name<TAB>detail<TAB>id, same shape as
# resolve_owner(), so it renders through the same JSON fields.
resolve_nat_owner() {
  local cip=$1 cport=${2:-}
  local hexport=""
  [[ "$cport" =~ ^[0-9]+$ ]] && hexport=$(printf '%04X' "$cport" 2>/dev/null)

  if [[ -n "$hexport" ]]; then
    local pid_path pid cg cid runtime
    for pid_path in /proc/[0-9]*; do
      pid=${pid_path#/proc/}
      [[ -r "$pid_path/cgroup" ]] || continue
      cg=$(cat "$pid_path/cgroup" 2>/dev/null) || continue
      cid=$(grep -oE '[0-9a-f]{64}' <<<"$cg" | head -1)
      [[ -n "$cid" ]] || continue
      if match_container_listen_port "$pid" "$hexport"; then
        CONTAINERS_SEEN=$((CONTAINERS_SEEN + 1))
        runtime="docker"
        [[ "$cg" == *libpod* ]] && runtime="podman"
        printf 'container	%s:%s	-> %s:%s (nat)	%s
' "$runtime" "${cid:0:12}" "$cip" "$cport" "${cid:0:12}"
        return
      fi
    done
  fi

  # Could not tie the DNAT target back to a container id — report it rather
  # than dropping the row (per docs/posture/posture-spec.md §4).
  printf 'docker	runtime:%s:%s	-> %s:%s (nat, unresolved)	-
'     "$cip" "${cport:-?}" "$cip" "${cport:-?}"
}

# proto hostbind hostport containerip containerport, from `iptables -t nat -S`
# (iptables-save style). Only -A rules that DNAT are relevant; -N/-P lines are
# skipped. Handles both the wildcard-bind case (no -d) and a specific host
# bind (-d <ip>).
parse_iptables_nat() {
  local raw=$1 line
  while IFS= read -r line; do
    [[ "$line" == *"-j DNAT"* && "$line" == *"--to-destination"* ]] || continue
    local proto hostport hostbind dest cip cport
    proto=$(grep -oE -- '-p (tcp|udp)' <<<"$line" | head -1 | awk '{print $2}')
    hostport=$(grep -oE -- '--dport [0-9]+' <<<"$line" | head -1 | awk '{print $2}')
    hostbind=$(grep -oE -- '-d [0-9.]+(/[0-9]+)?' <<<"$line" | head -1 | awk '{print $2}' | cut -d/ -f1)
    dest=$(grep -oE -- '--to-destination [0-9.]+(:[0-9]+)?' <<<"$line" | head -1 | awk '{print $2}')
    [[ -n "$proto" && -n "$hostport" && -n "$dest" ]] || continue
    cip=${dest%%:*}
    cport=${dest#*:}
    [[ "$cport" == "$dest" ]] && cport="$hostport"
    printf '%s	%s	%s	%s	%s
' "$proto" "${hostbind:-0.0.0.0}" "$hostport" "$cip" "$cport" >> "$NATRULES"
  done <<<"$raw"
}

# Same, from `nft list table ip nat` (nft-native Docker hosts). nft's own
# line syntax varies with counters/comments in the middle of the rule, so we
# match on the two fixed anchors ("dport N" and "dnat to ip:port") rather
# than a whole-line pattern.
parse_nft_nat() {
  local raw=$1 line
  while IFS= read -r line; do
    [[ "$line" == *"dnat to"* ]] || continue
    local proto hostport hostbind dest cip cport
    proto=$(grep -oE '(tcp|udp) dport' <<<"$line" | head -1 | awk '{print $1}')
    hostport=$(grep -oE 'dport [0-9]+' <<<"$line" | head -1 | awk '{print $2}')
    hostbind=$(grep -oE 'ip daddr [0-9.]+' <<<"$line" | head -1 | awk '{print $3}')
    dest=$(grep -oE 'dnat to [0-9.]+(:[0-9]+)?' <<<"$line" | head -1 | awk '{print $3}')
    [[ -n "$proto" && -n "$hostport" && -n "$dest" ]] || continue
    cip=${dest%%:*}
    cport=${dest#*:}
    [[ "$cport" == "$dest" ]] && cport="$hostport"
    printf '%s	%s	%s	%s	%s
' "$proto" "${hostbind:-0.0.0.0}" "$hostport" "$cip" "$cport" >> "$NATRULES"
  done <<<"$raw"
}

# Populate $NATRULES from whichever NAT-reading command works. Absence is not
# itself degraded (a non-Docker host legitimately has no DNAT rules); a real
# read failure (grant missing, both tools absent) is.
collect_nat_dnat() {
  local raw="" nsrc=""
  if have iptables; then
    raw=$(run_priv iptables -t nat -S 2>/dev/null) || raw=""
    [[ -n "$raw" ]] && nsrc="iptables"
  fi
  if [[ -z "$raw" ]] && have nft; then
    raw=$(run_priv nft list table ip nat 2>/dev/null) || raw=""
    [[ -n "$raw" ]] && nsrc="nft"
  fi

  if [[ -z "$raw" ]]; then
    if have iptables || have nft; then
      note_degraded "could not read the NAT table ('sudo iptables -t nat -S' / 'sudo nft list table ip nat' both failed — sudoers grant missing, or nftables has no ip/nat table on this host); Docker userland-proxy=false published ports may be invisible$(priv_err)"
    fi
    return 1
  fi

  if [[ "$nsrc" == "iptables" ]]; then
    parse_iptables_nat "$raw"
  else
    parse_nft_nat "$raw"
  fi
}

# Turn parsed DNAT rules into ENDPOINTS rows (source "nat"), skipping ports
# ss already found a real listener for — dedupe_endpoints() below is the
# authority on which row wins, but ports absent from ss entirely still need
# a row emitted here or they never reach the listeners array at all.
collect_nat_listeners() {
  [[ -s "$NATRULES" ]] || return 0
  local proto hostbind hostport cip cport
  while IFS=$'	' read -r proto hostbind hostport cip cport; do
    [[ "$proto" =~ ^(tcp|udp)$ ]] || continue
    [[ "$hostport" =~ ^[0-9]+$ ]] || continue

    local kind owner detail oid
    IFS=$'	' read -r kind owner detail oid < <(resolve_nat_owner "$cip" "$cport")
    owner=$(clean "$owner"); detail=$(clean "$detail"); oid=$(clean "$oid")

    printf '%s	%s	%s	%s	%s	%s	%s	%s	%s	%s	%s	%s	%s
'       "$proto" "$(normalize_bind "$hostbind")" "$hostport" "-" "-"       "${kind:-docker}" "${owner:-unknown}" "${detail:--}" "-" "${cport:--}"       "${oid:--}" "-" "nat" >> "$ENDPOINTS"
  done < "$NATRULES"
}

# ---------------------------------------------------------------------------
# Correlation — reachability verdict per listener. No findings are raised
# here; this is evidence for postureService.ingest() to turn into findings.
# ---------------------------------------------------------------------------

declare -A BEST=() BESTSCORE=() PIDS=()
dedupe_endpoints() {
  local proto bind port pids pname kind owner detail user cport oid src csrc
  while IFS=$'\t' read -r proto bind port pids pname kind owner detail user cport oid src csrc; do
    local key="$proto:$bind:$port"
    # Score: 0 = ss saw the socket but never resolved an owner; 1 = NAT-only
    # evidence (no host listener at all, so no pid to attribute from ss);
    # 2 = ss resolved a real owner (systemd/pm2/container/docker-proxy/...).
    # This ordering is what makes step 3 of the DNAT fix correct: a NAT row
    # can only ever fill a gap ss left empty, never replace or double-count
    # a port ss already attributed — and an unattributed ss row still loses
    # to a NAT row that at least knows the port is a Docker publish.
    local score=0
    if [[ "$csrc" == "nat" ]]; then
      score=1
    elif [[ "$kind" != "unknown" ]]; then
      score=2
    fi
    [[ -n "$pids" && "$pids" != "-" ]] && PIDS[$key]=$pids
    if [[ -z "${BESTSCORE[$key]:-}" ]] || (( score > ${BESTSCORE[$key]} )); then
      BESTSCORE[$key]=$score
      BEST[$key]=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
        "$proto" "$bind" "$port" "$pids" "$pname" "$kind" "$owner" "$detail" "$user" "$cport" "$oid" "$src" "$csrc")
    fi
  done < "$ENDPOINTS"
}

analyze() {
  dedupe_endpoints
  local key
  for key in "${!BEST[@]}"; do
    local proto bind port pids pname kind owner detail user cport oid src csrc
    IFS=$'\t' read -r proto bind port pids pname kind owner detail user cport oid src csrc <<<"${BEST[$key]}"
    [[ ( -z "$pids" || "$pids" == "-" ) && -n "${PIDS[$key]:-}" ]] && pids=${PIDS[$key]}
    [[ "$cport" == "-" ]] && cport=""

    local class; class=$(bind_class "$bind")
    # A Docker publish either shows up as docker-proxy in ss (userland-proxy
    # true) or purely as a NAT row (userland-proxy false) — either way it's
    # DNAT'd through nat/PREROUTING and needs the same DOCKER_FIREWALL_BYPASS
    # check, since that traffic never traverses the host firewall's INPUT
    # chain regardless of which of the two sources found it.
    local is_docker_pub=0
    [[ "$kind" == "docker-proxy" || "$csrc" == "nat" ]] && is_docker_pub=1

    local fw; fw=$(fw_verdict "$port" "$proto")
    local bypass=0
    local reach
    if [[ "$class" == "loopback" ]]; then
      reach="LOOPBACK"
    elif [[ $is_docker_pub -eq 1 ]]; then
      reach="INTERNET"
      if [[ "$fw" == "DENY" ]] || { [[ $FW_ACTIVE -eq 1 ]] && [[ "$fw" == "NONE" ]] && [[ "$FW_DEFAULT_IN" == "deny" ]]; }; then
        bypass=1
      fi
    elif [[ "$class" == "private" ]]; then
      reach="LAN"
    else
      if [[ "$fw" == "ALLOW" ]]; then reach="INTERNET"
      elif [[ "$fw" == "DENY" ]]; then reach="FIREWALLED"
      elif [[ $FW_ACTIVE -eq 1 && "$FW_DEFAULT_IN" == "deny" ]]; then reach="FIREWALLED"
      else reach="INTERNET"
      fi
    fi

    local svc; svc=$(service_identity "$port" "$cport" "$owner" "$detail" "$pname")

    local ownerKind="$kind" ownerName="$owner"
    case "$kind" in
      docker-proxy) ownerName="docker-proxy" ;;
    esac

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$proto" "$bind" "$port" "${cport:--}" "$class" "$reach" "${svc:--}" \
      "$ownerKind" "$ownerName" "${detail:--}" "${user:--}" "${oid:--}" "${src:--}" \
      "${pids:--}" "$bypass" "${csrc:-ss}" >> "$ENRICHED"
  done
}


# ---------------------------------------------------------------------------
# Installed services and their current state
# ---------------------------------------------------------------------------
#
# `ss` only ever shows what is LISTENING. A stopped container, a failed unit
# or a disabled service is invisible there — while its firewall rule
# survives, its published port is still declared, and it re-opens the moment
# the thing starts again. STALE_FIREWALL_RULE could say "nothing is
# listening on tcp/8080" but never "because the container `api` is stopped",
# which is the half that decides whether you delete the rule or restart the
# service.
#
# Two sources, with different privilege costs, reported separately so the
# backend can say which half it actually got:
#
#   systemd    — free. `systemctl list-units` / `list-unit-files` are
#                world-readable; no sudo, no new grant.
#   containers — needs `docker ps -a` / `podman ps -a`, which needs root.
#                Granted through the SAME narrow sudoers pattern as
#                everything else: fixed, fully-qualified commands with a
#                fixed --format, never the docker group and never the
#                socket. Optional at bootstrap and OFF unless the operator
#                enabled it, so a host that did not opt in reports
#                containers:false rather than silently reporting "none".
#
# Deliberately NOT collected: another user's pm2 process list. `pm2 jlist`
# has to run as the owning user with that user's PM2_HOME, which is a
# general "run as any user" grant — a different and much larger ask than a
# fixed read-only command. Reported as pm2:false.

SERVICES="$TMP/services.tsv"   # kind name ref state running status detail source ports exit
: > "$SERVICES"
SVC_SYSTEMD=0
SVC_PM2=0
SVC_CONTAINERS=0
SVC_CONTAINERS_BLOCKED=0
MAX_SERVICES=200
SERVICE_COUNT=0

# kind name ref state running statusText detail sourcePath ports exitCode
#
# Every field is written, and an EMPTY one is written as "-".
#
# `IFS=$'\t' read` treats runs of tabs as a SINGLE delimiter, because tab is
# IFS whitespace — so one empty field silently shifts every column after it
# one to the left. A container with no sourcePath was landing its ports in
# the sourcePath column and its exit code in ports, and the JSON renderer
# dutifully published both. The fixture suite in .posture-wip/test caught
# it; nothing else would have until a host had a stopped container.
emit_service() {
  (( SERVICE_COUNT >= MAX_SERVICES )) && return 0
  SERVICE_COUNT=$((SERVICE_COUNT + 1))
  local __f __v __out=()
  for __v in "${@:1:10}"; do
    __f=$(clean "${__v-}")
    [[ -z "$__f" ]] && __f="-"
    __out+=("$__f")
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${__out[@]}" >> "$SERVICES"
}

# name<TAB>PORT<TAB>script, one line per saved app.
#
# python3 when present (every distro that ships systemd ships it), because
# dump.pm2 is a single-line JSON array with nested per-app env and picking
# the right PORT out of it with sed is the kind of parser that works on the
# author's host and nowhere else. Without python3, names only — degraded,
# and honest about it, rather than wrong.
pm2_dump_apps() {
  local dump=$1
  if have python3; then
    python3 - "$dump" <<'PY' 2>/dev/null
import json, sys
try:
    apps = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if not isinstance(apps, list):
    sys.exit(0)
for a in apps:
    if not isinstance(a, dict):
        continue
    name = str(a.get('name') or '').replace('\t', ' ')
    env = a.get('env') or a.get('pm2_env') or {}
    port = ''
    if isinstance(env, dict):
        raw = env.get('PORT')
        if raw is not None and str(raw).strip().isdigit():
            port = str(raw).strip()
    script = str(a.get('pm_exec_path') or a.get('script') or '').replace('\t', ' ')
    if name:
        print('\t'.join((name, port, script)))
PY
    return 0
  fi
  # Names only. `"name":"..."` is the one field flat enough to take from a
  # JSON blob with a regex and still be right.
  grep -oE '"name":"[^"]*"' "$dump" 2>/dev/null | sed 's/^"name":"//; s/"$//' | while IFS= read -r n; do
    [[ -n "$n" ]] && printf '%s\t\t\n' "$n"
  done
}

# pm2 apps, running and stopped.
#
# pm2 is where this matters most in practice and where it is hardest: a
# stopped app has no process and no socket, so `ss` and /proc see nothing at
# all — a host can have thirty stopped apps and look completely idle.
#
# Read from $PM2_HOME on disk rather than by asking the daemon. `pm2 jlist`
# is authoritative but has to run AS the owning user with that user's
# PM2_HOME, which is a general run-as-any-user grant; the dump file is a
# plain file, so root reads it directly and the unprivileged collector reads
# it when the home is world-readable (the common case) and reports pm2:false
# when it is not.
#
# Status comes from $PM2_HOME/pids/<name>-<id>.pid plus /proc, because
# dump.pm2 records what was SAVED, not what is running now.
#
# Ports: pm2 has no published-port map the way Docker does, so a port is
# only knowable when the app declares one in its env (PORT=). Where it does
# not, the app is still reported — "this is installed and stopped" is worth
# knowing even when it cannot be tied to a firewall rule.
pm2_running_pid() {
  local home=$1 name=$2 f pid
  for f in "$home"/pids/"$name"-*.pid; do
    [[ -r "$f" ]] || continue
    pid=$(cat "$f" 2>/dev/null)
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ -d "/proc/$pid" ]] && { printf '%s' "$pid"; return 0; }
  done
  return 1
}

declare -A PM2_SEEN=()

collect_pm2_services() {
  # The standard homes, plus PM2_HOME when the environment names a
  # non-default one — which is both a real deployment shape (the owner
  # resolution below already handles a custom PM2_HOME for RUNNING apps)
  # and what makes this testable against a fixture.
  local home dump owner
  for home in ${PM2_HOME:+"$PM2_HOME"} /root/.pm2 /home/*/.pm2; do
    [[ -d "$home" ]] || continue
    [[ -n "${PM2_SEEN[$home]:-}" ]] && continue
    PM2_SEEN[$home]=1
    dump="$home/dump.pm2"
    [[ -r "$dump" ]] || continue
    owner=$(stat -c '%U' "$home" 2>/dev/null || echo "-")
    SVC_PM2=1

    local name port script
    while IFS=$'\t' read -r name port script; do
      [[ -z "${name:-}" ]] && continue
      local pid="" state="stopped" running=0
      if pid=$(pm2_running_pid "$home" "$name"); then
        state="running"; running=1
      fi
      local ports=""
      # A declared PORT is a host port with no container indirection.
      # "-" for the container port: pm2 binds the host port directly, so
      # rendering it as 4200 -> 4200 would imply an indirection that only
      # containers have.
      [[ "$port" =~ ^[0-9]+$ ]] && ports="tcp/${port}>-@0.0.0.0"
      emit_service "pm2" "$name" "${owner}:${name}" "$state" "$running" \
        "$([[ $running -eq 1 ]] && echo "online (pid $pid)" || echo "stopped")" \
        "${script:-}" "$home" "$ports" ""
    done < <(pm2_dump_apps "$dump")
  done
}

collect_systemd_services() {
  have systemctl || return 0
  SVC_SYSTEMD=1

  # "Supposed to be running" is what makes a stopped unit worth reporting.
  # Every inactive unit on a host is hundreds of rows of noise; an ENABLED
  # unit that is not active, or any unit that FAILED, is a real signal.
  local enabled
  enabled=$(systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager 2>/dev/null | awk '{print $1}')

  local name load active sub rest
  while read -r name load active sub rest; do
    [[ -z "${name:-}" ]] && continue
    case "$name" in *.service) ;; *) continue ;; esac

    local state=""
    if [[ "$active" == "failed" || "$sub" == "failed" ]]; then
      state="failed"
    elif [[ "$active" != "active" ]] && printf '%s\n' "$enabled" | grep -qxF "$name"; then
      state="inactive"
    else
      continue
    fi

    # Type and the unit file in one read. `systemctl show` needs no
    # privilege for either; the sudoers grant is only a fallback.
    local props utype src
    props=$(systemctl show -p Type -p FragmentPath "$name" 2>/dev/null) || props=""
    utype=$(sed -n 's/^Type=//p' <<<"$props")
    src=$(sed -n 's/^FragmentPath=//p' <<<"$props")
    [[ -n "$src" ]] || src=$(run_priv systemctl show -p FragmentPath --value "$name" 2>/dev/null) || src=""

    # A oneshot or idle unit that has finished is inactive BY DESIGN — it
    # ran, it exited, that is the whole contract. Reporting those buries the
    # services that actually stopped under rows of snapd.* and
    # apparmor.service. A FAILED unit is still reported whatever its type.
    if [[ "$state" == "inactive" ]]; then
      case "$utype" in oneshot|idle) continue ;; esac
    fi

    emit_service "systemd" "$name" "$name" "$state" 0 "$active/$sub" "${rest:-}" "$src" "" ""
  done < <(systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null)
}

# Docker's PortBindings map, flattened to the compact port encoding the TSV
# carries: "tcp/8080>3000@0.0.0.0;tcp/8443>443@0.0.0.0".
#
# Parsed with grep/sed rather than a JSON tool because the collector may not
# have one, and because the shape is fixed and tiny:
#   {"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}],...}
# The PORTS column of `docker ps`, flattened to the compact encoding.
#
# Two shapes, and the difference matters:
#
#   0.0.0.0:8000->8080/tcp   PUBLISHED — bound on the host, reachable
#   3000/tcp                 EXPOSED only — listening inside the container's
#                            own namespace, not bound on the host at all
#
# The second is why a host running forty containers can show eighteen open
# ports: most containers only ever talk to each other. They are still part
# of "what is running here", so they are recorded with bind=container, which
# is what keeps them out of every reachability verdict — a container-internal
# port is not exposed and must never be counted as such.
#
# IPv6 twins ([::]:80->80/tcp) are dropped: same published port, said twice.
expand_port_range() {
  local spec=$1 lo hi i
  if [[ "$spec" == *-* ]]; then
    lo=${spec%%-*}; hi=${spec##*-}
    [[ "$lo" =~ ^[0-9]+$ && "$hi" =~ ^[0-9]+$ ]] || return 0
    (( hi < lo )) && return 0
    # A published range of any size is legal; enumerating a huge one would
    # bury the report, so cap it and keep the ends.
    (( hi - lo > 32 )) && hi=$((lo + 32))
    for (( i = lo; i <= hi; i++ )); do printf '%s\n' "$i"; done
  else
    [[ "$spec" =~ ^[0-9]+$ ]] && printf '%s\n' "$spec"
  fi
}

parse_ps_ports() {
  local raw=${1-}
  [[ -z "$raw" ]] && return 0
  local out="" entry
  while IFS= read -r entry; do
    entry=$(sed 's/^ *//; s/ *$//' <<<"$entry")
    [[ -z "$entry" ]] && continue

    local proto hostbind hp cp hostports cports
    if [[ "$entry" == *"->"* ]]; then
      local hostpart contpart
      hostpart=${entry%%->*}
      contpart=${entry#*->}
      proto=${contpart##*/}
      cports=${contpart%%/*}
      hostports=${hostpart##*:}
      hostbind=${hostpart%:*}
      # "[::]" is the IPv6 half of the same publish.
      [[ "$hostbind" == "["* ]] && continue
      [[ -z "$hostbind" ]] && hostbind="0.0.0.0"
    else
      proto=${entry##*/}
      hostports=${entry%%/*}
      cports=$hostports
      hostbind="container"
    fi
    case "$proto" in tcp|udp) ;; *) continue ;; esac

    # Ranges map one-to-one host->container, in order.
    local -a hlist=() clist=()
    while IFS= read -r hp; do hlist+=("$hp"); done < <(expand_port_range "$hostports")
    while IFS= read -r cp; do clist+=("$cp"); done < <(expand_port_range "$cports")
    local n=${#hlist[@]} i
    (( n == 0 )) && continue
    for (( i = 0; i < n; i++ )); do
      local c=${clist[i]:-${clist[0]:-${hlist[i]}}}
      out+="${proto}/${hlist[i]}>${c}@${hostbind};"
    done
  done < <(tr ',' '\n' <<<"$raw")
  printf '%s' "${out%;}"
}

parse_port_bindings() {
  local json=${1-}
  [[ -z "$json" || "$json" == "null" || "$json" == "{}" ]] && return 0
  local out="" block cport cproto hostip hostport
  while IFS= read -r block; do
    [[ -z "$block" ]] && continue
    cport=${block%%/*}; cport=${cport#\"}
    cproto=${block#*/}; cproto=${cproto%%\"*}
    [[ "$cport" =~ ^[0-9]+$ ]] || continue
    case "$cproto" in tcp|udp) ;; *) continue ;; esac
    # Every HostPort in this block; a container may publish one container
    # port on several host ports.
    local hp
    while IFS= read -r hp; do
      hostport=$(sed -n 's/.*"HostPort":"\([0-9]*\)".*/\1/p' <<<"$hp")
      hostip=$(sed -n 's/.*"HostIp":"\([^"]*\)".*/\1/p' <<<"$hp")
      [[ "$hostport" =~ ^[0-9]+$ ]] || continue
      [[ -z "$hostip" ]] && hostip="0.0.0.0"
      out+="${cproto}/${hostport}>${cport}@${hostip};"
    done < <(grep -oE '\{[^{}]*"HostPort":"[0-9]+"[^{}]*\}' <<<"$block")
  done < <(grep -oE '"[0-9]+/(tcp|udp)":\[[^]]*\]' <<<"$json")
  printf '%s' "${out%;}"
}

collect_container_services() {
  local rt bin
  for rt in docker podman; do
    have "$rt" || continue

    local out ok=0
    if out=$(run_priv "$rt" ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null); then
      ok=1
    fi
    if (( ok == 0 )); then
      # No grant (the common, intended default) — say so rather than
      # letting "no containers found" stand in for "never looked".
      SVC_CONTAINERS_BLOCKED=1
      continue
    fi
    SVC_CONTAINERS=1

    local line cid cname cimage cstatus cports
    while IFS='|' read -r cid cname cimage cstatus cports; do
      [[ -z "${cid:-}" ]] && continue

      local state running=0 exitcode=""
      case "$cstatus" in
        Up*Paused*)  state="paused" ;;
        Up*)         state="running"; running=1 ;;
        Exited*)
          state="exited"
          exitcode=$(sed -n 's/^Exited (\([0-9]*\)).*/\1/p' <<<"$cstatus")
          ;;
        Created*)    state="created" ;;
        Restarting*) state="restarting" ;;
        Dead*)       state="dead" ;;
        *)           state="unknown" ;;
      esac

      # A running container's published ports already arrive through `ss`
      # (or the NAT table) with full attribution. The ones worth an extra
      # call are precisely the ones with no socket to find them by.
      # A RUNNING container's ports are already in the ps output, published
      # and container-internal alike — no extra call, and it is the only way
      # to see the container-only ones at all. A STOPPED container's PORTS
      # column is empty, so that one needs the inspect.
      local ports=""
      if (( running == 1 )); then
        ports=$(parse_ps_ports "${cports:-}")
      else
        local bindings
        bindings=$(run_priv "$rt" inspect --format '{{json .HostConfig.PortBindings}}' "$cid" 2>/dev/null) || bindings=""
        ports=$(parse_port_bindings "$bindings")
      fi

      emit_service "$rt" "${cname:-$cid}" "${cid:0:12}" "$state" "$running" "$cstatus" "${cimage:-}" "" "$ports" "${exitcode:-}"
    done <<<"$out"
  done
}

# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

# "-" is the TSV's placeholder for an empty field (see emit_service). It is
# an artifact of the on-disk format and must never reach the JSON, where an
# absent sourcePath would otherwise read as a path literally named "-".
nz() { [[ "${1-}" == "-" ]] && printf '' || printf '%s' "${1-}"; }

json_esc() {
  local s=${1-}
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//$'\t'/ }; s=${s//$'\n'/ }; s=${s//$'\r'/ }
  printf '%s' "$s"
}

render_json() {
  (( CONTAINERS_SEEN > 0 )) && note_degraded "container id could not be resolved to a name/image (no Docker socket access — see docs/posture/posture-spec.md §4); reported as docker:<id> / podman:<id>"

  local reasons_json="["
  local first=1 r
  for r in "${DEGRADED_REASONS[@]:-}"; do
    [[ -z "$r" ]] && continue
    [[ $first -eq 0 ]] && reasons_json+=","; first=0
    reasons_json+="\"$(json_esc "$r")\""
  done
  reasons_json+="]"

  printf '{'
  printf '"schemaVersion":1,'
  printf '"scanner":"shellius-posture-collect/%s",' "$VERSION"
  printf '"collectedAt":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '"hostname":"%s",' "$(json_esc "$(hostname -f 2>/dev/null || hostname)")"
  printf '"collectorOk":%s,' "$([[ $DEGRADED -eq 0 ]] && echo true || echo false)"
  if (( ${#DEGRADED_REASONS[@]} > 0 )); then
    printf '"degradedReason":"%s",' "$(json_esc "${DEGRADED_REASONS[0]}")"
    printf '"degradedReasons":%s,' "$reasons_json"
  else
    printf '"degradedReason":null,'
  fi
  printf '"firewall":{"engine":"%s","active":%s,"defaultIncoming":"%s"},' \
    "$FW_ENGINE" "$([[ $FW_ACTIVE -eq 1 ]] && echo true || echo false)" "$FW_DEFAULT_IN"

  printf '"listeners":['
  local first2=1 proto bind port cport class reach svc ownerKind ownerName detail user oid src pids bypass source
  while IFS=$'\t' read -r proto bind port cport class reach svc ownerKind ownerName detail user oid src pids bypass source; do
    [[ $first2 -eq 0 ]] && printf ','; first2=0
    printf '{"proto":"%s","bind":"%s","port":%s,"containerPort":%s,"bindClass":"%s","reachability":"%s","service":"%s","ownerKind":"%s","ownerName":"%s","ownerDetail":"%s","ownerUser":"%s","ownerId":"%s","sourcePath":"%s","pids":"%s","dockerFirewallBypass":%s,"source":"%s"}' \
      "$(json_esc "$proto")" "$(json_esc "$bind")" "$port" \
      "$([[ -n "$cport" && "$cport" != "-" ]] && echo "$cport" || echo null)" \
      "$(json_esc "$class")" "$(json_esc "$reach")" "$(json_esc "$svc")" \
      "$(json_esc "$ownerKind")" "$(json_esc "$ownerName")" "$(json_esc "$detail")" \
      "$(json_esc "$user")" "$(json_esc "$oid")" "$(json_esc "$src")" "$(json_esc "$pids")" \
      "$([[ "$bypass" == "1" ]] && echo true || echo false)" "$(json_esc "$source")"
  done < <(sort -t$'\t' -k3,3n "$ENRICHED")
  printf '],'

  printf '"services":['
  local first4=1 skind sname sref sstate srunning sstatus sdetail ssrc sports sexit
  while IFS=$'\t' read -r skind sname sref sstate srunning sstatus sdetail ssrc sports sexit; do
    [[ -z "${skind:-}" ]] && continue
    [[ $first4 -eq 0 ]] && printf ','; first4=0
    printf '{"kind":"%s","name":"%s","ref":"%s","state":"%s","running":%s,"statusText":"%s","detail":"%s","sourcePath":"%s","exitCode":%s,"ports":[' \
      "$(json_esc "$skind")" "$(json_esc "$sname")" "$(json_esc "$(nz "$sref")")" "$(json_esc "$sstate")" \
      "$([[ "$srunning" == "1" ]] && echo true || echo false)" \
      "$(json_esc "$(nz "$sstatus")")" "$(json_esc "$(nz "$sdetail")")" "$(json_esc "$(nz "$ssrc")")" \
      "$([[ "$sexit" =~ ^[0-9]+$ ]] && echo "$sexit" || echo null)"
    # ports: "tcp/8080>3000@0.0.0.0;tcp/8443>443@0.0.0.0"
    local firstp=1 pentry pproto pport pcport pbind
    if [[ -n "$sports" && "$sports" != "-" ]]; then
      local IFS_SAVE=$IFS; IFS=';'
      for pentry in $sports; do
        [[ -z "$pentry" ]] && continue
        pproto=${pentry%%/*}
        pport=${pentry#*/}; pport=${pport%%>*}
        pcport=${pentry#*>}; pcport=${pcport%%@*}
        pbind=${pentry#*@}
        [[ "$pport" =~ ^[0-9]+$ ]] || continue
        [[ $firstp -eq 0 ]] && printf ','; firstp=0
        printf '{"proto":"%s","port":%s,"containerPort":%s,"bind":"%s"}' \
          "$(json_esc "$pproto")" "$pport" \
          "$([[ "$pcport" =~ ^[0-9]+$ ]] && echo "$pcport" || echo null)" \
          "$(json_esc "$pbind")"
      done
      IFS=$IFS_SAVE
    fi
    printf ']}'
  done < "$SERVICES"
  printf '],'

  # Which halves of the service scan actually ran. A host that never looked
  # for containers must not be indistinguishable from one that looked and
  # found none — that difference is the whole value of the field.
  printf '"serviceScan":{"systemd":%s,"containers":%s,"containersBlocked":%s,"pm2":%s},' \
    "$([[ $SVC_SYSTEMD -eq 1 ]] && echo true || echo false)" \
    "$([[ $SVC_CONTAINERS -eq 1 ]] && echo true || echo false)" \
    "$([[ $SVC_CONTAINERS_BLOCKED -eq 1 ]] && echo true || echo false)" \
    "$([[ $SVC_PM2 -eq 1 ]] && echo true || echo false)"

  printf '"firewallRules":['
  local first3=1 pspec rproto action from engine
  while IFS=$'\t' read -r pspec rproto action from engine; do
    [[ $first3 -eq 0 ]] && printf ','; first3=0
    printf '{"port":"%s","proto":"%s","action":"%s","from":"%s","engine":"%s"}' \
      "$(json_esc "$pspec")" "$(json_esc "$rproto")" "$(json_esc "$action")" \
      "$(json_esc "$from")" "$(json_esc "$engine")"
  done < "$FWRULES"
  printf ']'
  printf '}\n'
}

collect_listeners
collect_firewall
collect_nat_dnat
collect_nat_listeners
collect_systemd_services
collect_container_services
collect_pm2_services
analyze
render_json
[[ $SS_OK -eq 1 ]] || exit 2
exit 0
