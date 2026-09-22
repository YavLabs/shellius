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

/**
 * @param {object} l  a HostListener row (ownerKind, ownerName, ownerRef,
 *   ownerDetail, ownerUser, sourcePath, service, pid, process?, containerName?,
 *   containerImage?)
 */
export function describeListener(l) {
  const runtime = runtimeOf(l);
  const service = clean(l?.service);
  const ownerName = clean(l?.ownerName);
  const detail = clean(l?.ownerDetail);
  const source = clean(l?.sourcePath);
  let name = '';
  let subtext = source;
  let id = '';

  switch (l?.ownerKind) {
    case 'systemd':
    case 'systemd-user':
      name = unitBase(ownerName) || service;
      id = ownerName;
      break;
    case 'pm2': {
      name = ownerName || service;
      const ref = clean(l?.ownerRef);
      id = ref ? ref.split('@')[0] : '';
      if (!subtext) subtext = detail;
      break;
    }
    case 'container': {
      const cid = ownerName.replace(/^(docker|podman):/, '');
      name = clean(l?.containerName) || service || `container ${cid}`;
      id = cid;
      if (!subtext) subtext = clean(l?.containerImage) || `container ${cid}`;
      break;
    }
    case 'docker-proxy': {
      const target = proxyTarget(detail);
      name = clean(l?.containerName) || service || (target ? `container ${target}` : 'Docker published port');
      if (!subtext) subtext = target ? `→ container ${target}` : '';
      break;
    }
    case 'docker':
    case 'podman': {
      if (/^runtime:/.test(ownerName)) {
        // A port found only as a NAT rule: "runtime:172.17.0.3:9000".
        const target = ownerName.replace(/^runtime:/, '');
        name = clean(l?.containerName) || service || `container ${target}`;
        if (!subtext) subtext = `→ container ${target} (NAT rule)`;
      } else {
        // From the service inventory (container scan): ownerName IS the
        // container's name, ownerDetail its image, ownerRef its id.
        name = ownerName || service || 'container';
        id = clean(l?.ownerRef);
        if (!subtext) subtext = detail || (id ? `container ${id}` : '');
      }
      break;
    }
    case 'process':
      name = ownerName || clean(l?.process) || service;
      if (!subtext) subtext = detail;
      break;
    default:
      name = service || clean(l?.process) || (ownerName && ownerName !== 'unknown' ? ownerName : '') || 'Unknown process';
      if (!subtext) subtext = detail;
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
    details: {
      user: clean(l?.ownerUser),
      pid: l?.pid ?? null,
      command: detail,
      source,
      reference: clean(l?.ownerRef) || ownerName,
    },
  };
}

export default { describeListener, RUNTIMES };
