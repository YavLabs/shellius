/**
 * The directory adapter registry.
 *
 * Same shape as the audit sink and email provider registries: each adapter
 * declares its label, its secret fields, how to validate a configuration, how
 * to list the directory and how to test itself. Nothing above this layer knows
 * a provider's API.
 *
 * A provider with no adapter is not a silent no-op. `adapterForPreset` returns
 * null and the UI says directory sync is not available for that provider,
 * because the failure mode of pretending otherwise is a sync that reports
 * everyone as missing.
 */

import * as entra from './entra.js';
import * as okta from './okta.js';
import * as google from './google.js';
import * as github from './github.js';
import { DirectoryConfigError } from '../errors.js';

export const ADAPTERS = { entra, okta, google, github };

export const ADAPTER_TYPES = Object.keys(ADAPTERS);

export function getAdapter(type) {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new DirectoryConfigError(`Directory sync is not available for '${type}'`);
  return adapter;
}

/**
 * Which adapter suits an SsoConfig, from its provider and preset.
 * `null` means "this provider has no directory API we can read".
 */
export function adapterForConfig(cfg) {
  if (!cfg) return null;
  if (cfg.provider === 'github') return 'github';
  switch (cfg.presetId) {
    case 'entra':
      return 'entra';
    case 'okta':
      return 'okta';
    case 'google':
      return 'google';
    default:
      // auth0, generic OIDC, SAML: no standard directory API to read.
      return null;
  }
}

/** `[{ type, label, secretFields, reportsDisabled }]` for the settings UI. */
export const describeAdapters = () =>
  ADAPTER_TYPES.map((t) => ({
    type: t,
    label: ADAPTERS[t].label,
    secretFields: ADAPTERS[t].secretFields,
    reportsDisabled: ADAPTERS[t].reportsDisabled,
  }));

export default { ADAPTERS, ADAPTER_TYPES, getAdapter, adapterForConfig, describeAdapters };
