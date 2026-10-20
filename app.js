// UltraSteady Pro Cam - Clean, Solid & Zero-Lag Core Engine
const rawVideo = document.getElementById('rawVideo');
const steadyCanvas = document.getElementById('steadyCanvas');
const ctx = steadyCanvas.getContext('2d', { alpha: false });
const horizonLine = document.querySelector('.horizon-line');
const toastMsg = document.getElementById('toastMsg');

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
  smoothness: 0.82,       // Stronger damping
  cropPercent: 0.35,      // Big 35% margin for Super Steady action
  useHorizonLock: true,
  targetResHeight: 720,
  videoBitrate: 8000000,

  // Gyroscope Angles
  gyroPitch: 0,
  gyroRoll: 0,
  smoothGyroPitch: 0,
  smoothGyroRoll: 0,

  // Displacement
  velX: 0,
  velY: 0,
  offsetX: 0,
  offsetY: 0,

  rawRollRad: 0,
  smoothRollRad: 0
};

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

// 1. Robust Start Camera (Globally available on window)
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

  // Fallback 1: Ideal rear camera
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (e1) {
    lastError = e1;
    // Fallback 2: Any back camera
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode },
        audio: false
      });
    } catch (e2) {
      lastError = e2;
      // Fallback 3: Standard camera
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e3) {
        lastError = e3;
      }
    }
  }

  if (!stream) {
    const msg = (lastError && lastError.name === 'NotAllowedError')
      ? '⚠️ คุณปฏิเสธสิทธิ์การใช้กล้อง: กรุณาแตะที่ไอคอนกุญแจ 🔒 ที่แถบ URL ด้านบนเพื่อกดอนุญาต'
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

  // Force Continuous Autofocus
  const track = stream.getVideoTracks()[0];
  if (track && track.applyConstraints) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous', whiteBalanceMode: 'continuous' }]
      });
    } catch (e) {}
  }

  showToast(`เปิดกล้องสำเร็จ (${vw}×${vh})`);
};

// Listen to Gyroscope Orientation for Smooth Camera Pitch & Roll
window.addEventListener('deviceorientation', (e) => {
  if (!state.enabled) return;
  if (e.beta !== null && e.gamma !== null) {
    const p = (e.beta - 60) * (Math.PI / 180);
    const r = e.gamma * (Math.PI / 180);

    // Deadzone filter for Gyro: Ignore micro sensor jitter (< 0.015 rad ~ 0.8 deg)
    if (Math.abs(p - state.gyroPitch) > 0.015) {
      state.gyroPitch = p;
    }
    if (Math.abs(r - state.gyroRoll) > 0.015) {
      state.gyroRoll = r;
    }
  }
}, { passive: true });

// 2. Accelerometer Shake & Horizon Lock Sensor
window.addEventListener('devicemotion', (e) => {
  if (!state.enabled) return;

  const ag = e.accelerationIncludingGravity;
  const lin = e.acceleration;

  if (ag && ag.x !== null && ag.y !== null) {
    const roll = Math.atan2(ag.x, ag.y);
    if (Math.abs(roll) < 0.75) {
      // Deadzone for horizon roll jitter
      if (Math.abs(roll - state.rawRollRad) > 0.01) {
        state.rawRollRad = roll;
      }
    }
  }

  if (lin && lin.x !== null && lin.y !== null) {
    const ax = lin.x || 0;
    const ay = lin.y || 0;
    const mag = Math.hypot(ax, ay);

    // Deadzone: Ignore micro sensor noise when holding still (< 0.4 m/s^2)
    if (mag < 0.4) {
      return;
    }

    if (mag > 12) {
      state.velX *= 0.2;
      state.velY *= 0.2;
      state.offsetX *= 0.3;
      state.offsetY *= 0.3;
    } else {
      state.velX += ax * 0.006;
      state.velY += -ay * 0.006;
    }
  }
}, { passive: true });

// 3. Stabilization Render Loop (60 FPS)
function renderLoop() {
  requestAnimationFrame(renderLoop);

  if (rawVideo.readyState < 2 || !steadyCanvas.width) return;

  const cw = steadyCanvas.width;
  const ch = steadyCanvas.height;

  // 1. Gyro low-pass smoothing (gentle response)
  state.smoothGyroPitch = state.smoothGyroPitch * 0.94 + state.gyroPitch * 0.06;
  state.smoothGyroRoll = state.smoothGyroRoll * 0.94 + state.gyroRoll * 0.06;

  // Angular displacement in pixels with deadband
  let gyroShiftY = (state.smoothGyroPitch - state.gyroPitch) * ch * 0.45;
  let gyroShiftX = (state.smoothGyroRoll - state.gyroRoll) * cw * 0.45;

  if (Math.abs(gyroShiftX) < 1.5) gyroShiftX = 0;
  if (Math.abs(gyroShiftY) < 1.5) gyroShiftY = 0;

  if (state.enabled) {
    state.velX -= state.offsetX * 0.18;
    state.velY -= state.offsetY * 0.18;

    state.velX *= state.smoothness;
    state.velY *= state.smoothness;

    state.offsetX += state.velX;
    state.offsetY += state.velY;

    // Zero out sub-pixel jitter
    if (Math.abs(state.offsetX) < 1.0) state.offsetX = 0;
    if (Math.abs(state.offsetY) < 1.0) state.offsetY = 0;

    const maxShiftX = cw * (state.cropPercent * 0.45);
    const maxShiftY = ch * (state.cropPercent * 0.45);
    state.offsetX = Math.max(-maxShiftX, Math.min(maxShiftX, state.offsetX + gyroShiftX));
    state.offsetY = Math.max(-maxShiftY, Math.min(maxShiftY, state.offsetY + gyroShiftY));
  } else {
    state.offsetX = 0;
    state.offsetY = 0;
  }

  state.smoothRollRad = state.smoothRollRad * 0.85 + state.rawRollRad * 0.15;
  const activeRoll = (state.enabled && state.useHorizonLock) ? -state.smoothRollRad : 0;

  ctx.save();
  ctx.translate(cw / 2 - state.offsetX, ch / 2 - state.offsetY);
  if (activeRoll !== 0) {
    ctx.rotate(activeRoll);
  }

  const totalScale = (state.enabled ? (1 + state.cropPercent) : 1.0) * currentZoom;
  const drawW = cw * totalScale;
  const drawH = ch * totalScale;

  ctx.drawImage(rawVideo, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

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
      const filename = `UltraSteady_${Date.now()}.${ext}`;

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
    showToast('กำลังบันทึกวิดีโอกันสั่น...');
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
    a.download = `UltraSteady_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('📸 บันทึกภาพนิ่งแล้ว!');
  }, 'image/jpeg', 0.95);
}

// 6. UI Initializer
function initUI() {
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
      // Ignore if clicking buttons or overlays
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

      // Re-trigger Continuous Focus via Hardware Track Constraints
      if (currentStream) {
        const track = currentStream.getVideoTracks()[0];
        if (track && track.applyConstraints) {
          try {
            await track.applyConstraints({
              advanced: [{ focusMode: 'continuous' }]
            });
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
      state.offsetX = 0;
      state.offsetY = 0;
      state.velX = 0;
      state.velY = 0;
      state.smoothRollRad = 0;
      showToast('🎯 รีเซ็ตระนาบศูนย์กลาง');
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
        state.cropPercent = 0.12;
        state.smoothness = 0.65;
        if (hudModeBadge) hudModeBadge.textContent = 'STANDARD';
      } else if (preset === 'ultra') {
        state.enabled = true;
        state.cropPercent = 0.20;
        state.smoothness = 0.72;
        if (hudModeBadge) hudModeBadge.textContent = 'ULTRA STEADY';
      } else if (preset === 'gimbal') {
        state.enabled = true;
        state.cropPercent = 0.32;
        state.smoothness = 0.82;
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
