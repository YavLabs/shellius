/**
 * Directory sync failure modes.
 *
 * There are only two that matter here, and the distinction is about blame:
 * a configuration that can never work, versus a directory that would not
 * answer this time. Neither ever results in someone being suspended — a run
 * that cannot read the directory aborts, because "I could not see anyone"
 * and "nobody is there" must never be confused.
 */

export class DirectoryConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirectoryConfigError';
    this.permanent = true;
  }
}

export class DirectoryFetchError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'DirectoryFetchError';
    this.status = status;
  }
}

export default { DirectoryConfigError, DirectoryFetchError };
