/**
 * Group-by levels for the Posture findings inbox. The values match the
 * backend's FINDING_GROUP_DIMS (postureQueryService.getFindingGroups);
 * FINDING_GROUP_PARAM maps each one to the findings-list filter a group
 * opens with. Status is deliberately not a level — the inbox's sections
 * already split by it.
 */
export const FINDING_GROUP_OPTIONS = [
  { value: 'severity', label: 'Severity' },
  { value: 'server', label: 'Server' },
  { value: 'customer', label: 'Customer' },
  { value: 'environment', label: 'Environment' },
  { value: 'code', label: 'Finding type' },
  { value: 'port', label: 'Port' },
];

export const FINDING_GROUP_PARAM = {
  severity: 'severity',
  server: 'serverId',
  customer: 'customerId',
  environment: 'environment',
  code: 'code',
  port: 'port',
};

export const findingGroupDimLabel = (dim) => FINDING_GROUP_OPTIONS.find((o) => o.value === dim)?.label || dim;
