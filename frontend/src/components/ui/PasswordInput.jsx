import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * PasswordInput — a masked input with a show/hide toggle. Drop-in replacement
 * for `<input type="password" ... />`; pass the same props (value, onChange,
 * placeholder, className, autoComplete, disabled, etc.). The eye toggle sits
 * inside the field; the className you pass styles the input itself.
 */
export default function PasswordInput({ className = '', ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={show ? 'text' : 'password'}
        className={`${className} pr-9`}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide' : 'Show'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
