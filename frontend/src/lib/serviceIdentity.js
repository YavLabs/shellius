/**
 * serviceIdentity.js — one readable answer to "what is listening on this
 * port?", from the collector's raw owner fields.
 *
 * The table used to show those fields as they arrive: `systemd/mysql.service`,
 * `docker-proxy/docker-proxy`, `container/docker:3f2a…`, plus a Service column
 * that said "systemd unit" for most rows. Three columns to read one fact.
 * This turns them into:
 *
 *   name      what a person calls it: `mysql`, `api-gateway`, `MSSQL`
 *   runtime   { key, label } for the chip: systemd, Docker, pm2, …
 *   protocol  the recognised service, when it adds something to the name
 *   subtext   where it is defined (unit file, cwd) or, failing that, what
 *             it is (container address, command line)
 *   details   everything else, for a tooltip or the detail dialog
 *
 * Pure; no React. Tested in serviceIdentity.test.js.
 */

export const RUNTIMES = {
  systemd: { key: 'systemd', label: 'systemd' },
  'systemd-user': { key: 'systemd-user', label: 'systemd (user)' },
  docker: { key: 'docker', label: 'Docker' },
  podman: { key: 'podman', label: 'Podman' },
  pm2: { key: 'pm2', label: 'pm2' },
  process: { key: 'process', label: 'Process' },
  unknown: { key: 'unknown', label: 'Unknown' },
};

const clean = (v) => (v && v !== '-' ? String(v) : '');

/** `mysql.service` → `mysql`; `session-3.scope` → `session-3`. */
function unitBase(unit) {
  return clean(unit).replace(/\.(service|scope|socket)$/, '');
}

/** The collector's docker-proxy detail: "-> 172.18.0.2:1433". */
function proxyTarget(detail) {
  const m = /->\s*([0-9.]+:\d+|\?:\?)/.exec(clean(detail));
  return m && m[1] !== '?:?' ? m[1] : '';
}

function runtimeOf(l) {
  const kind = l?.ownerKind || 'unknown';
  if (kind === 'container' || kind === 'docker' || kind === 'docker-proxy') {
    return /^podman:/.test(clean(l?.ownerName)) || kind === 'podman' ? RUNTIMES.podman : RUNTIMES.docker;
  }
  return RUNTIMES[kind] || RUNTIMES.unknown;
}

const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '*', '']);

/** A specific bind address is worth saying; a wildcard is the Bind column's job. */
function bindPart(l) {
  const b = clean(l?.bind);
  return b && !WILDCARD_BINDS.has(b) ? `on ${b}` : '';
}

const joinParts = (...parts) => parts.filter(Boolean).join(' · ');

/**
 * @param {object} l  a HostListener row (ownerKind, ownerName, ownerRef,
 *   ownerDetail, ownerUser, sourcePath, service, pid, bind, process?) plus
 *   what the server joined from the host's inventory (containerName,
 *   containerId, containerImage, pm2Name, pm2Script, pm2Home, declaredBy)
 */
export function describeListener(l) {
  let runtime = runtimeOf(l);
  const service = clean(l?.service);
  const ownerName = clean(l?.ownerName);
  const detail = clean(l?.ownerDetail);
  const source = clean(l?.sourcePath);
  let name = '';
  let subtext = '';
  let id = '';
  let inferred = false;

  switch (l?.ownerKind) {
    case 'systemd':
    case 'systemd-user':
      // The unit is the id; its file (else its binary) is where it comes from.
      name = unitBase(ownerName) || service;
      subtext = joinParts(source || detail, bindPart(l));
      break;
    case 'pm2': {
      // The app's pm2 name — the inventory's, when the socket owner only
      // showed the launcher (`serve`) — and its pm2 id.
      name = clean(l?.pm2Name) || ownerName || service;
      const ref = clean(l?.ownerRef);
      id = ref ? ref.split('@')[0] : '';
      subtext = joinParts(source || clean(l?.pm2Script) || detail, bindPart(l));
      break;
    }
    case 'container': {
      const cid = ownerName.replace(/^(docker|podman):/, '');
      name = clean(l?.containerName) || service || `container ${cid}`;
      id = clean(l?.containerId) || cid;
      subtext = joinParts(source || clean(l?.containerImage), bindPart(l));
      break;
    }
    case 'docker-proxy': {
      const target = proxyTarget(detail);
      name = clean(l?.containerName) || service || (target ? `container ${target}` : 'Docker published port');
      id = clean(l?.containerId);
      subtext = joinParts(source || clean(l?.containerImage), target ? `→ ${target}` : '', bindPart(l));
      break;
    }
    case 'docker':
    case 'podman': {
      if (/^runtime:/.test(ownerName)) {
        // A port found only as a NAT rule: "runtime:172.17.0.3:9000".
        const target = ownerName.replace(/^runtime:/, '');
        name = clean(l?.containerName) || service || `container ${target}`;
        id = clean(l?.containerId);
        subtext = joinParts(source || clean(l?.containerImage), `→ ${target} (NAT rule)`);
      } else {
        // From the service inventory (container scan): ownerName IS the
        // container's name, ownerDetail its image, ownerRef its id.
        name = ownerName || service || 'container';
        id = clean(l?.ownerRef).slice(0, 12);
        subtext = joinParts(source || detail, bindPart(l));
      }
      break;
    }
    case 'process':
      name = ownerName || clean(l?.process) || service;
      id = l?.pid ? `pid ${l.pid}` : '';
      subtext = joinParts(detail, bindPart(l));
      break;
    default: {
      const declared = l?.declaredBy;
      if (declared?.name) {
        // Nobody could be seen holding the socket, but exactly one service on
        // the host declares this port — say so, as a lead rather than a fact.
        name = declared.name;
        runtime = RUNTIMES[declared.kind] || runtime;
        inferred = true;
        subtext = joinParts(`declared by this ${runtime.label} service — owner not confirmed`, bindPart(l));
      } else {
        name = service || clean(l?.process) || (ownerName && ownerName !== 'unknown' ? ownerName : '') || 'Unknown process';
        subtext = joinParts(detail, bindPart(l));
      }
    }
  }

  // The recognised protocol, only when it says something the name does not:
  // `mysql` + "MySQL/MariaDB" helps; "MSSQL" + "MSSQL" does not.
  const protocol = service && service.toLowerCase() !== name.toLowerCase() ? service : '';

  return {
    name: name || 'Unknown process',
    runtime,
    protocol,
    subtext,
    id,
    inferred,
    details: {
      user: clean(l?.ownerUser),
      pid: l?.pid ?? null,
      command: detail,
      source,
      image: clean(l?.containerImage),
      script: clean(l?.pm2Script),
      pm2Home: clean(l?.pm2Home),
      reference: clean(l?.ownerRef) || ownerName,
    },
  };
}

export default { describeListener, RUNTIMES };
