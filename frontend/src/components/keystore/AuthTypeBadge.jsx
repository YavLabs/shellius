import { Badge } from '@/components/ui/badge';

const LABELS = {
  password: 'Password',
  key: 'Private key',
  key_password: 'Key + password',
};

function AuthTypeBadge({ authType, className }) {
  return (
    <Badge variant="secondary" className={className}>
      {LABELS[authType] || authType}
    </Badge>
  );
}

export default AuthTypeBadge;
