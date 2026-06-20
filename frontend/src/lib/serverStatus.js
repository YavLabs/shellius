/**
 * A server is "onboarded" (requestable/connectable) once the agent + CA trust
 * is in place: auto-provisioning succeeded, OR the host has checked in via
 * heartbeat / health check. Servers merely added to the inventory
 * (onboard=false in bulk import, or failed onboarding) are NOT onboarded.
 */
export function isServerOnboarded(server) {
  if (!server) return false;
  if (server.provisionStatus === 'provisioned') return true;
  if (server.lastHealthCheck) return true;
  return !!server.healthStatus && server.healthStatus !== 'unknown';
}
