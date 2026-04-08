import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Download, Trash2, Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import PageHeader from '@/components/common/PageHeader';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Skeleton from '@/components/ui/Skeleton';
import {
  getMe,
  updateMe,
  changeMyPassword,
  exportMyData,
  deleteMyAccount,
} from '@/services/userService';

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function SectionCard({ title, description, children, className = '' }) {
  return (
    <div className={`rounded-lg border border-border bg-card p-6 ${className}`}>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:gap-4 border-b border-border last:border-0">
      <span className="w-32 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value || '\u2014'}</span>
    </div>
  );
}

function Profile() {
  const { user: authUser, logout } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loadingProfile, setLoadingProfile] = useState(true);

  // Name edit
  const [name, setName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSuccess, setNameSuccess] = useState('');
  const [nameError, setNameError] = useState('');

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // Delete account
  const [deleteInput, setDeleteInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    setLoadingProfile(true);
    getMe()
      .then((data) => {
        setProfile(data);
        setName(data?.name || '');
      })
      .catch(() => setLoadError('Failed to load your profile.'))
      .finally(() => setLoadingProfile(false));
  }, []);

  const handleNameSave = async (e) => {
    e.preventDefault();
    setNameError('');
    setNameSuccess('');
    if (!name.trim()) {
      setNameError('Name cannot be empty.');
      return;
    }
    setNameSaving(true);
    try {
      const updated = await updateMe({ name: name.trim() });
      setProfile((prev) => ({ ...prev, ...updated }));
      setNameSuccess('Name updated.');
    } catch (err) {
      setNameError(err.response?.data?.error?.message || err.message || 'Failed to update name.');
    } finally {
      setNameSaving(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    const validationError = validatePassword(newPassword);
    if (validationError) {
      setPasswordError(validationError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    setPasswordSaving(true);
    try {
      await changeMyPassword({ currentPassword, newPassword });
      setPasswordSuccess('Password updated. You\u2019ll receive a confirmation email.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(
        err.response?.data?.error?.message || err.message || 'Failed to update password.'
      );
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleExport = async () => {
    setExportError('');
    setExporting(true);
    try {
      await exportMyData();
    } catch (err) {
      setExportError(
        err.response?.data?.error?.message || err.message || 'Export failed. Please try again.'
      );
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteError('');
    setDeleting(true);
    try {
      await deleteMyAccount();
      await logout();
      navigate('/login?deleted=1', { replace: true });
    } catch (err) {
      setDeleteError(
        err.response?.data?.error?.message || err.message || 'Failed to delete account.'
      );
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const initials = (profile?.name || authUser?.name || profile?.email || 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const isPasswordUser = !profile?.ssoProvider && profile?.passwordHash !== null;

  if (loadingProfile) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader icon={User} title="Profile" subtitle="Manage your account and personal data" />
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader icon={User} title="Profile" subtitle="Manage your account and personal data" />
        <div>
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={User} title="Profile" subtitle="Manage your account and personal data" />

      <div className="grid gap-5 md:grid-cols-2">
        {/* Profile section */}
        <SectionCard title="Profile" description="Your personal information and account details.">
          <div className="flex items-center gap-4 mb-6">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground select-none">
              {initials}
            </div>
            <div>
              <p className="font-medium text-foreground">{profile?.name || 'No name set'}</p>
              <p className="text-sm text-muted-foreground">{profile?.email}</p>
            </div>
          </div>

          <form onSubmit={handleNameSave} className="mb-6">
            <label htmlFor="profile-name" className="mb-1.5 block text-sm font-medium text-foreground">
              Display name
            </label>
            <div className="flex gap-2">
              <input
                id="profile-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={nameSaving}
                className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {nameSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </button>
            </div>
            {nameError && (
              <p className="mt-1.5 text-xs text-destructive">{nameError}</p>
            )}
            {nameSuccess && (
              <p className="mt-1.5 text-xs text-green-600 dark:text-green-400">{nameSuccess}</p>
            )}
          </form>

          <div className="divide-y divide-border">
            <InfoRow label="Email" value={profile?.email} />
            <InfoRow label="Role" value={profile?.role} />
            <InfoRow
              label="Created"
              value={
                profile?.createdAt
                  ? new Date(profile.createdAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })
                  : null
              }
            />
            <InfoRow
              label="Last login"
              value={
                profile?.lastLoginAt
                  ? new Date(profile.lastLoginAt).toLocaleString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : null
              }
            />
          </div>
        </SectionCard>

        {/* Change password section */}
        <SectionCard
          title="Password"
          description={
            isPasswordUser
              ? 'Update your account password.'
              : undefined
          }
        >
          {!isPasswordUser ? (
            <p className="text-sm text-muted-foreground">
              Password is managed by your SSO provider{profile?.ssoProvider ? ` (${profile.ssoProvider})` : ''}.
            </p>
          ) : (
            <form onSubmit={handlePasswordChange} className="space-y-4">
              {passwordError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {passwordError}
                </div>
              )}
              {passwordSuccess && (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                  {passwordSuccess}
                </div>
              )}

              <div>
                <label htmlFor="current-password" className="mb-1.5 block text-sm font-medium text-foreground">
                  Current password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="current-password"
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    required
                    autoComplete="current-password"
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent((p) => !p)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium text-foreground">
                  New password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="new-password"
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    required
                    autoComplete="new-password"
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((p) => !p)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Min 12 characters, must include a letter and a number.
                </p>
              </div>

              <div>
                <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-medium text-foreground">
                  Confirm new password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="confirm-password"
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat new password"
                    required
                    autoComplete="new-password"
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((p) => !p)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {passwordSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Update password
                </button>
              </div>
            </form>
          )}
        </SectionCard>

        {/* Data export section */}
        <SectionCard
          title="Export my data"
          description="Download a copy of your personal data stored in Shellius."
        >
          <p className="mb-4 text-sm text-muted-foreground">
            The export includes your profile, access requests, certificates, sessions, and audit log
            entries associated with your account. It does not include data about other users.
          </p>
          {exportError && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {exportError}
            </div>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export my data
          </button>
        </SectionCard>

        {/* Delete account danger zone */}
        <SectionCard
          title="Delete account"
          className="border-destructive/40"
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Permanently delete your account and all associated data. This action cannot be undone.
            Your access to all servers will be revoked immediately.
          </p>

          {deleteError && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label htmlFor="delete-confirm-input" className="mb-1.5 block text-sm font-medium text-foreground">
                Type <span className="font-mono font-bold">DELETE</span> to confirm
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                placeholder="DELETE"
                className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              disabled={deleteInput !== 'DELETE' || deleting}
              onClick={() => setShowDeleteConfirm(true)}
              className="flex h-9 items-center gap-2 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete my account
            </button>
          </div>
        </SectionCard>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete your account?"
        message="This will permanently delete your account and revoke all your active access. This action cannot be undone."
        confirmLabel={deleting ? 'Deleting...' : 'Yes, delete my account'}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}

export default Profile;
