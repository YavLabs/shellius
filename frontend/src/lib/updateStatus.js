/**
 * updateStatus.js — turn the `/api/updates` response into what the
 * Updates tab shows, in one place.
 *
 * `enabled: false` (air-gapped installs, `UPDATE_CHECK_ENABLED=false`) is a
 * supported configuration, not a fault — it must read as calmly as "up to
 * date", never as a red banner. `error` is a string only when the release
 * API could not be reached; `latestVersion` may still be set from a
 * previous successful check, so a failed check and "no known answer yet"
 * are different states worth telling apart.
 *
 * Pure: no React, no I/O. Tested in updateStatus.test.js.
 */

/**
 * @param {object} status  the `/api/updates` payload (or null while loading)
 * @returns {{ label: string, tone: 'success'|'info'|'warning'|'neutral', note: string|null }}
 *   `note` is a secondary line (the disabled reason or the check error),
 *   shown muted rather than as an alert.
 */
export function summarizeUpdateStatus(status) {
  if (!status) return { label: 'Checking…', tone: 'neutral', note: null };

  if (status.enabled === false) {
    return { label: 'Checks are turned off', tone: 'neutral', note: status.disabledReason || null };
  }

  if (status.updateAvailable && status.latestVersion) {
    return { label: `Update available: ${status.latestVersion}`, tone: 'info', note: status.error || null };
  }

  if (status.error) {
    // A failed check with no prior result at all — nothing to call "up to
    // date" yet, but still not a fault: it's most often just no outbound
    // internet, which is normal for a lot of installs this ships to.
    return {
      label: status.latestVersion ? 'Up to date (last known)' : 'Could not check for updates',
      tone: 'warning',
      note: status.error,
    };
  }

  return { label: 'Up to date', tone: 'success', note: null };
}

/** The command shown for applying an update — never a button, always this. */
export function updateCommand(latestVersion) {
  return `./update-shellius.sh v${latestVersion}`;
}
