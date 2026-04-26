(() => {
  'use strict';

  // ── DOM Elements ──────────────────────────────────────────
  const uploadBtn = document.getElementById('upload-btn');
  const uploadText = document.getElementById('upload-text');
  const uploadInput = document.getElementById('audio-upload');
  const uploadZone = document.getElementById('upload-zone');
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const timeDisplay = document.getElementById('time-display');
  const progressContainer = document.getElementById('progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressInput = document.getElementById('progress-input');
  const toggleIndicator = document.getElementById('toggle-indicator');
  const vizPlaceholder = document.getElementById('viz-placeholder');
  const canvasWrapper = document.getElementById('canvas-wrapper');
  const spectrogramCanvas = document.getElementById('spectrogram-canvas');
  const axisCanvas = document.getElementById('axis-canvas');
  const scaleRadios = document.querySelectorAll('input[name="scale"]');
  const themeToggle = document.getElementById('theme-toggle');

  // ── State ─────────────────────────────────────────────────
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let audioBuffer = null;
  let isPlaying = false;
  let startTime = 0;
  let pauseOffset = 0;
  let logScale = false;
  let animFrameId = null;

  const FFT_SIZE = 2048;
  const AXIS_LEFT = 60;
  const AXIS_BOTTOM = 36;

  // ── Color Map (exact palette from reference) ──────────────
  // Maps byte value 0-255 to RGB using the reference's colorPalette
  const colorMap = buildColorMap();

  function buildColorMap() {
    // These are the exact stops from the reference getFullColor()
    // mapped at 0%, 10%, 20%, ... 100% of value range
    const palette = [
      [0,   0,   0  ],  //   0% — black
      [75,  0,   159],  //  10% — purple
      [104, 0,   251],  //  20% — blue-purple
      [131, 0,   255],  //  30% — violet-blue
      [155, 18,  157],  //  40% — purple-red
      [175, 37,  0  ],  //  50% — dark brown
      [191, 59,  0  ],  //  60% — dark orange
      [206, 88,  0  ],  //  70% — orange
      [223, 132, 0  ],  //  80% — amber
      [240, 188, 0  ],  //  90% — yellow-orange
      [255, 252, 0  ],  // 100% — bright yellow
    ];
    const map = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      // Map 0-255 to 0-100%, then pick the palette stop
      const pct = (i / 255) * 100;
      const stopIdx = Math.min(Math.floor(pct / 10), 9);
      const frac = (pct - stopIdx * 10) / 10;
      const a = palette[stopIdx];
      const b = palette[stopIdx + 1];
      map[i * 3]     = Math.round(a[0] + (b[0] - a[0]) * frac);
      map[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
      map[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
    }
    return map;
  }

  // ── Theme ──────────────────────────────────────────────────
  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function getCanvasBg() {
    return isDark() ? '#050508' : '#0d0d14';
  }

  function getAxisTextColor() {
    return isDark() ? '#5e5e78' : '#666680';
  }

  function getAxisGridColor() {
    return isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
  }

  function getAxisBorderColor() {
    return isDark() ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  }

  themeToggle.addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    drawAxes();
  });

  // ── Upload Handling ───────────────────────────────────────
  uploadBtn.addEventListener('click', () => uploadInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  uploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  async function handleFile(file) {
    stopPlayback();

    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    uploadText.textContent = file.name;
    uploadBtn.classList.add('has-file');

    try {
      const arrayBuffer = await file.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      playBtn.disabled = false;
      stopBtn.disabled = false;
      progressContainer.classList.remove('hidden');
      vizPlaceholder.classList.add('hidden');
      canvasWrapper.classList.remove('hidden');

      resizeCanvases();
      clearSpectrogram();
      drawAxes();
      updateTimeDisplay(0, audioBuffer.duration);
    } catch (err) {
      uploadText.textContent = 'Error decoding file';
      uploadBtn.classList.remove('has-file');
      console.error(err);
    }
  }

  // ── Playback ──────────────────────────────────────────────
  playBtn.addEventListener('click', () => {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  });

  stopBtn.addEventListener('click', () => {
    stopPlayback();
  });

  function startPlayback() {
    if (!audioBuffer || !audioCtx) return;

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    sourceNode.onended = () => {
      if (isPlaying) {
        stopPlayback();
      }
    };

    startTime = audioCtx.currentTime - pauseOffset;
    sourceNode.start(0, pauseOffset);
    isPlaying = true;

    playBtn.classList.add('playing');
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');

    clearSpectrogram();
    drawLoop();
  }

  function pausePlayback() {
    if (!isPlaying) return;

    pauseOffset = audioCtx.currentTime - startTime;
    sourceNode.stop();
    sourceNode.disconnect();
    isPlaying = false;

    playBtn.classList.remove('playing');
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  function stopPlayback() {
    if (sourceNode && isPlaying) {
      sourceNode.stop();
      sourceNode.disconnect();
    }
    isPlaying = false;
    pauseOffset = 0;

    playBtn.classList.remove('playing');
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    if (audioBuffer) {
      updateTimeDisplay(0, audioBuffer.duration);
      progressFill.style.width = '0%';
      progressInput.value = 0;
    }
  }

  // ── Progress Bar ──────────────────────────────────────────
  progressInput.addEventListener('input', (e) => {
    if (!audioBuffer) return;
    const pct = parseFloat(e.target.value);
    const seekTime = (pct / 100) * audioBuffer.duration;

    const wasPlaying = isPlaying;
    if (isPlaying) {
      sourceNode.stop();
      sourceNode.disconnect();
      isPlaying = false;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    }

    pauseOffset = seekTime;

    if (wasPlaying) {
      startPlayback();
    } else {
      updateTimeDisplay(seekTime, audioBuffer.duration);
      progressFill.style.width = pct + '%';
    }
  });

  // ── Scale Toggle ──────────────────────────────────────────
  scaleRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      logScale = radio.value === 'log';
      toggleIndicator.classList.toggle('log', logScale);
      drawAxes();
    });
  });

  // ── Canvas Sizing ─────────────────────────────────────────
  function resizeCanvases() {
    const wrapper = canvasWrapper;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    // Spectrogram canvas: 1:1 pixel mapping (NO DPR scaling)
    // This avoids anti-aliasing artifacts that darken colors
    const plotW = w - AXIS_LEFT;
    const plotH = h - AXIS_BOTTOM;
    spectrogramCanvas.width = plotW;
    spectrogramCanvas.height = plotH;
    spectrogramCanvas.style.width = plotW + 'px';
    spectrogramCanvas.style.height = plotH + 'px';

    // Axis overlay uses DPR for crisp text
    axisCanvas.width = w * dpr;
    axisCanvas.height = h * dpr;
    axisCanvas.style.width = w + 'px';
    axisCanvas.style.height = h + 'px';
  }

  window.addEventListener('resize', () => {
    if (canvasWrapper.classList.contains('hidden')) return;
    resizeCanvases();
    drawAxes();
  });

  // ── Clear Spectrogram ─────────────────────────────────────
  function clearSpectrogram() {
    const ctx = spectrogramCanvas.getContext('2d');
    ctx.fillStyle = getCanvasBg();
    ctx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
  }

  // ── Draw Axes ─────────────────────────────────────────────
  function drawAxes() {
    const ctx = axisCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = axisCanvas.width;
    const h = axisCanvas.height;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = (w / dpr) - AXIS_LEFT;
    const plotH = (h / dpr) - AXIS_BOTTOM;

    if (!audioCtx) return;
    const nyquist = audioCtx.sampleRate / 2;

    // ── Frequency axis (left) ────
    ctx.fillStyle = getAxisTextColor();
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const freqTicks = logScale
      ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f <= nyquist)
      : generateLinearTicks(nyquist);

    ctx.strokeStyle = getAxisGridColor();
    ctx.lineWidth = 1;

    for (const freq of freqTicks) {
      const y = freqToY(freq, plotH, nyquist);
      if (y < 2 || y > plotH - 2) continue;

      const label = freq >= 1000 ? (freq / 1000) + 'k' : freq + '';

      ctx.fillText(label, AXIS_LEFT - 8, y);

      // Grid line
      ctx.beginPath();
      ctx.moveTo(AXIS_LEFT, y);
      ctx.lineTo(AXIS_LEFT + plotW, y);
      ctx.stroke();
    }

    // Axis label
    ctx.save();
    ctx.translate(12, plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillStyle = getAxisTextColor();
    ctx.fillText('Frequency (Hz)', 0, 0);
    ctx.restore();

    // ── Time axis (bottom) ────
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillStyle = getAxisTextColor();
    ctx.fillText('Time →', AXIS_LEFT + plotW / 2, plotH + 18);

    // Border
    ctx.strokeStyle = getAxisBorderColor();
    ctx.lineWidth = 1;
    ctx.strokeRect(AXIS_LEFT, 0, plotW, plotH);
  }

  function generateLinearTicks(nyquist) {
    const ticks = [];
    let step = 1000;
    if (nyquist > 30000) step = 5000;
    else if (nyquist > 15000) step = 2000;

    for (let f = 0; f <= nyquist; f += step) {
      if (f === 0) continue;
      ticks.push(f);
    }
    return ticks;
  }

  function freqToY(freq, plotH, nyquist) {
    if (logScale) {
      const minLog = Math.log10(20);
      const maxLog = Math.log10(nyquist);
      const logFreq = Math.log10(Math.max(freq, 20));
      const ratio = (logFreq - minLog) / (maxLog - minLog);
      return plotH - ratio * plotH;
    } else {
      return plotH - (freq / nyquist) * plotH;
    }
  }

  // ── Draw Loop ─────────────────────────────────────────────
  function drawLoop() {
    if (!isPlaying) return;
    animFrameId = requestAnimationFrame(drawLoop);

    const elapsed = audioCtx.currentTime - startTime;
    if (elapsed >= audioBuffer.duration) return;

    // Update time & progress
    updateTimeDisplay(elapsed, audioBuffer.duration);
    const pct = (elapsed / audioBuffer.duration) * 100;
    progressFill.style.width = pct + '%';
    progressInput.value = pct;

    // Get frequency data
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    // Draw column
    const ctx = spectrogramCanvas.getContext('2d');
    const canvasW = spectrogramCanvas.width;
    const canvasH = spectrogramCanvas.height;

    // Scroll left by 1 pixel
    const imageData = ctx.getImageData(1, 0, canvasW - 1, canvasH);
    ctx.putImageData(imageData, 0, 0);

    // Clear the rightmost column
    ctx.fillStyle = getCanvasBg();
    ctx.fillRect(canvasW - 1, 0, 1, canvasH);

    // Draw new column
    const nyquist = audioCtx.sampleRate / 2;

    // For each pixel row, map to frequency, then to FFT bin
    for (let py = 0; py < canvasH; py++) {
      const freq = yToFreq(py, canvasH, nyquist);
      const bin = (freq / nyquist) * bufferLength;
      const binIdx = Math.min(Math.floor(bin), bufferLength - 1);

      // Interpolate between bins
      const frac = bin - binIdx;
      const v0 = dataArray[binIdx];
      const v1 = binIdx + 1 < bufferLength ? dataArray[binIdx + 1] : v0;
      const value = v0 + (v1 - v0) * frac;
      const idx = Math.min(255, Math.round(value));

      const r = colorMap[idx * 3];
      const g = colorMap[idx * 3 + 1];
      const b = colorMap[idx * 3 + 2];

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(canvasW - 1, py, 1, 1);
    }
  }

  function yToFreq(py, plotH, nyquist) {
    // py=0 is top of canvas = highest freq, py=plotH-1 = lowest freq
    const ratio = 1 - py / plotH;
    if (logScale) {
      const minLog = Math.log10(20);
      const maxLog = Math.log10(nyquist);
      return Math.pow(10, minLog + ratio * (maxLog - minLog));
    } else {
      return ratio * nyquist;
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  function updateTimeDisplay(current, total) {
    timeDisplay.textContent = formatTime(current) + ' / ' + formatTime(total);
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
})();
