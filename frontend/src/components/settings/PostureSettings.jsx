import { useState } from 'react';
import PostureGeneralTab from '@/components/settings/PostureGeneralTab';
import PostureAlertRulesTab from '@/components/settings/PostureAlertRulesTab';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'alerts', label: 'Alert rules' },
];

/** Administration → Organization → Posture (posture.settings). */
function PostureSettings() {
  const [tab, setTab] = useState('general');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border md:overflow-visible">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              'relative shrink-0 whitespace-nowrap px-2.5 py-2.5 text-sm font-medium transition-colors md:px-4',
              tab === t.key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' ? <PostureGeneralTab /> : <PostureAlertRulesTab />}
    </div>
  );
}

export default PostureSettings;
