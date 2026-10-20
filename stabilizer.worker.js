/**
 * UltraSteady V3 - Background Computer Vision Web Worker
 * Runs Lucas-Kanade Optical Flow & Trajectory Smoothing off the Main Thread
 */

let prevGray = null;
let smoothX = 0;
let smoothY = 0;
let camX = 0;
let camY = 0;

// Highly optimized LK Block Matching in Web Worker
self.onmessage = function (e) {
  const { type, width, height, buffer, smoothness } = e.data;

  if (type === 'PROCESS_FRAME') {
    const currGray = new Uint8Array(buffer);

    if (!prevGray || prevGray.length !== currGray.length) {
      prevGray = currGray;
      self.postMessage({ type: 'MOTION_RESULT', dx: 0, dy: 0, offsetX: 0, offsetY: 0 });
      return;
    }

    // 9 Keypoint tracking across 3x3 grid
    const stepX = Math.floor(width / 4);
    const stepY = Math.floor(height / 4);
    const searchR = 6;
    const patchR = 4;

    const dxs = [];
    const dys = [];

    for (let gy = stepY; gy <= height - stepY; gy += stepY) {
      for (let gx = stepX; gx <= width - stepX; gx += stepX) {
        let minSad = Infinity;
        let bestDx = 0;
        let bestDy = 0;

        for (let sy = -searchR; sy <= searchR; sy += 2) {
          for (let sx = -searchR; sx <= searchR; sx += 2) {
            let sad = 0;
            for (let py = -patchR; py <= patchR; py += 2) {
              const r1 = (gy + py) * width + gx;
              const r2 = (gy + py + sy) * width + (gx + sx);
              for (let px = -patchR; px <= patchR; px += 2) {
                sad += Math.abs(currGray[r2 + px] - prevGray[r1 + px]);
              }
            }
            // Center bias to suppress drift
            sad += (Math.abs(sx) + Math.abs(sy)) * 4;

            if (sad < minSad) {
              minSad = sad;
              bestDx = sx;
              bestDy = sy;
            }
          }
        }
        dxs.push(bestDx);
        dys.push(bestDy);
      }
    }

    prevGray = currGray;

    // Median filter to reject moving subjects in front of camera
    dxs.sort((a, b) => a - b);
    dys.sort((a, b) => a - b);
    const mid = Math.floor(dxs.length / 2);
    const medianDx = dxs[mid] / width;
    const medianDy = dys[mid] / height;

    // Deadzone to completely kill micro-jitter and drift when holding still
    const deadzone = 0.008; // Filter out small noise
    const filteredDx = Math.abs(medianDx) > deadzone ? medianDx : 0;
    const filteredDy = Math.abs(medianDy) > deadzone ? medianDy : 0;

    // Intelligent Pan Detection: If user turns camera deliberately, don't drag!
    const panMagnitude = Math.hypot(filteredDx, filteredDy);
    if (panMagnitude > 0.04) {
      // Rapid pan detected: instantly flush camera trajectory so it snaps to hand
      camX = 0;
      camY = 0;
      smoothX = 0;
      smoothY = 0;
      self.postMessage({
        type: 'MOTION_RESULT',
        dx: 0,
        dy: 0,
        offsetX: 0,
        offsetY: 0
      });
      return;
    }

    camX += filteredDx;
    camY += filteredDy;

    // Strong auto-centering spring so camera NEVER drifts or floats away
    camX *= 0.82; // Faster snap back
    camY *= 0.82;

    const alpha = smoothness || 0.72; // Snappier smoothing
    smoothX = smoothX * alpha + camX * (1 - alpha);
    smoothY = smoothY * alpha + camY * (1 - alpha);

    // Compute corrective offset with tight bounds
    let offX = (smoothX - camX);
    let offY = (smoothY - camY);

    const maxBound = 0.12; // Controlled steady zone
    if (Math.abs(offX) > maxBound) offX = Math.sign(offX) * maxBound;
    if (Math.abs(offY) > maxBound) offY = Math.sign(offY) * maxBound;

    // Zero out sub-pixel jitter
    if (Math.abs(offX) < 0.002) offX = 0;
    if (Math.abs(offY) < 0.002) offY = 0;

    self.postMessage({
      type: 'MOTION_RESULT',
      dx: filteredDx,
      dy: filteredDy,
      offsetX: offX,
      offsetY: offY
    });
  } else if (type === 'RESET') {
    camX = 0;
    camY = 0;
    smoothX = 0;
    smoothY = 0;
    prevGray = null;
    self.postMessage({ type: 'MOTION_RESULT', dx: 0, dy: 0, offsetX: 0, offsetY: 0 });
  }
};
