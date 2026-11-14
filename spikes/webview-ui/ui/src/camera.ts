// The view onto the arrangement: which time is at the left edge, how many seconds
// one CSS pixel covers, how far down the tracks are scrolled and how tall a track is.

export interface Camera {
  /** Time at the left edge of the timeline, in seconds. */
  originSec: number;
  /** Seconds per CSS pixel. Smaller is more zoomed in. */
  secPerPx: number;
  /** Vertical scroll, in CSS pixels from the first track. */
  scrollY: number;
  /** Track height in CSS pixels. */
  trackHeight: number;
}

export interface Bounds {
  lengthSec: number;
  tracks: number;
  viewWidth: number;
  viewHeight: number;
}

export const limits = {
  minSecPerPx: 1 / 2000,
  maxSecPerPx: 2,
  minTrackHeight: 6,
  maxTrackHeight: 160,
} as const;

/** Height of the ruler strip at the top of the timeline, in CSS pixels. */
export const rulerHeight = 24;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function timeToX(camera: Camera, sec: number): number {
  return (sec - camera.originSec) / camera.secPerPx;
}

export function xToTime(camera: Camera, x: number): number {
  return camera.originSec + x * camera.secPerPx;
}

export function trackToY(camera: Camera, track: number): number {
  return rulerHeight + track * camera.trackHeight - camera.scrollY;
}

/** Keeps the camera inside the arrangement, with a little room past each end. */
export function clampCamera(camera: Camera, bounds: Bounds): Camera {
  const secPerPx = clamp(camera.secPerPx, limits.minSecPerPx, limits.maxSecPerPx);
  const trackHeight = clamp(camera.trackHeight, limits.minTrackHeight, limits.maxTrackHeight);
  const visibleSec = bounds.viewWidth * secPerPx;
  const maxOrigin = Math.max(0, bounds.lengthSec - visibleSec * 0.5);
  const contentHeight = bounds.tracks * trackHeight;
  const maxScroll = Math.max(0, contentHeight - (bounds.viewHeight - rulerHeight) * 0.5);
  return {
    secPerPx,
    trackHeight,
    originSec: clamp(camera.originSec, -visibleSec * 0.1, maxOrigin),
    scrollY: clamp(camera.scrollY, 0, maxScroll),
  };
}

export function pan(camera: Camera, dxPx: number, dyPx: number, bounds: Bounds): Camera {
  return clampCamera(
    { ...camera, originSec: camera.originSec - dxPx * camera.secPerPx, scrollY: camera.scrollY - dyPx },
    bounds,
  );
}

/** Zooms time by `factor` (above 1 zooms in) keeping the time under `anchorX` where it is. */
export function zoomTime(camera: Camera, factor: number, anchorX: number, bounds: Bounds): Camera {
  if (!(factor > 0)) return camera;
  const anchorSec = xToTime(camera, anchorX);
  const secPerPx = clamp(camera.secPerPx / factor, limits.minSecPerPx, limits.maxSecPerPx);
  return clampCamera({ ...camera, secPerPx, originSec: anchorSec - anchorX * secPerPx }, bounds);
}

/** Zooms track height by `factor`, keeping the track position under `anchorY` where it is. */
export function zoomTracks(camera: Camera, factor: number, anchorY: number, bounds: Bounds): Camera {
  if (!(factor > 0)) return camera;
  const trackHeight = clamp(camera.trackHeight * factor, limits.minTrackHeight, limits.maxTrackHeight);
  const anchorTrack = (anchorY - rulerHeight + camera.scrollY) / camera.trackHeight;
  const scrollY = anchorTrack * trackHeight - (anchorY - rulerHeight);
  return clampCamera({ ...camera, trackHeight, scrollY }, bounds);
}

/** A starting view: the first 60 seconds across the whole width, 28 px tracks. */
export function initialCamera(bounds: Bounds): Camera {
  return clampCamera({ originSec: 0, secPerPx: 60 / Math.max(1, bounds.viewWidth), scrollY: 0, trackHeight: 28 }, bounds);
}
