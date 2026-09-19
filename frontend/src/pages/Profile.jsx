import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Download, Trash2, Loader2, Upload, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import PageHeader from '@/components/common/PageHeader';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Skeleton from '@/components/ui/Skeleton';
import Avatar from '@/components/ui/Avatar';
import PasswordCard from '@/components/profile/PasswordCard';
import MfaCard from '@/components/profile/MfaCard';
import SessionsCard from '@/components/profile/SessionsCard';
import NotificationPreferencesCard from '@/components/profile/NotificationPreferencesCard';
import SignInMethodsCard from '@/components/profile/SignInMethodsCard';
import {
  getMe,
  updateMe,
  exportMyData,
  deleteMyAccount,
  uploadMyAvatar,
  removeMyAvatar,
} from '@/services/userService';
import { roleName } from '@/lib/permissions';

const AVATAR_OUTPUT_SIZE = 128;
const AVATAR_MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5MB
const AVATAR_ACCEPT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Center-crop + resize an image file to a square AVATAR_OUTPUT_SIZE webp
 * data URL, entirely client-side. Rejects files over the size limit or of
 * an unsupported type before ever touching the canvas.
 */
function cropAndResizeToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!AVATAR_ACCEPT_TYPES.includes(file.type)) {
      reject(new Error('Please choose a PNG, JPEG, or WEBP image.'));
      return;
    }
    if (file.size > AVATAR_MAX_INPUT_BYTES) {
      reject(new Error('Image is too large. Please choose a file under 5MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load the selected image.'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_OUTPUT_SIZE;
        canvas.height = AVATAR_OUTPUT_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
        resolve(canvas.toDataURL('image/webp', 0.9));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
      <span className="text-sm font-medium text-foreground">{value || '—'}</span>
    </div>
  );
}

function Profile() {
  const { user: authUser, logout, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loadingProfile, setLoadingProfile] = useState(true);

  // Avatar upload
  const fileInputRef = useRef(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [avatarDragOver, setAvatarDragOver] = useState(false);

  // Name edit
  const [name, setName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSuccess, setNameSuccess] = useState('');
  const [nameError, setNameError] = useState('');

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

  const handleAvatarFile = async (file) => {
    if (!file) return;
    setAvatarError('');
    setAvatarSaving(true);
    try {
      const dataUrl = await cropAndResizeToAvatar(file);
      const updated = await uploadMyAvatar(dataUrl);
      setProfile((prev) => ({ ...prev, ...updated }));
      await refreshUser?.();
    } catch (err) {
      setAvatarError(err.message || err.response?.data?.error?.message || 'Failed to upload photo.');
    } finally {
      setAvatarSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarError('');
    setAvatarSaving(true);
    try {
      const updated = await removeMyAvatar();
      setProfile((prev) => ({ ...prev, ...updated, avatarUrl: null }));
      await refreshUser?.();
    } catch (err) {
      setAvatarError(err.response?.data?.error?.message || err.message || 'Failed to remove photo.');
    } finally {
      setAvatarSaving(false);
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

  // /auth/me (authUser) is the source of truth for hasPassword post-hardening;
  // fall back to the older /users/me heuristic if the field is missing so this
  // keeps working against a not-yet-updated backend.
  const hasPassword = authUser?.hasPassword ?? (profile?.passwordHash !== null && !profile?.ssoProvider);

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
    <div className="space-y-6 p-6">
      <PageHeader icon={User} title="Profile" subtitle="Manage your account and personal data" />

      {/* grid-cols-1 = minmax(0, 1fr): one long unbreakable value (an IPv6
          address in Sessions) can't widen every card past a phone screen. */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {/* Profile section */}
        <SectionCard title="Profile" description="Your personal information and account details.">
          <div className="mb-6 flex items-center gap-4">
            <div
              className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full transition-colors ${
                avatarDragOver ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setAvatarDragOver(true);
              }}
              onDragLeave={() => setAvatarDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setAvatarDragOver(false);
                handleAvatarFile(e.dataTransfer.files?.[0]);
              }}
            >
              <Avatar
                name={profile?.name || authUser?.name}
                email={profile?.email || authUser?.email}
                avatarUrl={profile?.avatarUrl || authUser?.avatarUrl}
                size="xl"
              />
              {avatarSaving && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{profile?.name || 'No name set'}</p>
              <p className="text-sm text-muted-foreground">{profile?.email}</p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarSaving}
                  className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload photo
                </button>
                {(profile?.avatarUrl || authUser?.avatarUrl) && (
                  <button
                    type="button"
                    onClick={handleAvatarRemove}
                    disabled={avatarSaving}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => handleAvatarFile(e.target.files?.[0])}
              />
              {avatarError && (
                <p className="mt-1.5 text-xs text-destructive" role="alert">{avatarError}</p>
              )}
            </div>
          </div>

          <form onSubmit={handleNameSave} className="mb-6">
            <label htmlFor="profile-name" className="mb-1.5 block text-sm font-medium text-foreground">
              Display name <span className="text-destructive">*</span>
            </label>
            <div className="flex gap-2">
              <input
                id="profile-name"
                type="text"
                autoComplete="name"
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
              <p className="mt-1.5 text-xs text-destructive" role="alert">{nameError}</p>
            )}
            {nameSuccess && (
              <p className="mt-1.5 text-xs text-green-600 dark:text-green-400">{nameSuccess}</p>
            )}
          </form>

          <div className="divide-y divide-border">
            <InfoRow label="Email" value={profile?.email} />
            <InfoRow label="Role" value={roleName(profile)} />
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

        {/* Security */}
        <PasswordCard isPasswordUser={hasPassword} />
        <MfaCard hasPassword={hasPassword} />
        <SignInMethodsCard hasPassword={hasPassword} />
        <SessionsCard />
        <NotificationPreferencesCard />

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
