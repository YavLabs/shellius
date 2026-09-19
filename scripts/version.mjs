#!/usr/bin/env node
// scripts/version.mjs
//
// Single source of truth for the Shellius app version is the root VERSION
// file (plain semver, e.g. "1.1.0", no leading "v", trailing newline).
//
// Usage:
//   node scripts/version.mjs sync              # write VERSION into every consumer
//   node scripts/version.mjs check              # exit 1 if anything is out of sync (CI)
//   node scripts/version.mjs bump <major|minor|patch|x.y.z> [--date=YYYY-MM-DD]
//                                                 # bump VERSION, sync, and open a
//                                                 # new CHANGELOG.md section
//
// No dependencies — plain Node (fs/path only).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VERSION_FILE = path.join(ROOT, 'VERSION');
const BACKEND_PKG = path.join(ROOT, 'backend', 'package.json');
const FRONTEND_PKG = path.join(ROOT, 'frontend', 'package.json');
const BACKEND_LOCK = path.join(ROOT, 'backend', 'package-lock.json');
const FRONTEND_LOCK = path.join(ROOT, 'frontend', 'package-lock.json');
const README = path.join(ROOT, 'README.md');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function readVersion() {
  if (!existsSync(VERSION_FILE)) {
    throw new Error(`Missing ${VERSION_FILE}`);
  }
  const raw = readFileSync(VERSION_FILE, 'utf8').trim();
  if (!SEMVER_RE.test(raw)) {
    throw new Error(`VERSION file does not contain valid semver: "${raw}"`);
  }
  return raw;
}

function writeVersion(v) {
  writeFileSync(VERSION_FILE, `${v}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonPreserveFormat(file, mutateFn) {
  const raw = readFileSync(file, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const json = JSON.parse(raw);
  const changed = mutateFn(json);
  if (!changed) return false;
  const out = JSON.stringify(json, null, 2) + (trailingNewline ? '\n' : '');
  writeFileSync(file, out);
  return true;
}

// -- package.json (backend/frontend) -----------------------------------------

function syncPackageJson(file, version) {
  return writeJsonPreserveFormat(file, (json) => {
    if (json.version === version) return false;
    json.version = version;
    return true;
  });
}

// -- package-lock.json (top-level "version" + packages[""].version only) ----

function syncPackageLock(file, version) {
  return writeJsonPreserveFormat(file, (json) => {
    let changed = false;
    if (json.version !== version) {
      json.version = version;
      changed = true;
    }
    if (json.packages && json.packages[''] && json.packages[''].version !== version) {
      json.packages[''].version = version;
      changed = true;
    }
    return changed;
  });
}

// -- TUI version constant (default for local `make build`; releases still
//    stamp via ldflags -X main.version=<tag>, see tui/Makefile) -------------

function syncTuiMakefile(version) {
  const file = path.join(ROOT, 'tui', 'Makefile');
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8');
  const re = /^VERSION\s*\?=.*$/m;
  const desired = `VERSION   ?= $(shell cat $(CURDIR)/../VERSION 2>/dev/null || echo dev)`;
  if (!re.test(raw)) return false;
  if (raw.match(re)[0] === desired) return false;
  writeFileSync(file, raw.replace(re, desired));
  return true;
}

// -- README badge -------------------------------------------------------------

function syncReadmeBadge(version) {
  if (!existsSync(README)) return false;
  const raw = readFileSync(README, 'utf8');
  const re = /(img\.shields\.io\/badge\/version-)[^-]+(-[0-9A-Za-z]+\.svg)/;
  if (!re.test(raw)) return false;
  const encoded = version.replace(/-/g, '--');
  const next = raw.replace(re, `$1${encoded}$2`);
  if (next === raw) return false;
  writeFileSync(README, next);
  return true;
}

// -- Frontend footer version (source is package.json via Vite define; this
//    just leaves a friendly fallback constant in sync for non-Vite contexts /
//    editor tooling — see frontend/src/version.js) --------------------------

function syncFrontendVersionJs(version) {
  const file = path.join(ROOT, 'frontend', 'src', 'version.js');
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8');
  const re = /const FALLBACK_VERSION = '[^']*';/;
  if (!re.test(raw)) return false;
  const next = raw.replace(re, `const FALLBACK_VERSION = '${version}';`);
  if (next === raw) return false;
  writeFileSync(file, next);
  return true;
}

function sync({ verbose = true } = {}) {
  const version = readVersion();
  const results = [];

  results.push(['backend/package.json', syncPackageJson(BACKEND_PKG, version)]);
  results.push(['frontend/package.json', syncPackageJson(FRONTEND_PKG, version)]);
  if (existsSync(BACKEND_LOCK)) {
    results.push(['backend/package-lock.json', syncPackageLock(BACKEND_LOCK, version)]);
  }
  if (existsSync(FRONTEND_LOCK)) {
    results.push(['frontend/package-lock.json', syncPackageLock(FRONTEND_LOCK, version)]);
  }
  results.push(['tui/Makefile', syncTuiMakefile(version)]);
  results.push(['README.md', syncReadmeBadge(version)]);
  results.push(['frontend/src/version.js', syncFrontendVersionJs(version)]);

  if (verbose) {
    console.log(`VERSION: ${version}`);
    for (const [name, changed] of results) {
      console.log(`  ${changed ? 'updated' : 'ok     '}  ${name}`);
    }
  }
  return version;
}

// -- check ---------------------------------------------------------------

function check() {
  const version = readVersion();
  const problems = [];

  const backendPkg = readJson(BACKEND_PKG);
  if (backendPkg.version !== version) {
    problems.push(`backend/package.json version "${backendPkg.version}" != VERSION "${version}"`);
  }

  const frontendPkg = readJson(FRONTEND_PKG);
  if (frontendPkg.version !== version) {
    problems.push(`frontend/package.json version "${frontendPkg.version}" != VERSION "${version}"`);
  }

  if (existsSync(BACKEND_LOCK)) {
    const lock = readJson(BACKEND_LOCK);
    if (lock.version !== version || lock.packages?.['']?.version !== version) {
      problems.push(`backend/package-lock.json is out of sync with VERSION "${version}"`);
    }
  }

  if (existsSync(FRONTEND_LOCK)) {
    const lock = readJson(FRONTEND_LOCK);
    if (lock.version !== version || lock.packages?.['']?.version !== version) {
      problems.push(`frontend/package-lock.json is out of sync with VERSION "${version}"`);
    }
  }

  const changelog = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '';
  if (!changelog.includes(`## [${version}]`)) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section`);
  }

  if (problems.length) {
    console.error('version check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`version check OK (${version})`);
}

// -- bump ------------------------------------------------------------------

function bumpVersion(current, kind) {
  if (SEMVER_RE.test(kind)) return kind; // explicit x.y.z
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Cannot parse current version "${current}"`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else if (kind === 'patch') { patch += 1; }
  else throw new Error(`Unknown bump kind "${kind}" (expected major|minor|patch|x.y.z)`);
  return `${major}.${minor}.${patch}`;
}

function prependChangelogSection(version, date) {
  if (!existsSync(CHANGELOG)) return;
  const raw = readFileSync(CHANGELOG, 'utf8');
  if (raw.includes(`## [${version}]`)) return; // already there

  const marker = '## [Unreleased]';
  const idx = raw.indexOf(marker);
  const section = `## [${version}] - ${date}\n\n### Added\n\n### Changed\n\n### Fixed\n\n### Security\n\n### Migration notes\n\n`;

  let next;
  if (idx === -1) {
    // No Unreleased section — insert right after the header block.
    const headerEnd = raw.indexOf('\n## ');
    if (headerEnd === -1) {
      next = raw + `\n${section}`;
    } else {
      next = raw.slice(0, headerEnd + 1) + `\n${section}\n` + raw.slice(headerEnd + 1);
    }
  } else {
    // Find end of the "## [Unreleased]" section (next "## " heading).
    const afterMarker = idx + marker.length;
    const nextHeading = raw.indexOf('\n## ', afterMarker);
    const insertAt = nextHeading === -1 ? raw.length : nextHeading + 1;
    next = raw.slice(0, insertAt) + `${section}\n` + raw.slice(insertAt);
  }
  writeFileSync(CHANGELOG, next);
}

function bump(kind, opts = {}) {
  const current = readVersion();
  const next = bumpVersion(current, kind);
  const date = opts.date || new Date().toISOString().slice(0, 10);
  writeVersion(next);
  prependChangelogSection(next, date);
  sync();
  console.log(`\nBumped ${current} -> ${next}. Fill in the CHANGELOG.md "## [${next}]" section, then commit.`);
  return next;
}

// -- CLI ---------------------------------------------------------------------

const [, , cmd, arg] = process.argv;
const dateArg = process.argv.find((a) => a.startsWith('--date='));
const date = dateArg ? dateArg.split('=')[1] : undefined;

switch (cmd) {
  case 'sync':
    sync();
    break;
  case 'check':
    check();
    break;
  case 'bump':
    if (!arg) {
      console.error('Usage: node scripts/version.mjs bump <major|minor|patch|x.y.z>');
      process.exit(1);
    }
    bump(arg, { date });
    break;
  default:
    console.error('Usage: node scripts/version.mjs <sync|check|bump>');
    process.exit(1);
}
