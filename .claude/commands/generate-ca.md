# /generate-ca

Generate or rotate the SSH Certificate Authority key pair for an organization.

## Steps

1. **Check if CA key pair already exists**
   ```bash
   cd backend && node -e "
     import { PrismaClient } from '@prisma/client';
     const prisma = new PrismaClient();
     const ca = await prisma.caKeyPair.findFirst({ where: { isActive: true } });
     if (ca) {
       console.log('EXISTING:' + ca.id + ':' + ca.fingerprint);
     } else {
       console.log('NONE');
     }
     await prisma.\$disconnect();
   "
   ```

2. **If existing CA found**, ask whether to rotate or skip.

3. **Generate Ed25519 CA key pair**
   ```bash
   ssh-keygen -t ed25519 -f /tmp/shellius_ca -N "" -C "shellius-ca@$(date +%Y%m%d)"
   ```

4. **Read the keys**
   ```bash
   CA_PUBLIC_KEY=$(cat /tmp/shellius_ca.pub)
   CA_PRIVATE_KEY=$(cat /tmp/shellius_ca)
   CA_FINGERPRINT=$(ssh-keygen -lf /tmp/shellius_ca.pub | awk '{print $2}')
   ```

5. **Encrypt the private key** with `SERVER_ENCRYPTION_KEY` from `.env` (AES-256-GCM).

6. **Store in database** via Prisma — create `CaKeyPair` record with encrypted private key.

7. **Clean up temp files**
   ```bash
   rm -f /tmp/shellius_ca /tmp/shellius_ca.pub
   ```

8. **Print results**
   ```
   Shellius CA Key Pair Generated
   
   Fingerprint: SHA256:xxxx
   Key Type:    Ed25519
   
   CA Public Key (add to target hosts):
   ssh-ed25519 AAAA... shellius-ca@20240101
   
   Add this to /etc/ssh/sshd_config on each target host:
     TrustedUserCAKeys /etc/ssh/shellius_ca.pub
   
   Or use the bootstrap script:
     curl -sSL https://your-shellius-instance/bootstrap.sh | bash -s -- --token <TOKEN> --api <API_URL>
   ```

## Security Notes

- The CA private key is encrypted at rest and NEVER stored in plaintext
- Temp files are deleted immediately after reading
- If rotation: old key is marked `isActive: false`, new key becomes active
- Existing certs signed by old key remain valid until their expiry
