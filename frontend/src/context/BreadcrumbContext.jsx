import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Breadcrumbs.
 *
 * The top bar used to show "Shellius / <Section>" — the section derived from
 * the first path segment, so every detail page under /servers read "Servers"
 * no matter which server, or how you got there. That is the one place a
 * breadcrumb is actually useful, and it said nothing.
 *
 * Pages publish their own trail with `useBreadcrumbs`, because only the page
 * knows the names: a route can see `/customers/clx123/`, but only the loaded
 * customer knows it is "Wayne Enterprises". This is also why the trail is
 * pushed rather than derived from the URL — deriving it would mean either
 * showing raw ids or a second round of lookups for names the page already
 * has.
 *
 * Crumbs are `{ label, to? }`. The last one is the current page and is
 * rendered without a link.
 */

const BreadcrumbContext = createContext({ crumbs: [], setCrumbs: () => {} });

export function BreadcrumbProvider({ children }) {
  const [crumbs, setCrumbs] = useState([]);
  const value = useMemo(() => ({ crumbs, setCrumbs }), [crumbs]);
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

export function useBreadcrumbContext() {
  return useContext(BreadcrumbContext);
}

/**
 * Publish this page's trail. Pass null/undefined entries freely — they are
 * dropped, so a page can write `[customerCrumb, { label: server.hostname }]`
 * without guarding every element while data loads.
 *
 * @param {Array<{label: string, to?: string}|null|undefined>} crumbs
 */
export function useBreadcrumbs(crumbs) {
  const { setCrumbs } = useBreadcrumbContext();

  // Serialised so an inline array literal — the normal way to call this —
  // does not re-publish on every render and loop.
  const key = JSON.stringify((crumbs || []).filter(Boolean));

  const publish = useCallback(() => {
    setCrumbs(JSON.parse(key));
  }, [key, setCrumbs]);

  useEffect(() => {
    publish();
    // Clear on unmount so a page that publishes nothing does not inherit the
    // previous page's trail for a frame.
    return () => setCrumbs([]);
  }, [publish, setCrumbs]);
}

export default BreadcrumbContext;
