#!/usr/bin/env bash
#
# shellius-posture-scan.sh — standalone port/service exposure scanner.
#
# Answers the question "what is listening on this box, who owns it, and can
# the internet reach it?" by joining three sources that are normally looked
# at separately:
#
#   1. Listening sockets        (ss, plus Docker published ports)
#   2. Process ownership        (/proc/<pid>/cgroup, /proc/<pid>/environ)
#   3. Host firewall            (ufw, with an iptables/nft fallback)
#
# It deliberately has NO dependencies beyond bash 4 + coreutils + iproute2.
# docker / pm2 / ufw are all optional — each is used if present, skipped if not.
# Nothing is written to disk, nothing is sent anywhere, nothing is changed.
# Read-only by design: safe to run on production.
#
# Usage:
#   sudo ./shellius-posture-scan.sh              # human-readable report
#   sudo ./shellius-posture-scan.sh --wide       # every column, ignore width
#   sudo ./shellius-posture-scan.sh --all        # include loopback-only services
#   sudo ./shellius-posture-scan.sh --json       # machine-readable snapshot
#
# Flags:
#   --json            JSON snapshot (always carries every field)
#   --all             include loopback-only listeners
#   --wide            force all columns regardless of terminal width
#   --no-color        plain output
#   --unprivileged    scan without root; attribution will be incomplete
#
# Root is required by default: mapping a port to its owning service means
# reading /proc/<pid>/{cgroup,environ} for OTHER users' processes, which the
# kernel only exposes to root.
#
# Exit codes: 0 = clean, 1 = findings at HIGH or above, 2 = scan error.
#
# This is WIP scaffolding for the Shellius posture feature — the intent is that
# the logic here graduates into the host agent once the taxonomy is settled.

set -uo pipefail

VERSION="0.1.0"
JSON=0
COLOR=1
SHOW_ALL=0
WIDE=0
ALLOW_UNPRIV=0
ORIG_ARGS="$*"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)     JSON=1; COLOR=0 ;;
    --no-color) COLOR=0 ;;
    --all)      SHOW_ALL=1 ;;
    --unprivileged) ALLOW_UNPRIV=1 ;;
    --wide)     WIDE=1 ;;
    -h|--help)  usage ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[[ -t 1 ]] || COLOR=0

if [[ $COLOR -eq 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_CYA=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_RED=""; C_YEL=""; C_GRN=""; C_CYA=""
fi

log() { [[ $JSON -eq 1 ]] || echo "$@" >&2; }

TMP=$(mktemp -d) || { echo "cannot create temp dir" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

ENDPOINTS="$TMP/endpoints.tsv"   # proto bind port pids pname kind owner detail user source cport oid src
ENRICHED="$TMP/enriched.tsv"     # ... + bindclass reach service
FWRULES="$TMP/fw.tsv"            # portspec proto action from
FINDINGS="$TMP/findings.tsv"     # severity code proto port bind owner message
: > "$ENDPOINTS"; : > "$FWRULES"; : > "$FINDINGS"; : > "$ENRICHED"

IS_ROOT=0
[[ $(id -u) -eq 0 ]] && IS_ROOT=1

# Attribution reads /proc/<pid>/cgroup and /proc/<pid>/environ for processes
# owned by OTHER users — that is the whole point on a shared box, and the
# kernel only exposes it to root. Without it nearly every listener degrades to
# "unknown", which looks like a working scan while being useless. Stop instead.
if [[ $IS_ROOT -eq 0 && $ALLOW_UNPRIV -eq 0 ]]; then
  SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
  {
    printf '\n  %s%s ROOT REQUIRED%s\n\n' "$C_RED$C_BOLD" "▲" "$C_RESET"
    printf '  Mapping ports to owning services means reading /proc/<pid>/cgroup and\n'
    printf '  /proc/<pid>/environ for processes belonging to other users — Docker\n'
    printf '  containers, other people%ss pm2 apps, system daemons. The kernel only\n' "'"
    printf '  shows those to root, so without it almost every port comes back as\n'
    printf '  %sunknown%s and the scan is worse than useless: it looks clean.\n\n' '"' '"'
    printf '  %sRun:%s\n\n' "$C_BOLD" "$C_RESET"
    printf '      %ssudo %s%s%s\n\n' "$C_CYA" "$SELF" "${ORIG_ARGS:+ $ORIG_ARGS}" "$C_RESET"
    printf '  %s(--unprivileged scans anyway, with partial attribution)%s\n\n' "$C_DIM" "$C_RESET"
  } >&2
  exit 2
fi
if [[ $IS_ROOT -eq 0 ]]; then
  log "${C_YEL}warning:${C_RESET} running unprivileged — attribution will be incomplete."
fi

have() { command -v "$1" >/dev/null 2>&1; }

# Every value below ends up in a TAB-separated record. Container names, image
# tags, cmdlines and paths are all attacker-or-accident controlled, and a
# single embedded tab silently shifts every later column. Strip them at the
# point of collection rather than trusting the source.
clean() {
  local v=${1-}
  v=${v//$'\t'/ }; v=${v//$'\n'/ }; v=${v//$'\r'/ }
  printf '%s' "$v"
}

# ---------------------------------------------------------------------------
# Port knowledge base
# ---------------------------------------------------------------------------

# Ports that should essentially never face the internet unauthenticated.
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

# Ports where public exposure is the normal, intended state.
declare -A EXPECTED_PUBLIC=( [22]="SSH" [80]="HTTP" [443]="HTTPS" )

port_label() { echo "${SENSITIVE[$1]:-}"; }

# Ports get remapped constantly (5433 for Postgres, 6380 for Redis, ...), so a
# port-number lookup alone misses the majority of real deployments. Identify
# the service from the image / unit / process name too, and treat the CONTAINER
# port as authoritative when we have it.
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

# Resolve the service identity for one endpoint, best evidence first.
#
# When a container port is known it is AUTHORITATIVE and the host port must
# never be consulted: in `-p 8086:80` the 8086 is an arbitrary choice by
# whoever wrote the compose file, and looking it up in a port table turns a
# WordPress container into a false "InfluxDB exposed" critical.
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
# Step 1 — process ownership resolution
# ---------------------------------------------------------------------------

# Read a single env var out of a process, NUL-delimited. Root only.
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

# Cache container metadata — one container often owns several ports.
# Containers are not always root's: rootless Docker and Podman both run under
# a user's own daemon, and `docker inspect` as root simply will not see them.
# So we try root's docker, then podman, then the owning user's own runtime.
declare -A CONTAINER_CACHE=()
container_meta() {
  local cid=$1 runtime=${2:-docker} owner=${3:-} uid=${4:-}
  local ck="$cid"
  if [[ -n "${CONTAINER_CACHE[$ck]:-}" ]]; then echo "${CONTAINER_CACHE[$ck]}"; return; fi

  local fmt='{{.Name}}|{{.Config.Image}}|{{.State.Pid}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}'
  local raw="" meta="-|-|-|-|-"
  local try
  for try in "$runtime" docker podman; do
    have "$try" || continue
    raw=$("$try" inspect --format "$fmt" "$cid" 2>/dev/null) && [[ -n "$raw" ]] && break
    raw=""
    # rootless: the daemon belongs to the user, not to root
    if [[ -n "$owner" && "$owner" != "-" && "$owner" != "root" && -n "$uid" ]]; then
      raw=$(sudo -n -u "$owner" XDG_RUNTIME_DIR="/run/user/$uid" \
              "$try" inspect --format "$fmt" "$cid" 2>/dev/null) && [[ -n "$raw" ]] && break
      raw=""
    fi
  done

  [[ -n "$raw" ]] && meta="${raw#/}"
  CONTAINER_CACHE[$ck]=$meta
  echo "$meta"
}

# Back-compat shim for the docker-ps collection path.
docker_meta() { container_meta "$1" docker; }

# Where the service was actually started from — the thing you need in order to
# go and change it. Compose project dir, pm2 cwd, unit file path, or plain cwd.
resolve_source() {
  local kind=$1 pid=$2 cid=${3:-} unit=${4:-}
  local src=""

  case "$kind" in
    docker*|podman*|container)
      if [[ -n "$cid" ]]; then
        local meta wdir cfg
        meta=$(container_meta "$cid")
        wdir=$(cut -d'|' -f4 <<<"$meta"); cfg=$(cut -d'|' -f5 <<<"$meta")
        [[ "$wdir" == "<no value>" ]] && wdir=""
        [[ "$cfg"  == "<no value>" ]] && cfg=""
        # a compose file path is more actionable than its directory
        if [[ -n "$cfg" && "$cfg" != "-" ]]; then src=${cfg%%,*}
        elif [[ -n "$wdir" && "$wdir" != "-" ]]; then src=$wdir
        fi
      fi
      ;;
    pm2)
      src=$(read_env "$pid" "pm_cwd" 2>/dev/null || echo "")
      [[ -z "$src" ]] && src=$(read_env "$pid" "PWD" 2>/dev/null || echo "")
      ;;
    systemd|systemd-user)
      if [[ -n "$unit" ]] && have systemctl; then
        local uflag=""
        [[ "$kind" == "systemd-user" ]] && uflag="--user"
        src=$(systemctl $uflag show -p FragmentPath --value "$unit" 2>/dev/null)
      fi
      ;;
  esac

  # Fall back to the process's own working directory.
  if [[ -z "$src" || "$src" == "-" ]]; then
    [[ -n "$pid" && "$pid" != "-" ]] && src=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "")
  fi
  printf '%s' "${src:--}"
}

# Resolve a pid to owner kind + name + detail + identifier.
# Emits: kind<TAB>name<TAB>detail<TAB>id
# The id is whatever uniquely names the thing in its own tooling, so the
# report can be acted on directly: a 12-char container id you can `docker
# logs`, a pm2 id you can `pm2 restart`, a systemd unit you can `systemctl`.
resolve_owner() {
  local pid=$1 pname=${2:-}
  local kind="process" name="$pname" detail=""

  # --- docker-proxy is special: it is a shim, the real owner is the container.
  if [[ "$pname" == "docker-proxy" ]]; then
    local cmd; cmd=$(proc_cmdline "$pid" 2>/dev/null || echo "")
    local cip cport
    cip=$(grep -oE '\-container-ip [0-9.]+' <<<"$cmd" | awk '{print $2}')
    cport=$(grep -oE '\-container-port [0-9]+' <<<"$cmd" | awk '{print $2}')
    printf 'docker-proxy\tdocker-proxy\t-> %s:%s\t-\n' "${cip:-?}" "${cport:-?}"
    return
  fi

  # --- cgroup tells us docker / systemd / k8s membership.
  local cg="" cid="" unit=""
  if [[ -r "/proc/$pid/cgroup" ]]; then
    cg=$(cat "/proc/$pid/cgroup" 2>/dev/null)
  fi

  local owner_user owner_uid=""
  owner_user=$(proc_user "$pid")
  [[ -r "/proc/$pid/status" ]] && owner_uid=$(awk '/^Uid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)

  if [[ -n "$cg" ]]; then
    # 64-hex container id — docker, podman (libpod-<id>.scope), containerd
    cid=$(grep -oE '[0-9a-f]{64}' <<<"$cg" | head -1)
    if [[ -n "$cid" ]]; then
      local runtime="docker"
      [[ "$cg" == *libpod* ]] && runtime="podman"
      local meta cname cimage
      meta=$(container_meta "$cid" "$runtime" "$owner_user" "$owner_uid")
      cname=${meta%%|*}; cimage=$(cut -d'|' -f2 <<<"$meta")
      # Rootless containers live under the user slice; say so, because
      # "docker exec" as root will not find them.
      local kindlbl="$runtime"
      [[ "$cg" == *"user@"* ]] && kindlbl="${runtime}-rootless"
      if [[ "$cname" == "-" || -z "$cname" ]]; then
        # runtime not reachable from here — still report the container honestly
        printf 'container\t%s\t%s\t%s\n' "${runtime}:${cid:0:12}" "-" "${cid:0:12}"
      else
        printf '%s\t%s\t%s\t%s\n' "$kindlbl" "${cname:--}" "${cimage:--}" "${cid:0:12}"
      fi
      return
    fi
    # systemd unit — take the innermost .service/.scope component
    unit=$(grep -oE '[^/]+\.(service|scope)' <<<"$cg" | grep -vE '^user@[0-9]+\.service$' | tail -1)
  fi

  # --- pm2: the child process carries pm_id / pm_exec_path in its environment.
  if [[ $IS_ROOT -eq 1 ]]; then
    local pm_id pm_name pm_exec
    pm_id=$(read_env "$pid" "pm_id" 2>/dev/null || echo "")
    if [[ -n "$pm_id" ]]; then
      pm_name=$(read_env "$pid" "name" 2>/dev/null || echo "")
      pm_exec=$(read_env "$pid" "pm_exec_path" 2>/dev/null || echo "")
      # Every user runs their own pm2 daemon with its own PM2_HOME and its own
      # id space, so "#3" is only actionable together with the owning user.
      # A non-default PM2_HOME is appended, since `pm2 restart 3` needs it.
      local pm_home; pm_home=$(read_env "$pid" "PM2_HOME" 2>/dev/null || echo "")
      local pm_ref="#$pm_id"
      if [[ -n "$pm_home" && "$pm_home" != "/home/$owner_user/.pm2" && "$pm_home" != "/root/.pm2" ]]; then
        pm_ref="#$pm_id@$pm_home"
      fi
      printf 'pm2\t%s\t%s\t%s\n' "${pm_name:-pm_id:$pm_id}" "${pm_exec:--}" "$pm_ref"
      return
    fi
    # Fallback: parent is the PM2 God Daemon but env was stripped.
    local ppid pcmd
    ppid=$(proc_ppid "$pid" 2>/dev/null || echo "")
    if [[ -n "$ppid" && "$ppid" != "0" ]]; then
      pcmd=$(proc_cmdline "$ppid" 2>/dev/null || echo "")
      if [[ "$pcmd" == *"God Daemon"* || "$pcmd" == *"PM2 v"* ]]; then
        printf 'pm2\t%s\t%s\t-\n' "${pname:-node}" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)"
        return
      fi
    fi
  fi

  # --- systemd unit: system-wide, or a per-user unit under user@<uid>.service
  if [[ -n "$unit" && "$unit" != "-.scope" && "$unit" != "init.scope" ]]; then
    local ukind="systemd"
    [[ "$cg" == *"user@"* ]] && ukind="systemd-user"
    printf '%s\t%s\t%s\t%s\n' "$ukind" "$unit" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)" "$unit"
    return
  fi

  # --- unattributed raw process
  printf '%s\t%s\t%s\t-\n' "$kind" "${name:-unknown}" "$(proc_cmdline "$pid" 2>/dev/null | cut -c1-80)"
}

# ---------------------------------------------------------------------------
# Step 2 — listening sockets via ss
# ---------------------------------------------------------------------------

normalize_bind() {
  # strips [] around v6, drops %iface suffix, maps wildcards to 0.0.0.0 / ::
  local b=$1
  b=${b%\%*}
  b=${b#[}
  b=${b%]}
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

collect_listeners() {
  have ss || { log "${C_RED}error:${C_RESET} 'ss' not found (install iproute2)"; return 1; }

  local raw
  raw=$(ss -H -tulpn 2>/dev/null) || raw=""
  if [[ -z "$raw" ]]; then
    # older iproute2 without -H
    raw=$(ss -tulpn 2>/dev/null | tail -n +2)
  fi

  local netid state rq sq local_addr peer rest
  while read -r netid state rq sq local_addr peer rest; do
    [[ -z "${netid:-}" ]] && continue
    # tcp sockets only matter when LISTEN; udp shows as UNCONN
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

    # users:(("nginx",pid=812,fd=6),("nginx",pid=813,fd=6))
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
    # A blank field would collapse on read and shift every column after it.
    kind=${kind:-unknown}; owner=${owner:-unknown}
    detail=${detail:--}; oid=${oid:--}; user=${user:--}

    local src="-"
    if [[ -n "$first_pid" ]]; then
      local scid=""
      [[ "$kind" == docker* || "$kind" == podman* || "$kind" == container ]] && scid=$oid
      src=$(clean "$(resolve_source "$kind" "$first_pid" "$scid" "$owner")")
    fi

    local proto=${netid%6}
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$proto" "$bind" "$port" "${pids:--}" "${pname:--}" \
      "${kind:-unknown}" "${owner:-unknown}" "${detail:--}" "${user:--}" "ss" "-" \
      "${oid:--}" "${src:--}" >> "$ENDPOINTS"
  done <<<"$raw"
}

# ---------------------------------------------------------------------------
# Step 3 — Docker published ports
#
# Critical case: with userland-proxy=false there is NO host listener and NO
# docker-proxy process, so `ss` shows nothing at all — yet the port is fully
# reachable from outside via a nat/PREROUTING DNAT rule. Those ports are
# invisible to every naive "check open ports" script, which is exactly why
# they are the ones that end up exposed.
# ---------------------------------------------------------------------------

collect_docker() {
  have docker || return 0
  docker info >/dev/null 2>&1 || { log "${C_DIM}note: docker present but not queryable (need root?)${C_RESET}"; return 0; }

  local line cid names image ports
  while IFS=$'\t' read -r cid names image ports _rest; do
    [[ -z "${cid:-}" ]] && continue
    [[ -z "${ports:-}" ]] && continue

    # "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 8080/tcp"
    local entry
    while IFS= read -r entry; do
      entry=$(sed 's/^ *//; s/ *$//' <<<"$entry")
      [[ -z "$entry" ]] && continue
      # only published mappings have "->"
      [[ "$entry" == *"->"* ]] || continue

      local hostpart contpart hostbind hostport proto cport
      hostpart=${entry%%->*}
      contpart=${entry#*->}
      proto=${contpart##*/}
      cport=${contpart%%/*}
      hostport=${hostpart##*:}
      hostbind=${hostpart%:*}
      hostbind=$(normalize_bind "$hostbind")
      [[ "$hostport" =~ ^[0-9]+$ ]] || continue

      local cmeta cpid cuser
      cmeta=$(docker_meta "$cid"); cpid=$(cut -d'|' -f3 <<<"$cmeta")
      [[ "$cpid" =~ ^[0-9]+$ && "$cpid" != "0" ]] || cpid="-"
      # We reached this container through the system daemon's socket, so the
      # runtime owner is root. The container's internal uid is NOT a host user.
      cuser="root"
      local csrc; csrc=$(clean "$(resolve_source docker "$cpid" "$cid")")
      names=$(clean "$names"); image=$(clean "$image")
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$proto" "$hostbind" "$hostport" "$cpid" "-" \
        "docker" "$names" "$image" "$cuser" "docker" "$cport" "${cid:0:12}" "$csrc" >> "$ENDPOINTS"
    done < <(tr ',' '\n' <<<"$ports")
  done < <(docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null)
}

# ---------------------------------------------------------------------------
# Step 4 — firewall state
# ---------------------------------------------------------------------------

FW_ENGINE="none"
FW_ACTIVE=0
FW_DEFAULT_IN="unknown"

collect_firewall() {
  if have ufw; then
    local status
    status=$(ufw status verbose 2>/dev/null) || status=""
    if [[ -n "$status" ]]; then
      FW_ENGINE="ufw"
      grep -q "^Status: active" <<<"$status" && FW_ACTIVE=1
      FW_DEFAULT_IN=$(grep -oE 'Default: [a-z]+ \(incoming\)' <<<"$status" | awk '{print $2}')
      [[ -n "$FW_DEFAULT_IN" ]] || FW_DEFAULT_IN="unknown"

      # To / Action / From table
      local line spec action from
      while IFS= read -r line; do
        [[ "$line" =~ (ALLOW|DENY|REJECT|LIMIT)[[:space:]] ]] || continue
        # skip egress rules — we only care about ingress
        [[ "$line" =~ (ALLOW|DENY|REJECT|LIMIT)[[:space:]]+OUT ]] && continue

        action=$(grep -oE '(ALLOW|DENY|REJECT|LIMIT)' <<<"$line" | head -1)
        spec=$(sed -E "s/[[:space:]]+(ALLOW|DENY|REJECT|LIMIT).*//" <<<"$line" | sed 's/ *$//')
        from=$(sed -E "s/.*(ALLOW|DENY|REJECT|LIMIT)([[:space:]]+IN)?[[:space:]]+//" <<<"$line" | sed 's/ *$//')

        # "80,443/tcp", "6000:6007/tcp", "22/tcp (v6)", "22"
        spec=$(sed 's/ *(v6)//' <<<"$spec")
        local pspec proto
        if [[ "$spec" == */* ]]; then
          pspec=${spec%%/*}; proto=${spec##*/}
        else
          pspec=$spec; proto="any"
        fi
        [[ "$pspec" =~ ^[0-9,:]+$ ]] || continue

        printf '%s\t%s\t%s\t%s\n' "$pspec" "$proto" "$action" "${from:-Anywhere}" >> "$FWRULES"
      done <<<"$status"
      return
    fi
  fi

  # Fallbacks — we can't reason about these as precisely, but we can report.
  if have nft && nft list ruleset >/dev/null 2>&1; then
    FW_ENGINE="nftables"
  elif have iptables; then
    FW_ENGINE="iptables"
    FW_DEFAULT_IN=$(iptables -S INPUT 2>/dev/null | awk '/^-P INPUT/{print tolower($3)}')
    [[ -n "$FW_DEFAULT_IN" ]] || FW_DEFAULT_IN="unknown"
    [[ "$FW_DEFAULT_IN" == "drop" ]] && FW_ACTIVE=1
  fi
}

# Does a ufw rule cover this port? Echoes ALLOW / DENY / NONE.
fw_verdict() {
  local port=$1 proto=$2
  [[ -s "$FWRULES" ]] || { echo "NONE"; return; }

  local pspec rproto action from
  while IFS=$'\t' read -r pspec rproto action from; do
    [[ "$rproto" == "any" || "$rproto" == "$proto" ]] || continue
    local match=0
    if [[ "$pspec" == *:* ]]; then          # range 6000:6007
      local lo=${pspec%%:*} hi=${pspec##*:}
      (( port >= lo && port <= hi )) && match=1
    elif [[ "$pspec" == *,* ]]; then        # list 80,443
      local p
      for p in ${pspec//,/ }; do [[ "$p" == "$port" ]] && match=1; done
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
# Step 5 — correlation and findings
#
# This is the whole point of the script. Each endpoint gets a reachability
# verdict from the join of (bind address x firewall x docker DNAT), and
# findings are raised from that verdict plus what the port is known to be.
# ---------------------------------------------------------------------------

add_finding() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" >> "$FINDINGS"
}

sev_rank() {
  case "$1" in
    CRITICAL) echo 4 ;; HIGH) echo 3 ;; MEDIUM) echo 2 ;; LOW) echo 1 ;; *) echo 0 ;;
  esac
}

declare -A REACH=()      # "proto:port" -> worst reachability across binds (drives findings)
declare -A OWNERLBL=()   # "proto:port" -> best owner label
declare -A BINDLBL=()    # "proto:port" -> bind that produced the worst verdict
declare -A BYPASS=()     # "proto:port" -> 1 if a Docker DNAT bypasses the firewall
declare -A SEEN_PORT=()  # "proto:port" -> 1
declare -A SVC=()        # "proto:port" -> resolved sensitive-service name
declare -A OID=()        # "proto:port" -> owner identifier (container id / pm2 id / unit)
declare -A OPID=()       # "proto:port" -> owning pid(s)
declare -A OUSER=()      # "proto:port" -> owning unix user
declare -A BEST=()       # "proto:bind:port" -> winning raw row
declare -A BESTSCORE=()
declare -A PIDS=()       # "proto:bind:port" -> pids from whichever row had them

reach_rank() {
  case "$1" in INTERNET) echo 4;; LAN) echo 3;; FIREWALLED) echo 2;; LOOPBACK) echo 1;; *) echo 0;; esac
}

# A published Docker port is reported twice — once by ss (as the docker-proxy
# shim) and once by `docker ps` (with image + container port). Same socket, two
# rows. Collapse them per proto:bind:port and keep the richest description.
dedupe_endpoints() {
  local proto bind port pids pname kind owner detail user source cport oid src
  while IFS=$'\t' read -r proto bind port pids pname kind owner detail user source cport oid src; do
    local key="$proto:$bind:$port"
    local score=0
    [[ "$kind" != "unknown" ]]                    && score=1
    [[ "$kind" == docker* || "$kind" == podman* || "$kind" == container ]] && \
      [[ "$source" == "ss" ]] && score=2   # host-network / rootless container
    [[ "$source" == "docker" ]]                    && score=3   # richest: image + container port

    [[ -n "$pids" && "$pids" != "-" ]] && PIDS[$key]=$pids

    if [[ -z "${BESTSCORE[$key]:-}" ]] || (( score > ${BESTSCORE[$key]} )); then
      BESTSCORE[$key]=$score
      BEST[$key]=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
        "$proto" "$bind" "$port" "$pids" "$pname" "$kind" "$owner" "$detail" "$user" "$source" "$cport" "$oid" "$src")
    fi
  done < "$ENDPOINTS"
}

analyze() {
  dedupe_endpoints

  local key
  for key in "${!BEST[@]}"; do
    local proto bind port pids pname kind owner detail user source cport oid src
    IFS=$'\t' read -r proto bind port pids pname kind owner detail user source cport oid src <<<"${BEST[$key]}"

    [[ ( -z "$pids" || "$pids" == "-" ) && -n "${PIDS[$key]:-}" ]] && pids=${PIDS[$key]}
    [[ "$cport" == "-" ]] && cport=""

    local pkey="$proto:$port"
    local class; class=$(bind_class "$bind")

    # Docker publishes bypass the ufw INPUT chain entirely: traffic is DNAT'd in
    # nat/PREROUTING and then traverses FORWARD, where ufw has no rules. So a
    # `ufw deny 5432` does NOT protect `docker run -p 5432:5432`.
    local is_docker_pub=0
    [[ "$source" == "docker" ]]      && is_docker_pub=1
    [[ "$kind" == "docker-proxy" ]]  && is_docker_pub=1

    local fw; fw=$(fw_verdict "$port" "$proto")

    local reach
    if [[ "$class" == "loopback" ]]; then
      reach="LOOPBACK"
    elif [[ $is_docker_pub -eq 1 ]]; then
      reach="INTERNET"
      if [[ "$fw" == "DENY" ]] || \
         [[ $FW_ACTIVE -eq 1 && "$fw" == "NONE" && "$FW_DEFAULT_IN" == "deny" ]]; then
        BYPASS[$pkey]=1
      fi
    elif [[ "$class" == "private" ]]; then
      reach="LAN"
    else
      if [[ "$fw" == "ALLOW" ]]; then
        reach="INTERNET"
      elif [[ "$fw" == "DENY" ]]; then
        reach="FIREWALLED"
      elif [[ $FW_ACTIVE -eq 1 && "$FW_DEFAULT_IN" == "deny" ]]; then
        reach="FIREWALLED"
      else
        reach="INTERNET"
      fi
    fi

    local svc; svc=$(service_identity "$port" "$cport" "$owner" "$detail" "$pname")

    local lbl
    case "$kind" in
      docker)          lbl="docker/${owner}" ;;
      docker-rootless) lbl="docker*/${owner}" ;;
      podman)          lbl="podman/${owner}" ;;
      podman-rootless) lbl="podman*/${owner}" ;;
      container)       lbl="${owner}" ;;
      docker-proxy)    lbl="docker/(proxy ${detail})" ;;
      pm2)             lbl="pm2/${owner}" ;;
      systemd)         lbl="systemd/${owner}" ;;
      systemd-user)    lbl="systemd*/${owner}" ;;
      unknown)         lbl="unknown(${owner})" ;;
      *)               lbl="${owner}" ;;
    esac

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$proto" "$bind" "$port" "${pids:--}" "${pname:--}" "$kind" "$owner" \
      "${detail:--}" "$user" "$source" "${cport:--}" "$class" "$reach" \
      "${svc:--}" "$lbl" "${oid:--}" "${src:--}" >> "$ENRICHED"

    # Roll up to proto:port for findings — worst bind wins.
    local prev=${REACH[$pkey]:-}
    if [[ -z "$prev" ]] || (( $(reach_rank "$reach") > $(reach_rank "$prev") )); then
      REACH[$pkey]=$reach
      BINDLBL[$pkey]=$bind
    fi
    [[ -n "$svc" ]] && SVC[$pkey]=$svc
    [[ -z "${OID[$pkey]:-}" || "${OID[$pkey]}" == "-" ]] && OID[$pkey]=${oid:--}
    [[ -z "${OPID[$pkey]:-}" || "${OPID[$pkey]}" == "-" ]] && OPID[$pkey]=${pids:--}
    [[ -z "${OUSER[$pkey]:-}" || "${OUSER[$pkey]}" == "-" ]] && OUSER[$pkey]=${user:--}
    if [[ -z "${OWNERLBL[$pkey]:-}" || "${OWNERLBL[$pkey]}" == docker/\(proxy* || "${OWNERLBL[$pkey]}" == unknown* ]]; then
      OWNERLBL[$pkey]=$lbl
    fi
    SEEN_PORT[$pkey]=1
  done

  # --- raise findings per unique proto:port
  for key in "${!REACH[@]}"; do
    local proto=${key%%:*} port=${key##*:}
    local reach=${REACH[$key]} owner=${OWNERLBL[$key]:-unknown} bind=${BINDLBL[$key]:-?}
    local sname=${SVC[$key]:-}
    local expected=${EXPECTED_PUBLIC[$port]:-}

    if [[ -n "${BYPASS[$key]:-}" ]]; then
      add_finding "CRITICAL" "DOCKER_FIREWALL_BYPASS" "$proto" "$port" "$bind" "$owner" \
        "${sname:+$sname — }Docker publishes this port; the DNAT rule bypasses the ufw INPUT chain, so the firewall rule covering it is NOT enforced. Bind to 127.0.0.1 or install ufw-docker."
      continue
    fi

    case "$reach" in
      INTERNET)
        if [[ -n "$sname" ]]; then
          add_finding "CRITICAL" "SENSITIVE_PORT_EXPOSED" "$proto" "$port" "$bind" "$owner" \
            "$sname is reachable from any source address."
        elif [[ -n "$expected" ]]; then
          add_finding "INFO" "EXPECTED_PUBLIC" "$proto" "$port" "$bind" "$owner" \
            "$expected — public exposure is expected here."
        else
          add_finding "HIGH" "PORT_EXPOSED" "$proto" "$port" "$bind" "$owner" \
            "Reachable from any source address and not a known-public service. Confirm this is intended."
        fi
        ;;
      FIREWALLED)
        [[ -n "$sname" ]] && add_finding "MEDIUM" "SENSITIVE_PORT_WILDCARD_BIND" "$proto" "$port" "$bind" "$owner" \
          "$sname binds $bind and is protected only by a firewall rule. Bind it to 127.0.0.1 so it is safe by construction."
        ;;
      LAN)
        [[ -n "$sname" ]] && add_finding "LOW" "SENSITIVE_PORT_LAN" "$proto" "$port" "$bind" "$owner" \
          "$sname is reachable from the local network."
        ;;
    esac

    [[ "$owner" == unknown* ]] && add_finding "LOW" "UNATTRIBUTED_LISTENER" "$proto" "$port" "$bind" "$owner" \
      "Could not attribute this listener to a container, pm2 app or systemd unit."
  done

  # --- stale firewall rules: an ALLOW for a port nothing listens on
  if [[ -s "$FWRULES" ]]; then
    local pspec rproto action from
    while IFS=$'\t' read -r pspec rproto action from; do
      [[ "$action" == "ALLOW" || "$action" == "LIMIT" ]] || continue
      [[ "$pspec" == *:* ]] && continue   # skip ranges, too noisy
      local p
      for p in ${pspec//,/ }; do
        local hit=0
        [[ -n "${SEEN_PORT[tcp:$p]:-}" ]] && hit=1
        [[ -n "${SEEN_PORT[udp:$p]:-}" ]] && hit=1
        [[ $hit -eq 0 ]] && add_finding "LOW" "STALE_FIREWALL_RULE" "${rproto}" "$p" "-" "-" \
          "ufw allows this port from ${from}, but nothing is listening on it. The rule can likely be removed."
      done
    done < "$FWRULES"
  fi

  if [[ "$FW_ENGINE" == "none" ]]; then
    add_finding "HIGH" "NO_HOST_FIREWALL" "-" "-" "-" "-" \
      "No host firewall detected — every listening port is reachable unless something upstream blocks it."
  elif [[ "$FW_ENGINE" == "ufw" && $FW_ACTIVE -eq 0 ]]; then
    add_finding "HIGH" "FIREWALL_INACTIVE" "-" "-" "-" "-" \
      "ufw is installed but inactive. Its rules are not being enforced."
  fi
}

# ---------------------------------------------------------------------------
# Step 6 — output
# ---------------------------------------------------------------------------

json_esc() {
  local s=${1-}
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//$'\t'/ }; s=${s//$'\n'/ }; s=${s//$'\r'/ }
  printf '%s' "$s"
}

render_json() {
  printf '{\n'
  printf '  "schemaVersion": 1,\n'
  printf '  "scanner": "shellius-posture-scan/%s",\n' "$VERSION"
  printf '  "collectedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "hostname": "%s",\n' "$(json_esc "$(hostname -f 2>/dev/null || hostname)")"
  printf '  "firewall": { "engine": "%s", "active": %s, "defaultIncoming": "%s" },\n' \
    "$FW_ENGINE" "$([[ $FW_ACTIVE -eq 1 ]] && echo true || echo false)" "$FW_DEFAULT_IN"

  printf '  "listeners": [\n'
  local first=1 proto bind port pids pname kind owner detail user source cport class reach svc lbl oid src
  while IFS=$'\t' read -r proto bind port pids pname kind owner detail user source cport class reach svc lbl oid src; do
    [[ $first -eq 0 ]] && printf ',\n'; first=0
    printf '    {"proto":"%s","bind":"%s","port":%s,"containerPort":"%s","bindClass":"%s","reachability":"%s","service":"%s","pids":"%s","process":"%s","ownerKind":"%s","ownerName":"%s","ownerDetail":"%s","ownerLabel":"%s","ownerId":"%s","sourcePath":"%s","user":"%s","source":"%s"}' \
      "$(json_esc "$proto")" "$(json_esc "$bind")" "$port" "$(json_esc "$cport")" \
      "$(json_esc "$class")" "$(json_esc "$reach")" "$(json_esc "$svc")" \
      "$(json_esc "$pids")" "$(json_esc "$pname")" "$(json_esc "$kind")" \
      "$(json_esc "$owner")" "$(json_esc "$detail")" "$(json_esc "$lbl")" \
      "$(json_esc "$oid")" "$(json_esc "$src")" "$(json_esc "$user")" "$(json_esc "$source")"
  done < <(sort -t$'\t' -k3,3n "$ENRICHED")
  printf '\n  ],\n'

  printf '  "findings": [\n'
  first=1
  local sev code fproto fport fbind fowner msg
  while IFS=$'\t' read -r sev code fproto fport fbind fowner msg; do
    [[ $first -eq 0 ]] && printf ',\n'; first=0
    printf '    {"severity":"%s","code":"%s","proto":"%s","port":"%s","bind":"%s","owner":"%s","message":"%s"}' \
      "$sev" "$code" "$(json_esc "$fproto")" "$(json_esc "$fport")" \
      "$(json_esc "$fbind")" "$(json_esc "$fowner")" "$(json_esc "$msg")"
  done < "$FINDINGS"
  printf '\n  ]\n}\n'
}

# Human-readable title + remediation per finding code. Grouping findings under
# these instead of repeating one sentence 40 times is the difference between a
# report someone reads and a wall someone scrolls past.
declare -A FIND_TITLE=(
  [DOCKER_FIREWALL_BYPASS]="Docker publishes these ports past the firewall"
  [SENSITIVE_PORT_EXPOSED]="Datastores reachable from any source address"
  [PORT_EXPOSED]="Reachable from anywhere, not a known-public service"
  [NO_HOST_FIREWALL]="No host firewall detected"
  [FIREWALL_INACTIVE]="Firewall installed but not enforcing"
  [SENSITIVE_PORT_WILDCARD_BIND]="Datastores on a wildcard bind, held only by a firewall rule"
  [SENSITIVE_PORT_LAN]="Datastores reachable from the local network"
  [STALE_FIREWALL_RULE]="Firewall rules with nothing listening"
  [UNATTRIBUTED_LISTENER]="Listeners that could not be attributed to a service"
  [EXPECTED_PUBLIC]="Public by design"
)
declare -A FIND_FIX=(
  [DOCKER_FIREWALL_BYPASS]="Publish to loopback instead: -p 127.0.0.1:PORT:PORT — or install ufw-docker."
  [SENSITIVE_PORT_EXPOSED]="Bind to 127.0.0.1 and reach these over an SSH tunnel, or restrict them at the firewall."
  [PORT_EXPOSED]="Confirm each is intended. Internal services should bind 127.0.0.1 behind a reverse proxy."
  [NO_HOST_FIREWALL]="Install ufw and set a default-deny incoming policy."
  [FIREWALL_INACTIVE]="Run 'ufw enable' — but check the rules first, the listeners above are all currently reachable."
  [SENSITIVE_PORT_WILDCARD_BIND]="Bind to 127.0.0.1 so they are safe by construction, not by one firewall rule."
  [SENSITIVE_PORT_LAN]="Confirm the local network is a trust boundary you accept."
  [STALE_FIREWALL_RULE]="Remove the rules — they widen the attack surface for nothing."
  [UNATTRIBUTED_LISTENER]="Re-run as root, or investigate these by hand."
  [EXPECTED_PUBLIC]=""
)

TERM_W=$( { tput cols; } 2>/dev/null || echo 100 )
[[ "$TERM_W" =~ ^[0-9]+$ ]] || TERM_W=100
(( TERM_W < 80 ))  && TERM_W=80
(( TERM_W > 140 )) && TERM_W=140

rule() { printf '%s\n' "${C_DIM}$(printf '─%.0s' $(seq 1 "$TERM_W"))${C_RESET}"; }

pad() {
  local str=$1 w=$2 n
  n=$(( w - ${#str} )); (( n < 0 )) && n=0
  printf '%s%*s' "$str" "$n" ""
}

trunc() {
  local str=$1 max=$2
  (( ${#str} <= max )) && { printf '%s' "$str"; return; }
  printf '%s…' "${str:0:max-1}"
}

reach_color() {
  case "$1" in
    INTERNET)   printf '%s' "$C_RED" ;;
    FIREWALLED) printf '%s' "$C_YEL" ;;
    LAN)        printf '%s' "$C_YEL" ;;
    LOOPBACK)   printf '%s' "$C_GRN" ;;
    *)          printf '%s' "$C_DIM" ;;
  esac
}

sev_color() {
  case "$1" in
    CRITICAL) printf '%s' "$C_RED"  ;;
    HIGH)     printf '%s' "$C_RED"  ;;
    MEDIUM)   printf '%s' "$C_YEL"  ;;
    LOW)      printf '%s' "$C_CYA"  ;;
    *)        printf '%s' "$C_DIM"  ;;
  esac
}

sev_count() { awk -F'\t' -v s="$1" '$1==s{n++} END{print n+0}' "$FINDINGS" 2>/dev/null; }

# Collapse v4/v6 rows: one line per proto:port, binds merged.
# "0.0.0.0" + "::" is one socket pair, not two findings and not two rows.
declare -A ROW_BINDS=() ROW_LINE=() ROW_REACH=()
build_rows() {
  local proto bind port pids pname kind owner detail user source cport class reach svc lbl oid src
  while IFS=$'\t' read -r proto bind port pids pname kind owner detail user source cport class reach svc lbl oid src; do
    local k="$proto:$port"
    local prev_binds=${ROW_BINDS[$k]:-}
    if [[ -z "$prev_binds" ]]; then ROW_BINDS[$k]=$bind
    elif [[ ",$prev_binds," != *",$bind,"* ]]; then ROW_BINDS[$k]="$prev_binds,$bind"
    fi
    if [[ -z "${ROW_REACH[$k]:-}" ]] || (( $(reach_rank "$reach") > $(reach_rank "${ROW_REACH[$k]}") )); then
      ROW_REACH[$k]=$reach
      ROW_LINE[$k]=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$proto" "$port" "$svc" "$lbl" "$detail" "$cport" "$kind" "$oid" "$pids" "$user" "$src")
    fi
  done < "$ENRICHED"
}

fmt_bind() {
  local b=$1
  [[ "$b" == *"0.0.0.0"* && "$b" == *"::"* ]] && { printf '*'; return; }
  [[ "$b" == "0.0.0.0" || "$b" == "::" ]]     && { printf '*'; return; }
  printf '%s' "$b"
}

# On a shared box the question after "what is exposed" is "whose is it".
# Group internet-reachable services by the user that owns them, deduped per
# proto:port so v4/v6 pairs count once.
render_users() {
  local out
  out=$(awk -F'\t' '
    !seen[$1":"$3]++ && $13=="INTERNET" {
      u = ($9=="-" || $9=="") ? "unknown" : $9
      n[u]++; k[u "|" $6]++
    }
    END {
      for (u in n) {
        s=""
        for (key in k) { split(key, a, "|"); if (a[1]==u) s = s (s ? " · " : "") a[2] " " k[key] }
        printf "%s\t%d\t%s\n", u, n[u], s
      }
    }' "$ENRICHED" | sort -t$'\t' -k2,2nr)

  [[ -z "$out" ]] && return
  # only worth a section when more than one user is involved
  [[ $(wc -l <<<"$out") -lt 2 ]] && return

  echo
  printf '%s%s%s\n' "$C_BOLD" "EXPOSURE BY USER" "$C_RESET"
  local u n kinds
  while IFS=$'\t' read -r u n kinds; do
    printf '  %s%s%s %s  %s%s%s\n' "$C_CYA" "$(pad "$u" 14)" "$C_RESET" \
      "$(pad "$n exposed" 12)" "$C_DIM" "$kinds" "$C_RESET"
  done <<<"$out"

}

# Columns are added back in priority order as the terminal gets wider, so the
# report stays readable at 80 and uses the space at 200. --wide forces all of
# them; the JSON always carries everything regardless.
render_section() {
  local want=$1 title=$2
  local keys=() k
  for k in "${!ROW_REACH[@]}"; do
    [[ "${ROW_REACH[$k]}" == "$want" ]] && keys+=("$k")
  done
  (( ${#keys[@]} == 0 )) && return

  local W_PORT=10 W_BIND=5 W_SVC=14 W_USER=10 W_ID=14 W_PID=7
  local base=$(( 2 + W_PORT+1 + W_BIND+1 + W_SVC+1 + W_USER+1 + W_PID ))
  local avail=$(( TERM_W - base ))

  local show_id=0 show_src=0 show_img=0 owner_w=24 src_w=0 img_w=0
  if (( WIDE == 1 )); then
    show_id=1; show_src=1; show_img=1; owner_w=26; src_w=34; img_w=28
  else
    (( avail >= 40 )) && owner_w=26
    if (( avail >= 26 + W_ID + 1 )); then show_id=1; avail=$(( avail - W_ID - 1 )); fi
    avail=$(( avail - owner_w - 1 ))
    if (( avail >= 24 )); then
      show_src=1; src_w=$(( avail > 40 ? 40 : avail )); avail=$(( avail - src_w - 1 ))
    fi
    if (( avail >= 18 )); then
      show_img=1; img_w=$(( avail > 30 ? 30 : avail ))
    fi
  fi

  echo
  printf '%s%s%s %s(%d)%s\n' "$(reach_color "$want")$C_BOLD" "$title" "$C_RESET" "$C_DIM" "${#keys[@]}" "$C_RESET"

  local hdr="  $(pad PORT $W_PORT) $(pad BIND $W_BIND) $(pad SERVICE $W_SVC) $(pad USER $W_USER) $(pad OWNER "$owner_w")"
  (( show_img )) && hdr="$hdr $(pad 'IMAGE / EXEC' "$img_w")"
  (( show_src )) && hdr="$hdr $(pad 'SOURCE' "$src_w")"
  (( show_id ))  && hdr="$hdr $(pad ID $W_ID)"
  hdr="$hdr PID"
  printf '%s%s%s\n' "$C_DIM" "$hdr" "$C_RESET"

  local sorted
  sorted=$(printf '%s\n' "${keys[@]}" | sort -t: -k2,2n)
  while IFS= read -r k; do
    local proto port svc lbl detail cport kind oid pids ruser rsrc
    IFS=$'\t' read -r proto port svc lbl detail cport kind oid pids ruser rsrc <<<"${ROW_LINE[$k]}"
    [[ "$svc"    == "-" ]] && svc=""
    [[ "$detail" == "-" ]] && detail=""
    [[ "$oid"    == "-" ]] && oid=""
    [[ "$pids"   == "-" ]] && pids=""
    [[ "$ruser"  == "-" ]] && ruser=""
    [[ "$rsrc"   == "-" ]] && rsrc=""
    # systemd's id IS the unit name already shown as the owner — don't repeat it
    [[ "$kind" == systemd* ]] && oid=""

    local owner_cell="$lbl"
    [[ -n "$cport" && "$cport" != "-" && "$cport" != "$port" ]] && owner_cell="$owner_cell →${cport}"
    local pid_cell=${pids%%,*}
    [[ "$pids" == *,* ]] && pid_cell="$pid_cell+"

    # long paths are more useful truncated from the LEFT — the tail identifies it
    local src_cell="$rsrc"
    if (( src_w > 0 )) && (( ${#src_cell} > src_w )); then
      src_cell="…${src_cell: -$(( src_w - 1 ))}"
    fi

    local line="  $(pad "$port/$proto" $W_PORT) $(pad "$(fmt_bind "${ROW_BINDS[$k]}")" $W_BIND)"
    line="$line ${svc:+$C_YEL}$(pad "$svc" $W_SVC)${svc:+$C_RESET}"
    line="$line ${ruser:+$C_CYA}$(pad "$(trunc "$ruser" $W_USER)" $W_USER)${ruser:+$C_RESET}"
    line="$line $(pad "$(trunc "$owner_cell" "$owner_w")" "$owner_w")"
    (( show_img )) && line="$line $C_DIM$(pad "$(trunc "$detail" "$img_w")" "$img_w")$C_RESET"
    (( show_src )) && line="$line $C_DIM$(pad "$src_cell" "$src_w")$C_RESET"
    (( show_id ))  && line="$line $C_DIM$(pad "$oid" $W_ID)$C_RESET"
    line="$line $C_DIM$pid_cell$C_RESET"
    printf '%s\n' "$line"
  done <<<"$sorted"
}

render_findings() {
  echo
  rule
  printf '%s%s%s\n' "$C_BOLD" "FINDINGS" "$C_RESET"

  if [[ ! -s "$FINDINGS" ]]; then
    echo "${C_GRN}  Nothing to report.${C_RESET}"
    return
  fi

  local sev code
  for sev in CRITICAL HIGH MEDIUM LOW INFO; do
    # distinct codes at this severity, in first-seen order
    local codes
    codes=$(awk -F'\t' -v s="$sev" '$1==s{print $2}' "$FINDINGS" | awk '!seen[$0]++' \
      | awk '{ rank = ($0=="NO_HOST_FIREWALL" || $0=="FIREWALL_INACTIVE") ? 0 : 1; print rank"\t"$0 }' \
      | sort -s -k1,1n | cut -f2-)
    [[ -z "$codes" ]] && continue

    while IFS= read -r code; do
      local n
      n=$(awk -F'\t' -v s="$sev" -v c="$code" '$1==s&&$2==c' "$FINDINGS" | wc -l)
      echo
      printf '  %s%s %s%s  %s%s%s\n' \
        "$(sev_color "$sev")$C_BOLD" "$sev" "$C_RESET$C_BOLD" "${FIND_TITLE[$code]:-$code}" \
        "$C_DIM" "($n)" "$C_RESET"

      # host-level findings carry no port — print their message instead of a list
      if [[ "$code" == "NO_HOST_FIREWALL" || "$code" == "FIREWALL_INACTIVE" ]]; then
        local msg
        msg=$(awk -F'\t' -v s="$sev" -v c="$code" '$1==s&&$2==c{print $7; exit}' "$FINDINGS")
        printf '      %s\n' "$msg"
      else
        awk -F'\t' -v s="$sev" -v c="$code" '$1==s&&$2==c{print $3"\t"$4"\t"$6}' "$FINDINGS" \
          | sort -t$'\t' -k2,2n \
          | while IFS=$'\t' read -r fproto fport fowner; do
              local key="$fproto:$fport" svc="" ref=""
              svc=${SVC[$key]:-}
              local oid=${OID[$key]:--} opid=${OPID[$key]:--} ouser=${OUSER[$key]:--}
              [[ "$ouser" != "-" && -n "$ouser" ]] && ref="$ouser"
              [[ "$oid"  != "-" && -n "$oid"  ]] && ref="${ref:+$ref }$oid"
              [[ "$opid" != "-" && -n "$opid" ]] && ref="${ref:+$ref }pid ${opid%%,*}"
              printf '      %s %s%s%s %s %s%s%s\n' "$(pad "$fport/$fproto" 10)" \
                "${svc:+$C_YEL}" "$(pad "$svc" 14)" "${svc:+$C_RESET}" \
                "$(pad "$(trunc "$fowner" 32)" 32)" "$C_DIM" "$ref" "$C_RESET"
            done
      fi

      local fix=${FIND_FIX[$code]:-}
      [[ -n "$fix" ]] && printf '      %s→ %s%s\n' "$C_DIM" "$fix" "$C_RESET"
    done <<<"$codes"
  done
  echo
}

render_table() {
  build_rows

  local nc nh nm nl total
  nc=$(sev_count CRITICAL); nh=$(sev_count HIGH)
  nm=$(sev_count MEDIUM);   nl=$(sev_count LOW)
  total=${#ROW_REACH[@]}

  echo
  rule
  printf '%s%s%s %s· %s · %s%s\n' \
    "$C_BOLD" "SHELLIUS POSTURE SCAN" "$C_RESET" "$C_DIM" \
    "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$C_RESET"
  rule

  # The single most important line in the report: when the firewall is off,
  # every "exposed port" below is a symptom of one root cause. Say that once,
  # at the top, instead of leaving it as finding number 43.
  if [[ "$FW_ENGINE" == "none" ]]; then
    printf '\n  %s%s NO HOST FIREWALL%s — every listening port below is reachable\n' \
      "$C_RED$C_BOLD" "▲" "$C_RESET"
    printf '     unless something upstream is blocking it.\n'
  elif [[ $FW_ACTIVE -eq 0 ]]; then
    printf '\n  %s%s FIREWALL NOT ENFORCING%s — %s is installed but inactive, so every\n' \
      "$C_RED$C_BOLD" "▲" "$C_RESET" "$FW_ENGINE"
    printf '     listening port below is reachable regardless of the rules it holds.\n'
  else
    printf '\n  %sfirewall:%s %s active, default incoming = %s\n' \
      "$C_DIM" "$C_RESET" "$C_GRN$FW_ENGINE$C_RESET" "$FW_DEFAULT_IN"
  fi

  printf '\n  %s%d services%s   %s%d critical%s   %s%d high%s   %s%d medium%s   %s%d low%s\n' \
    "$C_BOLD" "$total" "$C_RESET" \
    "$( ((nc)) && echo "$C_RED$C_BOLD" )" "$nc" "$C_RESET" \
    "$( ((nh)) && echo "$C_RED" )" "$nh" "$C_RESET" \
    "$( ((nm)) && echo "$C_YEL" )" "$nm" "$C_RESET" \
    "$( ((nl)) && echo "$C_CYA" )" "$nl" "$C_RESET"

  render_users
  render_section INTERNET   "INTERNET-REACHABLE"
  render_section LAN        "LOCAL NETWORK"
  render_section FIREWALLED "FIREWALLED"
  [[ $SHOW_ALL -eq 1 ]] && render_section LOOPBACK "LOOPBACK ONLY"

  if [[ $SHOW_ALL -eq 0 ]]; then
    local hidden=0 k
    for k in "${!ROW_REACH[@]}"; do [[ "${ROW_REACH[$k]}" == "LOOPBACK" ]] && hidden=$((hidden+1)); done
    (( hidden > 0 )) && printf '\n  %s%d loopback-only service(s) hidden — pass --all to show them%s\n' \
      "$C_DIM" "$hidden" "$C_RESET"
  fi

  render_findings
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "${C_DIM}collecting listeners...${C_RESET}"
collect_listeners || exit 2
log "${C_DIM}collecting docker published ports...${C_RESET}"
collect_docker
log "${C_DIM}collecting firewall state...${C_RESET}"
collect_firewall
log "${C_DIM}correlating...${C_RESET}"
analyze

if [[ $JSON -eq 1 ]]; then
  render_json
else
  render_table
fi

# exit 1 if anything HIGH or above
worst=0
while IFS=$'\t' read -r sev _rest; do
  r=$(sev_rank "$sev"); (( r > worst )) && worst=$r
done < "$FINDINGS"
(( worst >= 3 )) && exit 1
exit 0
