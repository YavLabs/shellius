/**
 * Email OTP delivery must be reported honestly: when the mailer can't
 * deliver (no SMTP configured here — env cleared, no org SmtpConfig row),
 * sendEmailOtp fails with EMAIL_NOT_DELIVERED and leaves no pending code,
 * instead of the login screen claiming "Code sent".
 *
 * Live-DB tests (dbReachable() skip pattern — see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { sendEmailOtp } from '../mfaService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'];

describe('mfaService email OTP delivery', () => {
  let reachable;
  let org;
  let user;
  const savedEnv = {};

  beforeAll(async () => {
    for (const k of SMTP_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] mfaEmailDelivery: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member' });
    user = await prisma.user.update({ where: { id: user.id }, data: { mfaEmailEnabled: true } });
  });

  afterAll(async () => {
    for (const k of SMTP_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (!reachable) return;
    await cleanupOrg(org.id);
  });

  test('fails with EMAIL_NOT_DELIVERED and keeps no pending code when SMTP is not configured', async () => {
    if (!reachable) return;
    await expect(sendEmailOtp(user)).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_NOT_DELIVERED' });
    const pending = await prisma.userToken.count({ where: { userId: user.id, type: 'mfa_email_otp' } });
    expect(pending).toBe(0);
  });
});
