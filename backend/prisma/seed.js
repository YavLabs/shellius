import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'shellius-demo' },
    update: {},
    create: {
      name: 'Shellius Demo',
      slug: 'shellius-demo',
      domain: 'shellius.local',
    },
  });

  console.log('Organization:', org.name);

  const passwordHash = await bcrypt.hash('Shellius2024!', 12);

  const admin = await prisma.user.upsert({
    where: { orgId_email: { orgId: org.id, email: 'admin@shellius.local' } },
    update: {},
    create: {
      orgId: org.id,
      email: 'admin@shellius.local',
      name: 'Admin User',
      passwordHash,
      role: 'super_admin',
      status: 'active',
    },
  });

  console.log('Admin user:', admin.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
