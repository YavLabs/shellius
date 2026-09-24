/**
 * The audit sink adapter registry.
 *
 * Mirrors services/email/providers/index.js: each adapter declares what it is
 * called, which of its settings are secret, how to validate a configuration,
 * how to deliver a batch and how to test itself. The service layer above
 * knows none of the protocols.
 */

import * as webhook from './webhook.js';
import * as s3 from './s3.js';
import * as syslog from './syslog.js';
import * as emailDigest from './emailDigest.js';
import { SinkConfigError } from './errors.js';

export const ADAPTERS = {
  webhook,
  s3,
  syslog,
  email_digest: emailDigest,
};

export const SINK_TYPES = Object.keys(ADAPTERS);

/**
 * The types the streaming delivery loop drives: they hold a durable cursor
 * and ship everything they owe.
 */
export const STREAMING_TYPES = SINK_TYPES.filter((t) => ADAPTERS[t].streaming);

/**
 * The rest — scheduled, cursorless, bounded by a clock rather than a cursor.
 *
 * This list used to be implicit, and that was the bug: `jobs/auditExport.js`
 * selects STREAMING_TYPES, so nothing ever ran a digest sink. An org could
 * configure a daily audit digest, see it saved and reported healthy, and
 * never receive one. `sinkService.runDigestSink` is what drives these now.
 */
export const DIGEST_TYPES = SINK_TYPES.filter((t) => !ADAPTERS[t].streaming);

export function getAdapter(type) {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new SinkConfigError(`Unknown sink type '${type}'`);
  return adapter;
}

/** `[{ type, label, streaming, secretFields }]` for the settings UI. */
export const describeAdapters = () =>
  SINK_TYPES.map((t) => ({
    type: t,
    label: ADAPTERS[t].label,
    streaming: ADAPTERS[t].streaming,
    secretFields: ADAPTERS[t].secretFields,
  }));

export default { ADAPTERS, SINK_TYPES, STREAMING_TYPES, DIGEST_TYPES, getAdapter, describeAdapters };
