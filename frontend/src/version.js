// Single source of truth for the app version surfaced in the footer.
//
// The real value is injected at build time by Vite (`define: { __APP_VERSION__ }`
// in vite.config.js, itself read from frontend/package.json — which is kept in
// lockstep with the root VERSION file by `node scripts/version.mjs sync`).
//
// FALLBACK_VERSION only matters for tooling that imports this module outside
// a Vite build (e.g. a plain Node script or an editor type-checker) where
// __APP_VERSION__ is undefined. It is kept in sync by the same script — do
// not hand-edit it.
const FALLBACK_VERSION = '1.2.0';

export const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : FALLBACK_VERSION;

// Short git SHA of the build, when available (set via VITE_GIT_SHA at build
// time — see .github/workflows/docker-build-push.yml and docker/Dockerfile.frontend).
// Empty string in local dev unless you export VITE_GIT_SHA yourself.
export const GIT_SHA = typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : '';
