/**
 * A server is "onboarded" (requestable/connectable) once the agent + CA trust
 * is in place: auto-provisioning succeeded, OR the agent has enrolled / checked
 * in (agentId / agentLastSeen — covers manual bootstrap too).
 *
 * Do NOT use healthStatus / lastHealthCheck: the periodic health probe runs
 * against ANY server (even unreachable / never-onboarded ones), so it says
 * nothing about whether the agent is installed. A failed-onboarding host can
 * still have an (unhealthy) health check.
 */
export function isServerOnboarded(server) {
  if (!server) return false;
  if (server.provisionStatus === 'provisioned') return true;
  return !!server.agentId || !!server.agentLastSeen;
}
