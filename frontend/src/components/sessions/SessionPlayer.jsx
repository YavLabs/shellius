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
 * then hands the text to AsciinemaPlayer.create().
 *
 * Props:
 *   sessionId   {string}    — session ID whose recording to play
 *   onCast      {function}  — optional, called with the raw .cast text once
 *                             loaded (so a sibling can derive the command list
 *                             without re-fetching)
 */
function SessionPlayer({ sessionId, onCast }) {
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

        if (onCast) onCast(castText);

        // Dynamically import asciinema-player to avoid SSR issues and keep
        // the initial bundle lean.
        const AsciinemaPlayer = await import('asciinema-player');
        if (cancelled) return;

        if (!containerRef.current) return;

        // IMPORTANT: flip to "ready" BEFORE create() so the container is
        // visible (not display:none). asciinema-player measures the element's
        // width on creation with fit:'width'; if it mounts inside a hidden
        // element it computes a zero size and renders a collapsed, unclickable
        // player. Making it visible first is what fixes the "thumbnail shows
        // but nothing is clickable" bug.
        setStatus('ready');

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
  }, [sessionId, onCast]);

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

      {/*
        The player mounts here. The container stays in the layout flow and
        visible while create() runs (see note above) — an empty container is
        simply zero-height, so there is no visible flash before playback.

        data-modal-passthrough: when this player is inside a <Modal>, its clicks
        must NOT be swallowed by the modal's stopPropagation, or asciinema's
        (Solid.js) delegated click handlers never fire and playback/controls go
        dead. See Modal.jsx stopUnlessPassthrough.
      */}
      <div
        ref={containerRef}
        data-modal-passthrough
        className={status === 'ready' ? 'overflow-hidden rounded-md border border-border' : ''}
      />
    </div>
  );
}

export default SessionPlayer;
