/** Detect browser capabilities for recording. */
export interface BrowserSupport {
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
  isSafari: boolean;
  isChromiumBased: boolean;
  fullySupported: boolean;
}

export function detectBrowserSupport(): BrowserSupport {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isChromiumBased = /chrome|edg|opera/i.test(ua) && !isSafari;
  const hasGetDisplayMedia =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function';
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';

  return {
    hasGetDisplayMedia,
    hasMediaRecorder,
    isSafari,
    isChromiumBased,
    fullySupported: hasGetDisplayMedia && hasMediaRecorder && !isSafari,
  };
}
