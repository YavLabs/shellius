import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Loader2, AlertCircle, Play, Pause } from 'lucide-react';

/**
 * RdpSessionPlayer
 *
 * Replays an RDP session. An RDP recording is a Guacamole protocol dump — the
 * same instruction stream the live client renders — not an asciinema cast, so
 * it needs Guacamole's own player rather than the one next door in
 * SessionPlayer.jsx.
 *
 * Guacamole.SessionRecording takes a Blob, which is why the whole file is
 * fetched before playback starts: there is no streaming entry point, and the
 * request needs the bearer token anyway, so a bare <video>-style URL was never
 * an option.
 *
 * Props:
 *   sessionId {string}
 */
function RdpSessionPlayer({ sessionId }) {
  const containerRef = useRef(null);
  const recordingRef = useRef(null);
  // Bumped whenever a load is abandoned. An async load that resumes after the
  // component moved on must not attach a player to a container that is gone —
  // the same generation guard the live RDP client uses.
  const runIdRef = useRef(0);

  const [status, setStatus] = useState('idle'); // idle | loading | ready | error | unavailable
  const [errorMsg, setErrorMsg] = useState('');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const teardown = useCallback(() => {
    runIdRef.current += 1;
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) {
      try {
        rec.pause();
      } catch {
        /* already stopped */
      }
    }
    if (containerRef.current) containerRef.current.replaceChildren();
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;

    teardown();
    const runId = runIdRef.current;
    const superseded = () => runId !== runIdRef.current;

    async function load() {
      setStatus('loading');
      setErrorMsg('');

      try {
        const token = localStorage.getItem('accessToken');
        const base = import.meta.env.VITE_API_URL || '/api';
        const response = await fetch(`${base}/sessions/${sessionId}/recording`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (superseded()) return;

        if (response.status === 404) {
          setStatus('unavailable');
          return;
        }
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);

        const blob = await response.blob();
        if (superseded()) return;

        // A recording that decrypted to nothing plays as a blank screen with
        // no error, which reads as "the session was empty" rather than "the
        // recording is broken".
        if (blob.size === 0) {
          setStatus('unavailable');
          return;
        }

        const Guacamole = (await import('guacamole-common-js')).default;
        if (superseded() || !containerRef.current) return;

        const recording = new Guacamole.SessionRecording(blob);
        recordingRef.current = recording;

        const display = recording.getDisplay();
        containerRef.current.replaceChildren(display.getElement());

        recording.onprogress = (ms) => {
          if (!superseded()) setDuration(ms);
        };
        recording.onseek = (ms) => {
          if (!superseded()) setPosition(ms);
        };
        recording.onplay = () => {
          if (!superseded()) setPlaying(true);
        };
        recording.onpause = () => {
          if (!superseded()) setPlaying(false);
        };

        setStatus('ready');
      } catch (err) {
        if (!superseded()) {
          setStatus('error');
          setErrorMsg(err.message || 'Failed to load recording.');
        }
      }
    }

    load();
    return teardown;
  }, [sessionId, teardown]);

  const toggle = () => {
    const rec = recordingRef.current;
    if (!rec) return;
    if (playing) rec.pause();
    else rec.play();
  };

  const seek = (event) => {
    const rec = recordingRef.current;
    if (!rec) return;
    const ms = Number(event.target.value);
    // Seeking while playing leaves the player wedged in some builds; pause,
    // move, then resume if it was running.
    const wasPlaying = playing;
    rec.pause();
    rec.seek(ms, () => {
      setPosition(ms);
      if (wasPlaying) rec.play();
    });
  };

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

      {/* data-modal-passthrough: the controls sit inside a Modal, whose
          stopPropagation would otherwise swallow their clicks. */}
      <div
        ref={containerRef}
        data-modal-passthrough
        className={
          status === 'ready'
            ? 'overflow-auto rounded-md border border-border bg-black [&_canvas]:max-w-full'
            : 'hidden'
        }
      />

      {status === 'ready' && (
        <div className="flex items-center gap-3" data-modal-passthrough>
          <button
            onClick={toggle}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={Math.min(position, duration || 0)}
            onChange={seek}
            className="h-1 flex-1 cursor-pointer appearance-none rounded bg-border accent-primary"
            aria-label="Seek"
          />
          <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
            {formatMs(position)} / {formatMs(duration)}
          </span>
        </div>
      )}
    </div>
  );
}

/** mm:ss, because an RDP session is measured in minutes, not hours. */
export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export default RdpSessionPlayer;
