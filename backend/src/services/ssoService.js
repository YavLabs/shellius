import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/crypto.js';

function redactSecret(config) {
  if (!config) return config;
  const { clientSecretEncrypted, ...rest } = config;
  return { ...rest, clientSecret: '***REDACTED***' };
}

export async function getSsoConfig(orgId) {
  const cfg = await prisma.ssoConfig.findUnique({ where: { orgId } });
  return redactSecret(cfg);
}

export async function upsertSsoConfig(orgId, configData) {
  const {
    provider,
    clientId,
    clientSecret,
    issuerUrl,
    redirectUri,
    scopes,
    isActive,
  } = configData;

  if (!provider || !clientId || !issuerUrl || !redirectUri) {
    throw new ApiError(400, 'provider, clientId, issuerUrl, redirectUri are required');
  }

  const encrypted = clientSecret ? encrypt(clientSecret) : undefined;

  const data = {
    provider,
    clientId,
    issuerUrl,
    redirectUri,
    scopes: scopes || 'openid profile email',
    isActive: isActive !== undefined ? isActive : true,
  };

  const existing = await prisma.ssoConfig.findUnique({ where: { orgId } });

  let result;
  if (existing) {
    result = await prisma.ssoConfig.update({
      where: { orgId },
      data: { ...data, ...(encrypted ? { clientSecretEncrypted: encrypted } : {}) },
    });
  } else {
    if (!encrypted) {
      throw new ApiError(400, 'clientSecret is required for new SSO config');
    }
    result = await prisma.ssoConfig.create({
      data: { orgId, ...data, clientSecretEncrypted: encrypted },
    });
  }

  return redactSecret(result);
}

export async function getDecryptedConfig(orgId) {
  const cfg = await prisma.ssoConfig.findUnique({ where: { orgId } });
  if (!cfg) return null;
  return { ...cfg, clientSecret: decrypt(cfg.clientSecretEncrypted) };
}

export async function handleOidcUserInfo(userinfo, orgId) {
  const email = userinfo.email;
  if (!email) {
    throw new ApiError(400, 'OIDC userinfo missing email claim');
  }

  let user = await prisma.user.findFirst({ where: { orgId, email } });

  const name = userinfo.name || userinfo.preferred_username || email;
  const avatarUrl = userinfo.picture || null;
  const ssoSub = userinfo.sub;

  if (!user) {
    user = await prisma.user.create({
      data: {
        orgId,
        email,
        name,
        role: 'viewer',
        status: 'active',
        ssoProvider: 'oidc',
        ssoSub,
        avatarUrl,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        name,
        avatarUrl: avatarUrl || user.avatarUrl,
        ssoProvider: user.ssoProvider || 'oidc',
        ssoSub: user.ssoSub || ssoSub,
        lastLoginAt: new Date(),
      },
    });
  }

  return user;
}

export default { getSsoConfig, upsertSsoConfig, getDecryptedConfig, handleOidcUserInfo };
