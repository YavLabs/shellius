import { createContext, useContext, useEffect, useId } from 'react';

/**
 * Set by pages/Administration.jsx around the section it renders. Pages that
 * used to be standalone (Users, Roles, Groups) read it so their PageHeader
 * renders as the section's card header instead of a second page title, and
 * forms use useUnsavedChanges() so switching sections asks before throwing
 * edits away.
 */
export const AdminFrameContext = createContext(null);

export function useAdminFrame() {
  return useContext(AdminFrameContext);
}

/**
 * Marks the calling form as having unsaved edits while `dirty` is true:
 * the Administration nav asks before switching sections, and closing or
 * reloading the tab shows the browser's leave-page prompt.
 */
export function useUnsavedChanges(dirty) {
  const frame = useAdminFrame();
  const id = useId();
  const markDirty = frame?.markDirty;

  useEffect(() => {
    if (!markDirty) return undefined;
    markDirty(id, !!dirty);
    return () => markDirty(id, false);
  }, [markDirty, id, dirty]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
