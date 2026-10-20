// UltraSteady Pro Cam V3 - Web Worker + Computer Vision Engine
const rawVideo = document.getElementById('rawVideo');
const steadyCanvas = document.getElementById('steadyCanvas');
const ctx = steadyCanvas.getContext('2d', { alpha: false });
const horizonLine = document.querySelector('.horizon-line');
const toastMsg = document.getElementById('toastMsg');

// Offscreen buffer for Web Worker
const WORKER_SIZE = 80;
const offCanvas = document.createElement('canvas');
offCanvas.width = WORKER_SIZE;
offCanvas.height = WORKER_SIZE;
const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

let stabilizerWorker = null;
let isWorkerBusy = false;

let currentStream = null;
let facingMode = 'environment';
let torchOn = false;
let currentZoom = 1.0;
let pinchStartDist = 0;
let pinchStartZoom = 1.0;

// Recording state
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recStartTime = 0;
let recTimerInterval = null;

// Stabilization State
const state = {
  enabled: true,
  smoothness: 0.85,
  cropPercent: 0.32,
  useHorizonLock: true,
  targetResHeight: 720,
  videoBitrate: 8000000,

  // Worker Offsets
  workerOffsetX: 0,
  workerOffsetY: 0,
  smoothOffsetX: 0,
  smoothOffsetY: 0,

  // Gyro / Horizon
  rawRollRad: 0,
  smoothRollRad: 0
};

// Initialize Web Worker
function initWorker() {
  try {
    stabilizerWorker = new Worker('./stabilizer.worker.js');
    stabilizerWorker.onmessage = function (e) {
      isWorkerBusy = false;
      if (e.data.type === 'MOTION_RESULT') {
        state.workerOffsetX = e.data.offsetX;
        state.workerOffsetY = e.data.offsetY;
      }
    };
  } catch (err) {
    console.warn('Web Worker fallback to local mode:', err);
  }
}

// Toast helper
function showToast(text, duration = 2000) {
  if (!toastMsg) return;
  toastMsg.textContent = text;
  toastMsg.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastMsg.classList.add('hidden');
  }, duration);
}

// 1. Robust Start Camera with MediaDevices API
window.startCamera = async function () {
  const permOverlay = document.getElementById('permissionOverlay');
  const btnStartCamera = document.getElementById('btnStartCamera');
  const permErrorMsg = document.getElementById('permErrorMsg');

  if (btnStartCamera) {
    btnStartCamera.textContent = 'กำลังเปิดกล้อง... ⏳';
    btnStartCamera.disabled = true;
  }
  if (permErrorMsg) {
    permErrorMsg.style.display = 'none';
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = 'เบราว์เซอร์ไม่รองรับกล้อง หรือเว็บไม่ได้รันบน HTTPS';
    if (permErrorMsg) {
      permErrorMsg.textContent = err;
      permErrorMsg.style.display = 'block';
    }
    alert(err);
    if (btnStartCamera) {
      btnStartCamera.textContent = 'เปิดใช้งานกล้อง (Start Camera)';
      btnStartCamera.disabled = false;
    }
    return;
  }

  if (currentStream) {
    try {
      currentStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
  }

  let stream = null;
  let lastError = null;

  // MediaDevices advanced constraints
  const configs = [
    {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 30 }
      },
      audio: false
    },
    { video: { facingMode: facingMode }, audio: false },
    { video: true, audio: false }
  ];

  for (const cfg of configs) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(cfg);
      if (stream) break;
    } catch (e) {
      lastError = e;
    }
  }

  if (!stream) {
    const msg = (lastError && lastError.name === 'NotAllowedError')
      ? '⚠️ กรุณาแตะไอคอนกุญแจ 🔒 ที่แถบ URL ด้านบนเพื่อกดอนุญาตให้ใช้กล้อง'
      : '⚠️ ไม่สามารถเปิดกล้องได้: ' + (lastError ? lastError.message : 'กรุณาตรวจสอบสิทธิ์กล้อง');

    if (permErrorMsg) {
      permErrorMsg.textContent = msg;
      permErrorMsg.style.display = 'block';
    }
    if (btnStartCamera) {
      btnStartCamera.textContent = 'ลองเปิดกล้องอีกครั้ง 🔄';
      btnStartCamera.disabled = false;
    }
    return;
  }

  currentStream = stream;
  rawVideo.srcObject = stream;

  try {
    await rawVideo.play();
  } catch (err) {}

  const vw = rawVideo.videoWidth || 1280;
  const vh = rawVideo.videoHeight || 720;
  steadyCanvas.width = vw;
  steadyCanvas.height = vh;

  if (permOverlay) {
    permOverlay.classList.add('hidden');
  }

  // Force Hardware Continuous Focus
  const track = stream.getVideoTracks()[0];
  if (track && track.applyConstraints) {
    try {
      await track.applyConstraints({
        advanced: [
          { focusMode: 'continuous' },
          { whiteBalanceMode: 'continuous' }
        ]
      });
    } catch (e) {}
  }

  showToast(`เปิดกล้อง V3 สำเร็จ (${vw}×${vh})`);
};

// 2. Horizon Angle Sensor (Rock-Solid Low-Pass Filter)
window.addEventListener('devicemotion', (e) => {
  if (!state.enabled || !state.useHorizonLock) return;
  const ag = e.accelerationIncludingGravity;
  if (ag && ag.x !== null && ag.y !== null) {
    const roll = Math.atan2(ag.x, ag.y);
    // Only respond to intentional tilt within +-35 deg, ignore tiny shakes
    if (Math.abs(roll) < 0.6) {
      if (Math.abs(roll - state.rawRollRad) > 0.035) { // 2 degrees deadband
        state.rawRollRad = roll;
      }
    }
  }
}, { passive: true });

// 3. Stabilization Render Loop (60 FPS on Main Thread)
let frameCounter = 0;

function renderLoop() {
  requestAnimationFrame(renderLoop);

  if (rawVideo.readyState < 2 || !steadyCanvas.width) return;

  const cw = steadyCanvas.width;
  const ch = steadyCanvas.height;

  // Send frame to Web Worker (every 3rd frame to avoid over-correcting)
  frameCounter++;
  if (state.enabled && stabilizerWorker && !isWorkerBusy && frameCounter % 3 === 0) {
    offCtx.drawImage(rawVideo, 0, 0, WORKER_SIZE, WORKER_SIZE);
    const imgData = offCtx.getImageData(0, 0, WORKER_SIZE, WORKER_SIZE);
    const grayBuffer = new Uint8Array(WORKER_SIZE * WORKER_SIZE);

    for (let i = 0, j = 0; i < imgData.data.length; i += 4, j++) {
      grayBuffer[j] = (imgData.data[i] * 2 + imgData.data[i + 1] * 5 + imgData.data[i + 2]) >> 3;
    }

    isWorkerBusy = true;
    stabilizerWorker.postMessage({
      type: 'PROCESS_FRAME',
      width: WORKER_SIZE,
      height: WORKER_SIZE,
      smoothness: state.smoothness,
      buffer: grayBuffer.buffer
    }, [grayBuffer.buffer]);
  }

  // Smooth interpolation of worker offset
  if (state.enabled) {
    state.smoothOffsetX = state.smoothOffsetX * 0.88 + state.workerOffsetX * 0.12;
    state.smoothOffsetY = state.smoothOffsetY * 0.88 + state.workerOffsetY * 0.12;

    // Decay to center if worker offset is near zero
    if (Math.abs(state.smoothOffsetX) < 0.001) state.smoothOffsetX = 0;
    if (Math.abs(state.smoothOffsetY) < 0.001) state.smoothOffsetY = 0;
  } else {
    state.smoothOffsetX = 0;
    state.smoothOffsetY = 0;
  }

  // Ultra-Smooth Horizon Lock (96% heavy damping so it NEVER wobbles)
  state.smoothRollRad = state.smoothRollRad * 0.96 + state.rawRollRad * 0.04;
  if (Math.abs(state.smoothRollRad) < 0.008) state.smoothRollRad = 0;
  const activeRoll = (state.enabled && state.useHorizonLock) ? -state.smoothRollRad : 0;

  // Render to canvas
  ctx.save();
  const shiftPxX = state.smoothOffsetX * cw;
  const shiftPxY = state.smoothOffsetY * ch;

  ctx.translate(cw / 2 + shiftPxX, ch / 2 + shiftPxY);
  if (activeRoll !== 0) {
    ctx.rotate(activeRoll);
  }

  const totalScale = (state.enabled ? (1 + state.cropPercent) : 1.0) * currentZoom;
  const drawW = cw * totalScale;
  const drawH = ch * totalScale;

  ctx.drawImage(rawVideo, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Horizon line
  if (horizonLine) {
    const deg = (state.smoothRollRad * (180 / Math.PI)).toFixed(1);
    horizonLine.style.transform = `rotate(${-deg}deg)`;
  }
}

// 4. Video Recording
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
    const canvasStream = steadyCanvas.captureStream(30);

    const mimeTypes = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    let selectedMime = '';
    for (const m of mimeTypes) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
        selectedMime = m;
        break;
      }
    }

    try {
      mediaRecorder = new MediaRecorder(canvasStream, {
        mimeType: selectedMime || undefined,
        videoBitsPerSecond: state.videoBitrate
      });
    } catch (e) {
      try {
        mediaRecorder = new MediaRecorder(canvasStream);
      } catch (err) {
        showToast('เครื่องนี้ไม่รองรับการบันทึกวิดีโอบนเว็บ');
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
      const filename = `UltraSteady_V3_${Date.now()}.${ext}`;

      if (modalPreviewVideo) modalPreviewVideo.src = url;
      if (btnDownloadFile) {
        btnDownloadFile.href = url;
        btnDownloadFile.download = filename;
      }
      if (saveModal) saveModal.classList.remove('hidden');

      showToast(`อัดเสร็จแล้ว (${(blob.size / (1024 * 1024)).toFixed(1)} MB)`);
    };

    if (btnCloseModal && saveModal) {
      btnCloseModal.onclick = () => {
        saveModal.classList.add('hidden');
        if (modalPreviewVideo) {
          modalPreviewVideo.pause();
          modalPreviewVideo.src = '';
        }
      };
    }

    mediaRecorder.start(500);
    isRecording = true;
    if (btnRecord) btnRecord.classList.add('recording');
    if (recIndicator) recIndicator.classList.remove('hidden');
    recStartTime = Date.now();
    recTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - recStartTime) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      if (recTimerText) recTimerText.textContent = `${mm}:${ss}`;
    }, 500);
    showToast('กำลังบันทึกวิดีโอกันสั่น V3...');
  } else {
    try {
      mediaRecorder.stop();
    } catch (e) {}
    isRecording = false;
    if (btnRecord) btnRecord.classList.remove('recording');
    if (recIndicator) recIndicator.classList.add('hidden');
    clearInterval(recTimerInterval);
  }
}

// 5. Snapshot Photo
function takeSnapshot() {
  steadyCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `UltraSteady_V3_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('📸 บันทึกภาพนิ่งแล้ว!');
  }, 'image/jpeg', 0.95);
}

// 6. UI Initializer
function initUI() {
  initWorker();

  // Zoom Buttons
  document.querySelectorAll('.zoom-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.zoom-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentZoom = parseFloat(btn.dataset.zoom) || 1.0;
      showToast(`ซูม: ${currentZoom}x`, 1000);
    });
  });

  // Touch Pinch Zoom
  const cameraRoot = document.getElementById('cameraRoot');
  if (cameraRoot) {
    cameraRoot.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        pinchStartZoom = currentZoom;
      }
    }, { passive: true });

    cameraRoot.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const scale = dist / pinchStartDist;
        currentZoom = Math.max(1.0, Math.min(3.0, +(pinchStartZoom * scale).toFixed(1)));
        document.querySelectorAll('.zoom-chip').forEach((b) => {
          b.classList.toggle('active', parseFloat(b.dataset.zoom) === currentZoom);
        });
      }
    }, { passive: true });
  }

  // Tap to Focus Reticle on Screen
  const focusBox = document.getElementById('focusBox');
  if (cameraRoot && focusBox) {
    cameraRoot.addEventListener('click', async (e) => {
      if (e.target.closest('button') || e.target.closest('.settings-modal-overlay') || e.target.closest('.permission-overlay')) return;

      const rect = cameraRoot.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      focusBox.style.left = `${x}px`;
      focusBox.style.top = `${y}px`;
      focusBox.classList.remove('hidden');
      focusBox.classList.add('active');

      clearTimeout(focusBox._timer);
      focusBox._timer = setTimeout(() => {
        focusBox.classList.remove('active');
        setTimeout(() => focusBox.classList.add('hidden'), 200);
      }, 1200);

      // Trigger Continuous Autofocus Re-engage
      if (currentStream) {
        const track = currentStream.getVideoTracks()[0];
        if (track && track.applyConstraints) {
          try {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          } catch (err) {}
        }
      }
    });
  }

  // Buttons
  const btnRecord = document.getElementById('btnRecord');
  if (btnRecord) btnRecord.addEventListener('click', toggleRecording);

  const btnSnapPhoto = document.getElementById('btnSnapPhoto');
  if (btnSnapPhoto) btnSnapPhoto.addEventListener('click', takeSnapshot);

  const btnRecenter = document.getElementById('btnRecenter');
  if (btnRecenter) {
    btnRecenter.addEventListener('click', () => {
      if (stabilizerWorker) {
        stabilizerWorker.postMessage({ type: 'RESET' });
      }
      state.workerOffsetX = 0;
      state.workerOffsetY = 0;
      state.smoothOffsetX = 0;
      state.smoothOffsetY = 0;
      state.smoothRollRad = 0;
      showToast('🎯 รีเซ็ตศูนย์กลางเรียบร้อย');
    });
  }

  // Switch camera
  const btnSwitchCam = document.getElementById('btnSwitchCam');
  if (btnSwitchCam) {
    btnSwitchCam.addEventListener('click', () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      window.startCamera();
    });
  }

  // Torch
  const btnTorch = document.getElementById('btnTorch');
  if (btnTorch) {
    btnTorch.addEventListener('click', async () => {
      if (!currentStream) return;
      const track = currentStream.getVideoTracks()[0];
      try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      } catch (err) {
        torchOn = false;
        showToast('ไม่สามารถเปิดไฟฉายได้');
      }
    });
  }

  // Settings Modal
  const settingsModal = document.getElementById('settingsModal');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');

  if (btnOpenSettings && settingsModal) {
    btnOpenSettings.addEventListener('click', () => settingsModal.classList.remove('hidden'));
  }
  if (btnCloseSettings && settingsModal) {
    btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  }

  // Mode buttons inside settings
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = btn.dataset.preset;
      const hudModeBadge = document.getElementById('hudModeBadge');

      if (preset === 'standard') {
        state.enabled = true;
        state.cropPercent = 0.15;
        state.smoothness = 0.75;
        if (hudModeBadge) hudModeBadge.textContent = 'STANDARD';
      } else if (preset === 'ultra') {
        state.enabled = true;
        state.cropPercent = 0.32;
        state.smoothness = 0.85;
        if (hudModeBadge) hudModeBadge.textContent = 'ULTRA STEADY';
      } else if (preset === 'gimbal') {
        state.enabled = true;
        state.cropPercent = 0.42;
        state.smoothness = 0.92;
        if (hudModeBadge) hudModeBadge.textContent = 'GIMBAL LOCK';
      } else if (preset === 'off') {
        state.enabled = false;
        if (hudModeBadge) hudModeBadge.textContent = 'RAW';
      }
    });
  });

  const sliderSmooth = document.getElementById('sliderSmooth');
  const valSmooth = document.getElementById('valSmooth');
  if (sliderSmooth) {
    sliderSmooth.addEventListener('input', () => {
      state.smoothness = Number(sliderSmooth.value) / 100;
      if (valSmooth) valSmooth.textContent = `${sliderSmooth.value}%`;
    });
  }

  const chkHorizonLock = document.getElementById('chkHorizonLock');
  if (chkHorizonLock) {
    chkHorizonLock.addEventListener('change', () => {
      state.useHorizonLock = chkHorizonLock.checked;
    });
  }
}

// Service Worker (Offline Support)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Start rendering
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  requestAnimationFrame(renderLoop);
});
