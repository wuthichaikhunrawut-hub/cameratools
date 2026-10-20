/**
 * UltraSteady Pro Cam — Hybrid Vision + Sensor EIS & GPU Clarity Engine
 * Designed specifically for phones without OIS / Hardware Gyroscope (e.g. Vivo Y21T)
 */

const rawVideo = document.getElementById('rawVideo');
const steadyCanvas = document.getElementById('steadyCanvas');
const ctx = steadyCanvas.getContext('2d', { alpha: false, desynchronized: true });

const rawPreviewCanvas = document.getElementById('rawPreviewCanvas');
const rawPreviewCtx = rawPreviewCanvas.getContext('2d', { alpha: false });

// Offscreen 96x96 canvas for real-time Optical Flow (Block Matching)
const FLOW_SIZE = 96;
const flowCanvas = document.createElement('canvas');
flowCanvas.width = FLOW_SIZE;
flowCanvas.height = FLOW_SIZE;
const flowCtx = flowCanvas.getContext('2d', { willReadFrequently: true });
let prevLuma = null;

// UI Elements
const hudModeBadge = document.getElementById('hudModeBadge');
const hudResBadge = document.getElementById('hudResBadge');
const hudFpsBadge = document.getElementById('hudFpsBadge');
const shakeMeterFill = document.getElementById('shakeMeterFill');
const shakePxText = document.getElementById('shakePxText');
const rollAngleText = document.getElementById('rollAngleText');
const horizonLine = document.querySelector('.horizon-line');
const pipRawBox = document.getElementById('pipRawBox');
const sharpenMatrix = document.getElementById('sharpenMatrix');
const toastMsg = document.getElementById('toastMsg');

// Controls
const sliderSmooth = document.getElementById('sliderSmooth');
const valSmooth = document.getElementById('sliderSmooth').nextElementSibling;
const sliderCrop = document.getElementById('sliderCrop');
const valCrop = document.getElementById('sliderCrop').nextElementSibling;
const chkOpticalFlow = document.getElementById('chkOpticalFlow');
const chkHorizonLock = document.getElementById('chkHorizonLock');

const sliderSharpness = document.getElementById('sliderSharpness');
const valSharpness = document.getElementById('valSharpness');
const sliderClarity = document.getElementById('sliderClarity');
const valClarity = document.getElementById('valClarity');
const selectRes = document.getElementById('selectRes');
const selectBitrate = document.getElementById('selectBitrate');
const chkAntiBlur = document.getElementById('chkAntiBlur');

// State
let currentStream = null;
let facingMode = 'environment';
let torchOn = false;
let showPip = false;

// Stabilization State
const state = {
  enabled: true,
  smoothness: 0.88,      // 0.50 to 0.97
  cropPercent: 0.28,     // 0.05 to 0.42
  useOpticalFlow: true,
  useHorizonLock: true,
  sharpness: 45,         // 0 to 100
  clarity: 18,           // 0 to 60
  targetResHeight: 1440,
  videoBitrate: 20000000,
  antiBlurShutter: true,

  // Cumulative camera motion & smoothed virtual trajectory (in normalized -1..1 space)
  camX: 0,
  camY: 0,
  smoothX: 0,
  smoothY: 0,
  velX: 0,
  velY: 0,

  // Accelerometer / Gravity Roll & Shock
  rawRollRad: 0,
  smoothRollRad: 0,
  accelShockX: 0,
  accelShockY: 0
};

// Recording State
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recStartTime = 0;
let recTimerInterval = null;

// FPS Counter
let frameCount = 0;
let lastFpsTime = performance.now();

// Toast helper
function showToast(text, duration = 2600) {
  toastMsg.textContent = text;
  toastMsg.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastMsg.classList.add('hidden');
  }, duration);
}

  // Update GPU Convolution Matrix for Real-time Hardware Sharpening
function updateGpuFilters() {
  const s = state.sharpness / 100; // 0.0 to 1.0
  if (s <= 0.01 && state.clarity <= 1 && !state.antiBlurShutter) {
    state.activeFilter = 'none';
    steadyCanvas.style.filter = 'none';
    return;
  }

  // 3x3 Unsharp Convolution Kernel:
  // [  0,   -k,    0 ]
  // [ -k, 1+4k,   -k ]
  // [  0,   -k,    0 ]
  const k = +(s * 1.35).toFixed(3);
  const center = +(1 + 4 * k).toFixed(3);
  const kernel = `0 ${-k} 0 ${-k} ${center} ${-k} 0 ${-k} 0`;
  sharpenMatrix.setAttribute('kernelMatrix', kernel);

  const contrast = 100 + Math.round(state.clarity * 0.45);
  const saturate = 100 + Math.round(state.clarity * 0.30);
  // Anti-blur slightly darkens hardware exposure for faster shutter, so we lift display brightness slightly
  const brightness = state.antiBlurShutter ? 105 : 100;

  const filterParts = [];
  if (s > 0.01) {
    filterParts.push('url(#gpuSharpen)');
  }
  filterParts.push(`contrast(${contrast}%) saturate(${saturate}%) brightness(${brightness}%)`);
  const filterStr = filterParts.join(' ');

  // Bake filter directly into Canvas 2D Context so recorded MP4/WebM & Photos also get sharpened!
  if ('filter' in ctx) {
    state.activeFilter = filterStr;
    steadyCanvas.style.filter = 'none';
  } else {
    state.activeFilter = 'none';
    steadyCanvas.style.filter = filterStr;
  }
}

// Apply Hardware Camera Constraints (Autofocus, Anti-Motion-Blur Exposure)
async function applyHardwareEnhancements() {
  if (!currentStream) return;
  const track = currentStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;

  try {
    const caps = track.getCapabilities();
    const adv = {};

    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      adv.focusMode = 'continuous';
    }
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) {
      adv.whiteBalanceMode = 'continuous';
    }
    // Anti-Motion-Blur trick: step down exposure compensation slightly so ISP chooses a faster shutter speed
    if (caps.exposureCompensation) {
      const minEv = caps.exposureCompensation.min || -2;
      const maxEv = caps.exposureCompensation.max || 2;
      const targetEv = state.antiBlurShutter ? Math.max(minEv, -0.5) : 0;
      if (targetEv >= minEv && targetEv <= maxEv) {
        adv.exposureCompensation = targetEv;
      }
    }

    if (Object.keys(adv).length > 0) {
      await track.applyConstraints({ advanced: [adv] });
    }
  } catch (e) {
    // Ignore unsupported constraint warnings on specific Android WebViews
  }
}

// Start Camera Stream with Oversampled Resolution
async function startCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
  }

  const targetH = state.targetResHeight;
  const targetW = Math.round((targetH * 16) / 9);

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: targetW },
      height: { ideal: targetH },
      frameRate: { ideal: 60, min: 30 }
    }
  };

  try {
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    rawVideo.srcObject = currentStream;
    await rawVideo.play();

    const vw = rawVideo.videoWidth || 1280;
    const vh = rawVideo.videoHeight || 720;

    // Set output canvas resolution high for crisp detail
    steadyCanvas.width = vw;
    steadyCanvas.height = vh;

    hudResBadge.textContent = `${ vw }×${ vh }`;
    await applyHardwareEnhancements();
    updateGpuFilters();
    showToast(`เปิดกล้องสำเร็จ (${ vw }×${ vh })`);
  } catch (err) {
    console.error('Camera error:', err);
    showToast('ไม่สามารถเปิดกล้องได้ กรุณาอนุญาตสิทธิ์การใช้กล้อง');
  }
}

// Fast 9-Block Visual Optical Flow Estimator (Runs in <1ms on Snapdragon 680)
function estimateVisualMotion() {
  if (!rawVideo.videoWidth) return { dx: 0, dy: 0 };

  flowCtx.drawImage(rawVideo, 0, 0, FLOW_SIZE, FLOW_SIZE);
  const imgData = flowCtx.getImageData(0, 0, FLOW_SIZE, FLOW_SIZE).data;

  // Convert RGBA to 8-bit Luminance array
  const currLuma = new Uint8Array(FLOW_SIZE * FLOW_SIZE);
  for (let i = 0, j = 0; i < imgData.length; i += 4, j++) {
    // Fast integer luma: (R*2 + G*5 + B) >> 3
    currLuma[j] = (imgData[i] * 2 + imgData[i + 1] * 5 + imgData[i + 2]) >> 3;
  }

  if (!prevLuma) {
    prevLuma = currLuma;
    return { dx: 0, dy: 0 };
  }

  // 9 anchor blocks (3x3 grid inside central 64x64 region)
  const blockCenters = [26, 48, 70];
  const blockHalf = 6; // 12x12 patch
  const searchRadius = 6; // +-6 pixels search window

  const dxs = [];
  const dys = [];

  for (let by of blockCenters) {
    for (let bx of blockCenters) {
      let bestSad = Infinity;
      let bestDx = 0;
      let bestDy = 0;

      for (let sy = -searchRadius; sy <= searchRadius; sy++) {
        for (let sx = -searchRadius; sx <= searchRadius; sx++) {
          let sad = 0;
          // Sample every 2nd pixel for 4x speed boost
          for (let py = -blockHalf; py < blockHalf; py += 2) {
            const r1 = (by + py) * FLOW_SIZE + bx;
            const r2 = (by + py + sy) * FLOW_SIZE + (bx + sx);
            for (let px = -blockHalf; px < blockHalf; px += 2) {
              sad += Math.abs(currLuma[r2 + px] - prevLuma[r1 + px]);
            }
          }
          // Slight bias toward (0,0) to prevent drift on flat walls
          sad += (Math.abs(sx) + Math.abs(sy)) * 3;
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = sx;
            bestDy = sy;
          }
        }
      }
      dxs.push(bestDx);
      dys.push(bestDy);
    }
  }

  prevLuma = currLuma;

  // Median filter across the 9 blocks to reject moving subjects in the scene
  dxs.sort((a, b) => a - b);
  dys.sort((a, b) => a - b);
  const medianDx = dxs[4] / FLOW_SIZE; // Normalized shift (-1..1)
  const medianDy = dys[4] / FLOW_SIZE;

  return { dx: medianDx, dy: medianDy };
}

// Listen to Accelerometer & Gravity for Horizon Lock & Step Shock Absorption
window.addEventListener('devicemotion', (e) => {
  const ag = e.accelerationIncludingGravity;
  const lin = e.acceleration;

  if (ag && ag.x !== null && ag.y !== null) {
    // Calculate gravity tilt roll angle in portrait mode
    const roll = Math.atan2(ag.x, ag.y);
    // Only lock horizon within +-40 degrees so flipping orientation doesn't spin wildly
    if (Math.abs(roll) < 0.75) {
      state.rawRollRad = roll;
    }
  }

  if (lin && lin.x !== null && lin.y !== null) {
    // High-frequency hand tremor / walking step shock impulse
    state.accelShockX = Math.max(-0.04, Math.min(0.04, lin.x * 0.0022));
    state.accelShockY = Math.max(-0.04, Math.min(0.04, -lin.y * 0.0022));
  }
}, { passive: true });

// Main 60FPS Stabilization Render Loop
function renderLoop(now) {
  requestAnimationFrame(renderLoop);

  if (rawVideo.readyState < 2 || !steadyCanvas.width) return;

  const cw = steadyCanvas.width;
  const ch = steadyCanvas.height;

  // 1. Measure frame-to-frame camera shake
  let flowDx = 0;
  let flowDy = 0;
  if (state.enabled && state.useOpticalFlow) {
    const flow = estimateVisualMotion();
    flowDx = flow.dx;
    flowDy = flow.dy;
  }

  // Combine visual shift + accelerometer micro-shock
  const stepDx = flowDx + state.accelShockX;
  const stepDy = flowDy + state.accelShockY;
  state.accelShockX *= 0.7;
  state.accelShockY *= 0.7;

  // Update cumulative camera position
  state.camX += stepDx;
  state.camY += stepDy;

  // Smooth virtual camera trajectory (Spring-Damper Low-Pass Filter)
  const alpha = state.smoothness; // e.g., 0.88 to 0.97
  state.smoothX = state.smoothX * alpha + state.camX * (1 - alpha);
  state.smoothY = state.smoothY * alpha + state.camY * (1 - alpha);

  // Corrective offset = difference between smooth virtual path and raw jerky camera
  let offsetX = (state.smoothX - state.camX) * cw;
  let offsetY = (state.smoothY - state.camY) * ch;

  // Pull smooth trajectory gently toward raw camera if nearing crop boundaries
  const maxCropRatio = state.enabled ? state.cropPercent : 0;
  const maxShiftX = cw * (maxCropRatio * 0.48);
  const maxShiftY = ch * (maxCropRatio * 0.48);

  if (Math.abs(offsetX) > maxShiftX && maxShiftX > 0) {
    const sign = Math.sign(offsetX);
    offsetX = sign * maxShiftX;
    state.smoothX = state.camX + offsetX / cw;
  }
  if (Math.abs(offsetY) > maxShiftY && maxShiftY > 0) {
    const sign = Math.sign(offsetY);
    offsetY = sign * maxShiftY;
    state.smoothY = state.camY + offsetY / ch;
  }

  // Smooth roll angle for Horizon Lock
  state.smoothRollRad = state.smoothRollRad * 0.82 + state.rawRollRad * 0.18;
  const activeRoll = (state.enabled && state.useHorizonLock) ? -state.smoothRollRad : 0;

  // 2. Render stabilized & zoomed frame onto steadyCanvas
  ctx.save();
  if (state.activeFilter && state.activeFilter !== 'none') {
    ctx.filter = state.activeFilter;
  }
  ctx.translate(cw / 2 + (state.enabled ? offsetX : 0), ch / 2 + (state.enabled ? offsetY : 0));
  if (activeRoll !== 0) {
    ctx.rotate(activeRoll);
  }

  // Scale up by (1 + cropPercent) so borders never show black edges during shifts/rotation
  const zoomScale = state.enabled ? (1 + state.cropPercent) : 1.0;
  const drawW = cw * zoomScale;
  const drawH = ch * zoomScale;

  ctx.drawImage(rawVideo, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Optional: Draw raw unstabilized PIP preview for side-by-side comparison
  if (showPip) {
    rawPreviewCtx.drawImage(rawVideo, 0, 0, rawPreviewCanvas.width, rawPreviewCanvas.height);
  }

  // 3. Update Telemetry UI
  const shakeMagPx = Math.round(Math.hypot(offsetX, offsetY));
  shakePxText.textContent = `${shakeMagPx} px`;
  const meterPct = Math.min(100, Math.round((shakeMagPx / Math.max(1, maxShiftX)) * 100));
  shakeMeterFill.style.width = `${Math.max(6, meterPct)}%`;

  const deg = (state.smoothRollRad * (180 / Math.PI)).toFixed(1);
  rollAngleText.textContent = `${deg}°`;
  horizonLine.style.transform = `rotate(${-deg}deg)`;

  // FPS counter
  frameCount++;
  if (now - lastFpsTime >= 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    hudFpsBadge.textContent = `${fps} FPS`;
    frameCount = 0;
    lastFpsTime = now;
  }
}

// Video Recording directly from the Stabilized Canvas Stream
function toggleRecording() {
  const btnRecord = document.getElementById('btnRecord');
  const recIndicator = document.getElementById('recIndicator');
  const recTimerText = document.getElementById('recTimerText');
  const saveModal = document.getElementById('saveModal');
  const modalPreviewVideo = document.getElementById('modalPreviewVideo');
  const btnDownloadFile = document.getElementById('btnDownloadFile');
  const btnCloseModal = document.getElementById('btnCloseModal');

  if (!isRecording) {
    recordedChunks = [];
    const canvasStream = steadyCanvas.captureStream(30); // 30fps is rock solid for mobile encoder

    // Strict Android-friendly codec fallback
    const mimeTypes = [
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=avc1',
      'video/mp4'
    ];
    let selectedMime = '';
    for (const m of mimeTypes) {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(m)) {
        selectedMime = m;
        break;
      }
    }

    try {
      mediaRecorder = new MediaRecorder(canvasStream, {
        mimeType: selectedMime || undefined,
        videoBitsPerSecond: Math.min(state.videoBitrate, 15000000)
      });
    } catch (e) {
      try {
        mediaRecorder = new MediaRecorder(canvasStream);
      } catch (err) {
        showToast('มือถือไม่รองรับ MediaRecorder สำหรับการอัดวิดีโอ');
        return;
      }
    }

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        recordedChunks.push(ev.data);
      }
    };

    mediaRecorder.onstop = () => {
      const mime = selectedMime || 'video/webm';
      const isMp4 = mime.includes('mp4');
      const ext = isMp4 ? 'mp4' : 'webm';
      const blob = new Blob(recordedChunks, { type: mime });

      if (blob.size === 0) {
        showToast('เกิดข้อผิดพลาด: ไฟล์วิดีโอมีขนาด 0 byte');
        return;
      }

      const url = URL.createObjectURL(blob);
      const filename = `UltraSteady_${Date.now()}.${ext}`;

      // 1. Setup Save Dialog Modal
      modalPreviewVideo.src = url;
      btnDownloadFile.href = url;
      btnDownloadFile.download = filename;
      saveModal.classList.remove('hidden');

      // 2. Also try direct automatic download trigger
      try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
      } catch (e) {}

      showToast(`อัดเสร็จแล้ว (${(blob.size / (1024 * 1024)).toFixed(1)} MB) กดบันทึกลงเครื่องได้เลย!`, 3500);
    };

    btnCloseModal.onclick = () => {
      saveModal.classList.add('hidden');
      modalPreviewVideo.pause();
      modalPreviewVideo.src = '';
    };

    mediaRecorder.start(500); // chunk every 500ms
    isRecording = true;
    btnRecord.classList.add('recording');
    recIndicator.classList.remove('hidden');
    recStartTime = Date.now();
    recTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - recStartTime) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      recTimerText.textContent = `${mm}:${ss}`;
    }, 500);
    showToast('กำลังบันทึกวิดีโอกันสั่น...');
  } else {
    try {
      mediaRecorder.stop();
    } catch (e) {}
    isRecording = false;
    btnRecord.classList.remove('recording');
    recIndicator.classList.add('hidden');
    clearInterval(recTimerInterval);
  }
}

// High-Resolution Stabilized Photo Snapshot
function takeSnapshot() {
  steadyCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `UltraSteady_Photo_${timestamp}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('📸 บันทึกภาพนิ่งคมชัดสูงแล้ว!');
  }, 'image/jpeg', 0.96);
}

// Wire UI Events
function initUI() {
  // Preset buttons
  document.querySelectorAll('.preset-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = btn.dataset.preset;

      if (preset === 'standard') {
        state.enabled = true;
        state.cropPercent = 0.15;
        state.smoothness = 0.80;
        hudModeBadge.textContent = 'STANDARD 15%';
      } else if (preset === 'ultra') {
        state.enabled = true;
        state.cropPercent = 0.28;
        state.smoothness = 0.88;
        hudModeBadge.textContent = 'SUPER ULTRA';
      } else if (preset === 'gimbal') {
        state.enabled = true;
        state.cropPercent = 0.38;
        state.smoothness = 0.95;
        state.useHorizonLock = true;
        chkHorizonLock.checked = true;
        hudModeBadge.textContent = 'GIMBAL LOCK';
      } else if (preset === 'off') {
        state.enabled = false;
        hudModeBadge.textContent = 'RAW (ปิดกันสั่น)';
      }

      sliderCrop.value = Math.round(state.cropPercent * 100);
      valCrop.textContent = `${sliderCrop.value}%`;
      sliderSmooth.value = Math.round(state.smoothness * 100);
      valSmooth.textContent = `${sliderSmooth.value}%`;
    });
  });

  // Panel tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // Stabilization Sliders
  sliderSmooth.addEventListener('input', () => {
    state.smoothness = Number(sliderSmooth.value) / 100;
    valSmooth.textContent = `${sliderSmooth.value}%`;
  });

  sliderCrop.addEventListener('input', () => {
    state.cropPercent = Number(sliderCrop.value) / 100;
    valCrop.textContent = `${sliderCrop.value}%`;
  });

  chkOpticalFlow.addEventListener('change', () => {
    state.useOpticalFlow = chkOpticalFlow.checked;
  });

  chkHorizonLock.addEventListener('change', () => {
    state.useHorizonLock = chkHorizonLock.checked;
  });

  // Clarity & Sharpness Sliders
  sliderSharpness.addEventListener('input', () => {
    state.sharpness = Number(sliderSharpness.value);
    valSharpness.textContent = `${state.sharpness}%`;
    updateGpuFilters();
  });

  sliderClarity.addEventListener('input', () => {
    state.clarity = Number(sliderClarity.value);
    valClarity.textContent = `${state.clarity}%`;
    updateGpuFilters();
  });

  selectRes.addEventListener('change', () => {
    state.targetResHeight = Number(selectRes.value);
    startCamera();
  });

  selectBitrate.addEventListener('change', () => {
    state.videoBitrate = Number(selectBitrate.value);
    showToast(`ตั้งค่าบิตเรตวิดีโอ: ${state.videoBitrate / 1000000} Mbps`);
  });

  chkAntiBlur.addEventListener('change', () => {
    state.antiBlurShutter = chkAntiBlur.checked;
    applyHardwareEnhancements();
    updateGpuFilters();
  });

  // Top Bar Actions
  document.getElementById('btnCompare').addEventListener('click', (e) => {
    showPip = !showPip;
    pipRawBox.classList.toggle('hidden', !showPip);
    e.currentTarget.classList.toggle('active', showPip);
  });

  document.getElementById('btnTorch').addEventListener('click', async (e) => {
    if (!currentStream) return;
    const track = currentStream.getVideoTracks()[0];
    try {
      torchOn = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      e.currentTarget.classList.toggle('active', torchOn);
    } catch (err) {
      torchOn = false;
      showToast('กล้องตัวนี้ไม่รองรับการเปิดไฟฉายขณะถ่าย');
    }
  });

  document.getElementById('btnSwitchCam').addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  // Bottom Bar Actions
  document.getElementById('btnRecord').addEventListener('click', toggleRecording);
  document.getElementById('btnSnapPhoto').addEventListener('click', takeSnapshot);
  document.getElementById('btnRecenter').addEventListener('click', () => {
    state.smoothX = state.camX;
    state.smoothY = state.camY;
    state.smoothRollRad = 0;
    showToast('🎯 รีเซ็ตจุดศูนย์กลางภาพแล้ว');
  });
}

// Register Offline Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Boot Application
window.addEventListener('DOMContentLoaded', () => {
  initUI();
  startCamera();
  requestAnimationFrame(renderLoop);
});
