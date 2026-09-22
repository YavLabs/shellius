/**
 * keyDeploymentService.groupDeployments — the "Export to servers" group
 * tree: counts over the whole filtered set, every level accepted back by
 * listDeployments as a filter (so a group opens to exactly what it counted),
 * batch headers carrying the old batch card's summary, and org + customer
 * scope + the Keystore org-key rule applied exactly as the list applies them.
 */
import prisma from '../../config/db.js';
import * as keyDeploymentService from '../keyDeploymentService.js';
import { encrypt } from '../../utils/crypto.js';
import { resolveScope, UNSCOPED } from '../../lib/scope.js';
import { NONE } from '../../utils/groupTree.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function makeKey(orgId, name, data = {}) {
  return prisma.sshKey.create({
    data: {
      orgId,
      name,
      keyType: 'ed25519',
      publicKey: 'ssh-ed25519 AAAAfake test@host',
      privateKeyEncrypted: encrypt('fake-private-key-material'),
      fingerprint: `SHA256:fake-${unique()}`,
      source: 'generated',
      ...data,
    },
  });
}

describe('keyDeploymentService.groupDeployments', () => {
  let reachable;
  let org;
  let otherOrg;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let keyOne;
  let keyTwo;
  let actor;
  let scopedScope;
  const batch1 = `b1-${unique()}`;
  const batch2 = `b2-${unique()}`;
  const otherBatch = `bx-${unique()}`;

  const dep = (orgId, data) =>
    prisma.keyDeployment.create({ data: { orgId, targetUser: 'deploy', authMode: 'server', ...data } });

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] keyDeploymentGroups: no live DB');
      return;
    }
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    const s = unique();
    customerA = await prisma.customer.create({ data: { orgId: org.id, name: `Acme-${s}`, slug: `acme-${s}` } });
    customerB = await prisma.customer.create({ data: { orgId: org.id, name: `Beta-${s}`, slug: `beta-${s}` } });
    serverA = await prisma.server.create({ data: { orgId: org.id, customerId: customerA.id, hostname: `alpha-${s}`, ipAddress: '10.3.0.1' } });
    serverB = await prisma.server.create({ data: { orgId: org.id, customerId: customerB.id, hostname: `bravo-${s}`, ipAddress: '10.3.0.2' } });
    keyOne = await makeKey(org.id, `key-one-${s}`);
    keyTwo = await makeKey(org.id, `key-two-${s}`);
    actor = await createTestUser(org.id, { role: 'admin' });

    // batch1 (older): keyOne → A (success), B (failed), by actor
    await dep(org.id, { batchId: batch1, sshKeyId: keyOne.id, serverId: serverA.id, action: 'deploy', status: 'success', deployedById: actor.id, createdAt: new Date(Date.now() - 60_000) });
    await dep(org.id, { batchId: batch1, sshKeyId: keyOne.id, serverId: serverB.id, action: 'deploy', status: 'failed', deployedById: actor.id, createdAt: new Date(Date.now() - 60_000) });
    // batch2 (newer): keyTwo → A (running), system-started
    await dep(org.id, { batchId: batch2, sshKeyId: keyTwo.id, serverId: serverA.id, action: 'rotate', status: 'running', deployedById: null });

    // Another org's deployment must never be counted.
    const oc = await prisma.customer.create({ data: { orgId: otherOrg.id, name: `Other-${s}`, slug: `other-${s}` } });
    const os = await prisma.server.create({ data: { orgId: otherOrg.id, customerId: oc.id, hostname: `other-${s}`, ipAddress: '10.3.0.9' } });
    const ok = await makeKey(otherOrg.id, `other-key-${s}`);
    await dep(otherOrg.id, { batchId: otherBatch, sshKeyId: ok.id, serverId: os.id, action: 'deploy', status: 'success' });

    const scopedUser = await createTestUser(org.id, { role: 'member', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });
    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const o of [org, otherOrg]) {
      await prisma.keyDeployment.deleteMany({ where: { orgId: o.id } });
      await prisma.sshKey.deleteMany({ where: { orgId: o.id } });
      await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: o.id } } });
      await prisma.server.deleteMany({ where: { orgId: o.id } });
      await prisma.customer.deleteMany({ where: { orgId: o.id } });
      await cleanupOrg(o.id);
    }
    await prisma.$disconnect().catch(() => {});
  });

  const dbTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  const flat = (nodes) => nodes.map((n) => ({ value: n.value, label: n.label, count: n.count }));

  dbTest('no or unknown levels → empty tree', async () => {
    expect(await keyDeploymentService.groupDeployments(org.id, { groupBy: '' }, UNSCOPED)).toEqual({ groupBy: [], tree: [], active: 0 });
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'nope,orgId' }, UNSCOPED);
    expect(r.tree).toEqual([]);
  });

  dbTest('batch level: newest run first, labelled time · key · action, with summary meta', async () => {
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'batch' }, UNSCOPED);
    expect(r.groupBy).toEqual(['batch']);
    expect(r.tree.map((n) => n.value)).toEqual([batch2, batch1]);
    expect(r.tree[0].label).toMatch(new RegExp(`UTC · ${keyTwo.name} · Rotate$`));
    expect(r.tree[1].meta).toMatchObject({
      batchId: batch1,
      action: 'deploy',
      sshKey: { id: keyOne.id, name: keyOne.name },
      deployedBy: { id: actor.id },
      counts: { success: 1, failed: 1, running: 0, pending: 0, total: 2 },
    });
    expect(r.tree[0].meta.deployedBy).toBeNull();
    expect(r.active).toBe(1);
  });

  dbTest('org scoping: another org never appears', async () => {
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'batch' }, UNSCOPED);
    expect(r.tree.map((n) => n.value)).not.toContain(otherBatch);
    const other = await keyDeploymentService.groupDeployments(otherOrg.id, { groupBy: 'batch' }, UNSCOPED);
    expect(other.tree.map((n) => n.value)).toEqual([otherBatch]);
  });

  dbTest('nested levels with labels and fixed status order', async () => {
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'customer,status' }, UNSCOPED);
    expect(flat(r.tree)).toEqual([
      { value: customerA.id, label: customerA.name, count: 2 },
      { value: customerB.id, label: customerB.name, count: 1 },
    ]);
    // running before success
    expect(r.tree[0].children.map((n) => n.label)).toEqual(['Running', 'Succeeded']);

    const byActor = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'deployedBy,key,server' }, UNSCOPED);
    expect(byActor.tree.map((n) => n.value).sort()).toEqual([NONE, actor.id].sort());
    expect(byActor.tree.find((n) => n.value === NONE).label).toBe('System');
    const actorNode = byActor.tree.find((n) => n.value === actor.id);
    expect(actorNode.children[0]).toMatchObject({ value: keyOne.id, label: keyOne.name, count: 2 });
    expect(actorNode.children[0].children.map((n) => n.label).sort()).toEqual([serverA.hostname, serverB.hostname].sort());
  });

  dbTest('filters narrow the tree, and each group opens through the list to exactly its count', async () => {
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'batch,action', status: 'failed' }, UNSCOPED);
    expect(flat(r.tree)).toEqual([expect.objectContaining({ value: batch1, count: 1 })]);
    expect(r.tree[0].meta.counts).toMatchObject({ failed: 1, total: 1 });

    const paramFor = { batch: 'batchId', key: 'sshKeyId', server: 'serverId', customer: 'customerId', status: 'status', action: 'action', deployedBy: 'deployedById' };
    const full = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'deployedBy,customer,action' }, UNSCOPED);
    const walk = async (nodes, filters) => {
      for (const n of nodes) {
        const f = { ...filters, [paramFor[n.dim]]: n.value };
        if (n.children) await walk(n.children, f);
        else {
          const list = await keyDeploymentService.listDeployments(org.id, { ...f, pageSize: 100 }, UNSCOPED);
          expect(list.meta.total).toBe(n.count);
        }
      }
    };
    await walk(full.tree, {});
  });

  dbTest('list accepts NONE: nullable column = empty, required column = nothing', async () => {
    const system = await keyDeploymentService.listDeployments(org.id, { deployedById: NONE }, UNSCOPED);
    expect(system.deployments.map((d) => d.batchId)).toEqual([batch2]);
    const none = await keyDeploymentService.listDeployments(org.id, { batchId: NONE }, UNSCOPED);
    expect(none.meta.total).toBe(0);
  });

  dbTest('customer scope narrows the tree exactly like the list', async () => {
    const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'server' }, scopedScope);
    expect(r.tree.map((n) => n.value)).toEqual([serverA.id]);
    const batches = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'batch' }, scopedScope);
    expect(batches.tree.find((n) => n.value === batch1).meta.counts).toMatchObject({ success: 1, failed: 0, total: 1 });
  });

  dbTest('Keystore rule: a deployment of a personal key is never listed or counted', async () => {
    const personal = await makeKey(org.id, `personal-${unique()}`, { ownerId: actor.id });
    const row = await dep(org.id, { batchId: `bp-${unique()}`, sshKeyId: personal.id, serverId: serverA.id, action: 'deploy', status: 'success' });
    try {
      const r = await keyDeploymentService.groupDeployments(org.id, { groupBy: 'key' }, UNSCOPED);
      expect(r.tree.map((n) => n.value)).not.toContain(personal.id);
      const list = await keyDeploymentService.listDeployments(org.id, { pageSize: 100 }, UNSCOPED);
      expect(list.deployments.map((d) => d.id)).not.toContain(row.id);
    } finally {
      await prisma.keyDeployment.delete({ where: { id: row.id } });
      await prisma.sshKey.delete({ where: { id: personal.id } });
    }
  });
});
