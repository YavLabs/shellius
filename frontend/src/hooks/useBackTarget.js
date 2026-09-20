import { useLocation } from 'react-router-dom';

/**
 * Where "Back" should go from a detail page.
 *
 * Detail pages had a hard-coded destination — Server Details always went to
 * the servers list — so arriving from Customer Details and pressing Back put
 * you somewhere you had never been. The list you came from is context the
 * link was throwing away.
 *
 * Callers that navigate into a detail page pass it along:
 *
 *   navigate(`/servers/${id}`, { state: { from: { to, label } } })
 *   <Link to={...} state={{ from: { to: '/customers/x', label: 'Acme' } }}>
 *
 * and the detail page asks for it here, with its own default as the
 * fallback. Deliberately explicit rather than reading history: history tells
 * you the previous URL, not what to call it, and a Back button that says
 * "Back" with no destination is the thing being fixed.
 *
 * @param {{to: string, label: string}} fallback
 * @returns {{to: string, label: string}}
 */
export default function useBackTarget(fallback) {
  const location = useLocation();
  const from = location.state?.from;
  if (from?.to && from?.label) {
    return { to: from.to, label: `Back to ${from.label}` };
  }
  return fallback;
}

/**
 * Build the `state` for a link into a detail page, so that page can offer a
 * Back that returns here.
 *
 * @param {string} to     the current page's path
 * @param {string} label  what to call it ("Wayne Enterprises", not an id)
 */
export function fromState(to, label) {
  return { from: { to, label } };
}
