// Fire a real notifyEvent the way the product does, and see what the
// destination receives.
import prisma from './src/config/db.js';
import { notifyEvent } from './src/services/notify/notifyService.js';
const ORG = 'cmu75k9440000curuc25s6n6j';
const admin = await prisma.user.findFirst({ where: { orgId: ORG, role: 'super_admin', status: 'active', kind: 'human' } });
const res = await notifyEvent({
  orgId: ORG,
  event: 'break_glass.invoked',
  recipients: [admin.id],
  title: '[Break-glass] access invoked on db-prod-01',
  body: 'Yash invoked break-glass access to db-prod-01 (prod). Reason: incident 4412',
  metadata: { secretish: 'this must never reach chat' },
  chat: {
    fields: [
      { label: 'Who', value: 'Yash' },
      { label: 'Server', value: 'db-prod-01' },
      { label: 'Reason', value: 'incident 4412 <!channel>' },
    ],
    url: 'https://shellius.test/access-requests?request=x',
    context: {},
  },
});
console.log('RESULT ' + JSON.stringify(res));
await new Promise((r) => setTimeout(r, 3000));
await prisma.$disconnect();
