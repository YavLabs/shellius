/**
 * Default second factor: sign-in offers the user's preferred factor first,
 * falls back to the first enabled one when the preference isn't enabled,
 * and only an enabled factor can be chosen.
 *
 * Pure ordering tests + a live-DB test for setPreferredMethod
 * (dbReachable() skip pattern — see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { availableMethods, preferredMethod, setPreferredMethod, userMfaStatus } from '../mfaService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const both = { mfaTotpEnabled: true, mfaEmailEnabled: true, mfaBackupCodes: ['x'] };

describe('mfa preferred method — ordering', () => {
  test('authenticator first by default, backup codes last', () => {
    expect(availableMethods(both)).toEqual(['totp', 'email', 'backup']);
    expect(preferredMethod(both)).toBe('totp');
  });

  test('the preferred factor comes first', () => {
    const u = { ...both, mfaPreferredMethod: 'email' };
    expect(availableMethods(u)).toEqual(['email', 'totp', 'backup']);
    expect(userMfaStatus(u).preferredMethod).toBe('email');
  });

  test('a preference for a factor that is not enabled is ignored', () => {
    const u = { mfaTotpEnabled: true, mfaEmailEnabled: false, mfaPreferredMethod: 'email', mfaBackupCodes: [] };
    expect(availableMethods(u)).toEqual(['totp']);
    expect(preferredMethod(u)).toBe('totp');
  });

  test('no factors → no preference', () => {
    expect(preferredMethod({ mfaBackupCodes: [] })).toBeNull();
  });
});

describe('mfa preferred method — setPreferredMethod', () => {
  let reachable;
  let org;
  let user;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] mfaPreferredMethod: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member' });
    user = await prisma.user.update({ where: { id: user.id }, data: { mfaTotpEnabled: true, mfaEmailEnabled: false } });
  });

  afterAll(async () => {
    if (reachable) await cleanupOrg(org.id);
  });

  test('refuses a factor that is not set up', async () => {
    if (!reachable) return;
    await expect(setPreferredMethod(user, 'email')).rejects.toMatchObject({ statusCode: 400 });
    await expect(setPreferredMethod(user, 'backup')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('stores an enabled factor', async () => {
    if (!reachable) return;
    user = await prisma.user.update({ where: { id: user.id }, data: { mfaEmailEnabled: true } });
    await setPreferredMethod(user, 'email');
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.mfaPreferredMethod).toBe('email');
    expect(availableMethods(fresh)[0]).toBe('email');
  });
});
