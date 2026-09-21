import { describe, it, expect } from 'vitest';
import { describeListener } from './serviceIdentity';

describe('describeListener', () => {
  it('systemd: the unit name without .service, the unit file as subtext', () => {
    const d = describeListener({
      ownerKind: 'systemd',
      ownerName: 'mysql.service',
      ownerDetail: '/usr/sbin/mysqld',
      sourcePath: '/usr/lib/systemd/system/mysql.service',
      service: 'MySQL/MariaDB',
    });
    expect(d).toMatchObject({ name: 'mysql', protocol: 'MySQL/MariaDB', subtext: '/usr/lib/systemd/system/mysql.service' });
    expect(d.runtime.label).toBe('systemd');
  });

  it('keeps a systemd instance name', () => {
    expect(describeListener({ ownerKind: 'systemd', ownerName: 'postgresql@18-main.service', service: 'PostgreSQL' }).name).toBe(
      'postgresql@18-main'
    );
  });

  it('docker-proxy: names it by the recognised service, points at the container', () => {
    const d = describeListener({ ownerKind: 'docker-proxy', ownerName: 'docker-proxy', ownerDetail: '-> 172.18.0.2:1433', service: 'MSSQL' });
    expect(d).toMatchObject({ name: 'MSSQL', protocol: '', subtext: '→ container 172.18.0.2:1433' });
    expect(d.runtime.label).toBe('Docker');
  });

  it('a container resolved by cgroup, with and without its name', () => {
    expect(describeListener({ ownerKind: 'container', ownerName: 'docker:3f2a9c1b7d4e' }).name).toBe('container 3f2a9c1b7d4e');
    const named = describeListener({ ownerKind: 'container', ownerName: 'docker:3f2a9c1b7d4e', containerName: 'api', containerImage: 'myorg/api:1.4' });
    expect(named).toMatchObject({ name: 'api', subtext: 'myorg/api:1.4', id: '3f2a9c1b7d4e' });
    expect(describeListener({ ownerKind: 'container', ownerName: 'podman:aa11' }).runtime.label).toBe('Podman');
  });

  it('pm2: the app name, its id, and the command when there is no source path', () => {
    const d = describeListener({ ownerKind: 'pm2', ownerName: 'api-gateway', ownerRef: '#3@/home/ubuntu/.pm2', ownerDetail: 'node /srv/api/server.js · via infisical run' });
    expect(d).toMatchObject({ name: 'api-gateway', id: '#3', subtext: 'node /srv/api/server.js · via infisical run' });
  });

  it('never says "systemd unit" or "Unidentified" when there is a name to show', () => {
    expect(describeListener({ ownerKind: 'process', ownerName: 'python3', ownerDetail: 'python3 -m http.server' }).name).toBe('python3');
    expect(describeListener({ ownerKind: 'unknown', ownerName: 'unknown' }).name).toBe('Unknown process');
  });
});
