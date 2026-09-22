/**
 * Long-lived connections (Redis, BullMQ queues, Prisma) register how to
 * close themselves here, so a test run can close exactly the ones its
 * imports opened — without this, jest finishes every test and then never
 * exits, holding the Redis sockets open. The server never calls closeAll.
 */
const KEY = Symbol.for('shellius.handles');
const handles = (globalThis[KEY] ||= []);

export function trackHandle(close) {
  handles.push(close);
}

export async function closeAll() {
  const list = handles.splice(0);
  // Queues before the connection they share.
  await Promise.allSettled(list.reverse().map((close) => Promise.resolve().then(close)));
}
