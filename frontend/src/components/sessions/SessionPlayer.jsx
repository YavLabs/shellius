import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, AlertCircle } from 'lucide-react';
// Required for the player to render its terminal grid — without it the player
// mounts collapsed/empty.
import 'asciinema-player/dist/bundle/asciinema-player.css';

/**
 * SessionPlayer
 *
 * Renders an asciinema-player for a recorded session.
 * Fetches the .cast recording blob from the API with the auth bearer token,
 * converts it to an object URL, then hands it to AsciinemaPlayer.create().
 *
 * Props:
 *   sessionId  {string}  — session ID whose recording to play
 */
function SessionPlayer({ sessionId }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error | unavailable
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    async function loadAndPlay() {
      setStatus('loading');
      setErrorMsg('');

      try {
        const token = localStorage.getItem('accessToken');
        const base = import.meta.env.VITE_API_URL || '/api';
        const response = await fetch(`${base}/sessions/${sessionId}/recording`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (response.status === 404) {
          if (!cancelled) setStatus('unavailable');
          return;
        }
        if (!response.ok) {
          throw new Error(`Server responded with ${response.status}`);
        }

        // Read the recording text and hand it to the player INLINE via the
        // `{ data }` source. This avoids fetching a blob: object URL (which the
        // player's internal fetch + CSP/worker setup can choke on) — the most
        // reliable way to play an authenticated, in-memory recording.
        const castText = await response.text();
        if (cancelled) return;

        // Dynamically import asciinema-player to avoid SSR issues and keep
        // the initial bundle lean.
        const AsciinemaPlayer = await import('asciinema-player');
        if (cancelled) return;

        if (!containerRef.current) return;

        playerRef.current = AsciinemaPlayer.create(
          { data: castText, parser: 'asciicast' },
          containerRef.current,
          {
            autoPlay: false,
            speed: 1,
            theme: 'asciinema',
            fit: 'width',
            controls: true,
          }
        );

        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(err.message || 'Failed to load recording.');
        }
      }
    }

    loadAndPlay();

    return () => {
      cancelled = true;
      if (playerRef.current?.dispose) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [sessionId]);

  return (
    <div className="space-y-2">
      {status === 'loading' && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading recording...
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {errorMsg || 'Failed to load recording.'}
        </div>
      )}

      {status === 'unavailable' && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <Film className="h-4 w-4 shrink-0" />
          No recording available for this session.
        </div>
      )}

      {/* Player mounts here; hidden until ready to avoid layout flash */}
      <div
        ref={containerRef}
        className={status === 'ready' ? 'overflow-hidden rounded-md' : 'hidden'}
      />
    </div>
  );
}

export default SessionPlayer;
