import { useState } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import { reviewAccessRequest } from '@/services/accessRequestService';

const inputCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

function ApprovalCard({ request, onRefresh }) {
  const [approvedDuration, setApprovedDuration] = useState('');
  const [deniedReason, setDeniedReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!request || request.status !== 'PENDING') return null;

  const handleDecision = async (decision) => {
    setError('');
    if (decision === 'deny' && !deniedReason.trim()) {
      setError('Please provide a reason for denial.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { decision };
      if (decision === 'approve' && approvedDuration) {
        body.approvedDuration = Number(approvedDuration) * 60; // convert minutes to seconds
      }
      if (decision === 'deny') {
        body.deniedReason = deniedReason.trim();
      }
      await reviewAccessRequest(request.id, body);
      onRefresh?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Action failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border p-4">
      <h4 className="text-sm font-semibold text-foreground">Review Request</h4>

      {/* Approve */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Approve</p>
        <div>
          <label className={labelCls}>Approved Duration (minutes, leave blank to use requested)</label>
          <input
            type="number"
            className={`${inputCls} w-40`}
            min="1"
            placeholder={String(Math.ceil((request.requestedDuration || 3600) / 60))}
            value={approvedDuration}
            onChange={(e) => setApprovedDuration(e.target.value)}
            disabled={submitting}
          />
        </div>
        <button
          onClick={() => handleDecision('approve')}
          disabled={submitting}
          className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <CheckCircle className="h-4 w-4" />
          {submitting ? 'Processing...' : 'Approve'}
        </button>
      </div>

      {/* Deny */}
      <div className="rounded-md border border-destructive/30 p-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Deny</p>
        <div>
          <label className={labelCls}>Reason for Denial <span className="text-destructive">*</span></label>
          <textarea
            className={`${inputCls} min-h-16 resize-none`}
            rows={2}
            value={deniedReason}
            onChange={(e) => setDeniedReason(e.target.value)}
            placeholder="Explain why this request is being denied..."
            disabled={submitting}
          />
        </div>
        <button
          onClick={() => handleDecision('deny')}
          disabled={submitting}
          className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          <XCircle className="h-4 w-4" />
          {submitting ? 'Processing...' : 'Deny'}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

export default ApprovalCard;
