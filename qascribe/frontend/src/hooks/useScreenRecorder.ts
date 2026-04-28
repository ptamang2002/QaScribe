/**
 * useScreenRecorder — production-grade screen+voice recording hook.
 *
 * Edge cases handled (learnings from leading apps):
 *   - User doesn't tick "Share tab audio" -> falls back to mic-only with warning
 *   - User cancels picker -> resets cleanly, no error toast
 *   - Browser doesn't support tab audio (Safari) -> info banner, mic-only mode
 *   - Long recordings -> MediaRecorder uses timeslice to chunk data
 *   - Auto-stop at hard cap to prevent runaway file size
 *   - Stream cleanup on stop/unmount (kills the browser red recording dot)
 *   - beforeunload prompt during recording
 *   - MediaRecorder mimetype detection (mp4 preferred, fallback to webm)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingSettings } from '../types';

export type RecorderState =
  | 'idle'
  | 'requesting_permissions'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface RecorderResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

interface UseScreenRecorderOptions {
  micDeviceId?: string;
  captureSystemAudio: boolean;
  maxDurationSeconds: number;   // hard cap, e.g. 3570 (59:30)
  warnAtSeconds?: number;       // warn user near the cap, e.g. 3300 (55:00)
  settings: RecordingSettings;
  onWarning?: (message: string) => void;
  onAutoStop?: () => void;
}

const PREFERRED_MIME_TYPES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickSupportedMimeType(): string {
  for (const type of PREFERRED_MIME_TYPES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export function useScreenRecorder(options: UseScreenRecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [result, setResult] = useState<RecorderResult | null>(null);

  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const tickerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const warnedRef = useRef(false);

  const cleanupStreams = useCallback(() => {
    [displayStreamRef.current, micStreamRef.current, combinedStreamRef.current].forEach(
      (s) => s?.getTracks().forEach((t) => t.stop()),
    );
    displayStreamRef.current = null;
    micStreamRef.current = null;
    combinedStreamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, []);

  // beforeunload guard during recording
  useEffect(() => {
    if (state !== 'recording') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanupStreams();
  }, [cleanupStreams]);

  const start = useCallback(async () => {
    setErrorMessage(null);
    setWarningMessage(null);
    setResult(null);
    chunksRef.current = [];
    warnedRef.current = false;
    setState('requesting_permissions');

    try {
      // 1. Get display stream (screen + optional system audio)
      const displayConstraints: DisplayMediaStreamOptions = {
        video: {
          frameRate: { ideal: options.settings.frameRate },
          // @ts-expect-error -- 'displaySurface' is supported but missing in older type defs
          displaySurface: 'browser',
        },
        audio: options.captureSystemAudio,
      };
      let displayStream: MediaStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
      } catch (err: unknown) {
        // User cancelled the picker — silent reset
        if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
          setState('idle');
          return;
        }
        throw err;
      }
      displayStreamRef.current = displayStream;

      const displayHasAudio = displayStream.getAudioTracks().length > 0;
      if (options.captureSystemAudio && !displayHasAudio) {
        setWarningMessage(
          "Page audio not captured — to include page sounds, re-share the tab and tick 'Share tab audio'.",
        );
      }

      // 2. Get mic stream
      let micStream: MediaStream | null = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: options.micDeviceId
            ? { deviceId: { exact: options.micDeviceId } }
            : true,
        });
        micStreamRef.current = micStream;
      } catch (err) {
        // No mic is OK — we can still record the screen
        console.warn('Microphone unavailable:', err);
        setWarningMessage(
          (prev) =>
            prev || 'Microphone unavailable — recording without voice annotation.',
        );
      }

      // 3. Combine audio tracks via Web Audio API if both exist
      const finalTracks: MediaStreamTrack[] = [...displayStream.getVideoTracks()];
      if (displayHasAudio && micStream) {
        const ctx = new AudioContext();
        audioContextRef.current = ctx;
        const dest = ctx.createMediaStreamDestination();
        const sysSrc = ctx.createMediaStreamSource(displayStream);
        const micSrc = ctx.createMediaStreamSource(micStream);
        sysSrc.connect(dest);
        micSrc.connect(dest);
        finalTracks.push(...dest.stream.getAudioTracks());
      } else if (displayHasAudio) {
        finalTracks.push(...displayStream.getAudioTracks());
      } else if (micStream) {
        finalTracks.push(...micStream.getAudioTracks());
      }

      const combined = new MediaStream(finalTracks);
      combinedStreamRef.current = combined;

      // 4. If user stops sharing via the browser's Stop button, end gracefully
      displayStream.getVideoTracks()[0].addEventListener('ended', () => {
        // Browser-initiated stop
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          recorderRef.current.stop();
        }
      });

      // 5. Pick mimetype + create MediaRecorder
      const mimeType = pickSupportedMimeType();
      if (!mimeType) {
        throw new Error('Browser does not support any compatible recording format.');
      }
      const audioBitsPerSecond = options.settings.audioBitrate * 1000;
      const recorder = new MediaRecorder(combined, {
        mimeType,
        audioBitsPerSecond,
      });
      recorderRef.current = recorder;

      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      });
      recorder.addEventListener('stop', () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const duration = (Date.now() - startTimeRef.current) / 1000;
        setResult({ blob, mimeType, durationSeconds: duration });
        setState('stopped');
        cleanupStreams();
      });
      recorder.addEventListener('error', (e) => {
        console.error('MediaRecorder error:', e);
        setErrorMessage('Recording error — please try again.');
        setState('error');
        cleanupStreams();
      });

      // Use timeslice (1 second chunks) to avoid memory issues on long recordings
      recorder.start(1000);
      startTimeRef.current = Date.now();
      setState('recording');

      // Ticker for elapsed time + auto-stop + warning
      tickerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setElapsedSeconds(elapsed);

        const warnAt = options.warnAtSeconds ?? options.maxDurationSeconds - 30;
        if (!warnedRef.current && elapsed >= warnAt) {
          warnedRef.current = true;
          options.onWarning?.(
            `Recording will auto-stop in ${Math.round(options.maxDurationSeconds - elapsed)}s.`,
          );
        }

        if (elapsed >= options.maxDurationSeconds) {
          options.onAutoStop?.();
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            recorderRef.current.stop();
          }
        }
      }, 250);
    } catch (err: unknown) {
      console.error('Recorder start failed:', err);
      const msg = err instanceof Error ? err.message : 'Failed to start recording.';
      setErrorMessage(msg);
      setState('error');
      cleanupStreams();
    }
  }, [options, cleanupStreams]);

  const stop = useCallback(() => {
    setState('stopping');
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      cleanupStreams();
      setState('idle');
    }
  }, [cleanupStreams]);

  const reset = useCallback(() => {
    cleanupStreams();
    chunksRef.current = [];
    setResult(null);
    setElapsedSeconds(0);
    setErrorMessage(null);
    setWarningMessage(null);
    setState('idle');
  }, [cleanupStreams]);

  return {
    state,
    elapsedSeconds,
    errorMessage,
    warningMessage,
    result,
    start,
    stop,
    reset,
  };
}
