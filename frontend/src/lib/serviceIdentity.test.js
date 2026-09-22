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
    expect(d).toMatchObject({ name: 'MSSQL', protocol: '', subtext: '→ 172.18.0.2:1433' });
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

  it('a container from the service inventory is named by its own name, with its image', () => {
    const d = describeListener({ ownerKind: 'docker', ownerName: 'chatbot_api', ownerDetail: 'myorg/chatbot:2.1', ownerRef: 'ab12cd34ef56' });
    expect(d).toMatchObject({ name: 'chatbot_api', subtext: 'myorg/chatbot:2.1', id: 'ab12cd34ef56' });
    expect(d.runtime.label).toBe('Docker');
  });
  it('a NAT-only publish is named by the address it forwards to', () => {
    expect(describeListener({ ownerKind: 'docker', ownerName: 'runtime:172.17.0.3:9000' }).name).toBe('container 172.17.0.3:9000');
  });

  it('a docker-proxy port named from the inventory: container name + id, compose file · target', () => {
    const d = describeListener({
      ownerKind: 'docker-proxy',
      ownerDetail: '-> 172.27.0.2:3000',
      containerName: 'op-dashboard',
      containerId: 'fe07ecd8db89',
      containerImage: 'openpanel/dashboard:2',
      sourcePath: '/srv/op/docker-compose.yml',
    });
    expect(d).toMatchObject({ name: 'op-dashboard', id: 'fe07ecd8db89', subtext: '/srv/op/docker-compose.yml · → 172.27.0.2:3000' });
  });

  it('pm2: the inventory app name over the launcher, the pm2 id, and the script instead of the command line', () => {
    const d = describeListener({
      ownerKind: 'pm2',
      ownerName: 'serve',
      ownerRef: '#3@/home/ithadmin/.pm2',
      ownerDetail: 'node /home/ithadmin/.nvm/versions/node/v23.11.0/bin/serve -s build',
      pm2Name: 'ksb-fe',
      pm2Script: '/usr/lib/node_modules/serve/build/main.js',
    });
    expect(d).toMatchObject({ name: 'ksb-fe', id: '#3', subtext: '/usr/lib/node_modules/serve/build/main.js' });
    // Its working directory wins when the collector reports one.
    expect(describeListener({ ownerKind: 'pm2', ownerName: 'api', sourcePath: '/srv/api', ownerDetail: 'node x' }).subtext).toBe('/srv/api');
  });

  it('a specific bind address is shown; a wildcard is not', () => {
    expect(describeListener({ ownerKind: 'systemd', ownerName: 'redis.service', sourcePath: '/lib/systemd/system/redis.service', bind: '127.0.0.1' }).subtext).toBe(
      '/lib/systemd/system/redis.service · on 127.0.0.1'
    );
    expect(describeListener({ ownerKind: 'systemd', ownerName: 'nginx.service', bind: '0.0.0.0' }).subtext).toBe('');
  });

  it('an unknown owner declared by one service is named as a lead, not a fact', () => {
    const d = describeListener({ ownerKind: 'unknown', ownerName: 'unknown', declaredBy: { kind: 'pm2', name: 'ksb-api', ref: 'u:ksb-api' } });
    expect(d).toMatchObject({ name: 'ksb-api', inferred: true });
    expect(d.runtime.label).toBe('pm2');
    expect(d.subtext).toMatch(/owner not confirmed/);
  });
});
