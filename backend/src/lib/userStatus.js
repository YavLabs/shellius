/**
 * userStatus.js — which UserStatus values mean "this account must not be used".
 *
 * The list was duplicated in ssoService.js and ssoLinkService.js, which is
 * exactly the kind of list that drifts: a new status added in one copy and
 * not the other is a sign-in bypass. One definition, imported everywhere.
 */

/** Statuses that deny sign-in and revoke standing access. */
export const DISABLED_STATUSES = ['deleted', 'suspended', 'deactivated'];

/** True when the account may not authenticate or hold live access. */
export const isDisabledStatus = (status) => DISABLED_STATUSES.includes(status);

export default { DISABLED_STATUSES, isDisabledStatus };
