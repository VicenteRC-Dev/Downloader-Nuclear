/**
 * Jam Logger UI — temas, volumen, progreso circular, descargas en background
 */
(function () {
  'use strict';

  const THEME_KEY = 'jl_theme';
  const DL_KEY = 'jl_downloads';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // ---------- Temas ----------
  function applyTheme(name) {
    const t = ['spotify', 'apple', 'lite'].includes(name) ? name : 'spotify';
    const prev = document.documentElement.getAttribute('data-theme');
    if (prev && prev !== t) {
      document.documentElement.classList.add('theme-switching');
      setTimeout(() => document.documentElement.classList.remove('theme-switching'), 400);
    }
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
    $$('.theme-card').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-theme-pick') === t);
    });
  }
  window.setTheme = function (name) { applyTheme(name); };
  applyTheme(localStorage.getItem(THEME_KEY) || 'spotify');

  // ---------- Estado local de descargas ----------
  function loadLocalDownloads() {
    try { return JSON.parse(sessionStorage.getItem(DL_KEY) || '{}'); } catch (_) { return {}; }
  }
  function saveLocalDownloads(map) {
    try { sessionStorage.setItem(DL_KEY, JSON.stringify(map)); } catch (_) {}
  }
  function markDownloading(archivo, pct, estado) {
    const m = loadLocalDownloads();
    m[archivo] = { t: Date.now(), porcentaje: pct || 0, estado: estado || 'Descargando...' };
    saveLocalDownloads(m);
  }
  function unmarkDownloading(archivo) {
    const m = loadLocalDownloads();
    delete m[archivo];
    saveLocalDownloads(m);
  }

  function findDownloadButton(archivo) {
    return $$('.btn-icon, button').find((btn) => {
      const oc = btn.getAttribute('onclick') || '';
      return oc.includes(archivo);
    });
  }

  /** Círculo que se llena según porcentaje (no gira) */
  function progressRingHTML(pct) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 9;
    const c = 2 * Math.PI * r;
    const offset = c - (pct / 100) * c;
    return (
      '<span class="prog-wrap" title="' + pct + '%">' +
        '<svg class="prog-ring" width="22" height="22" viewBox="0 0 24 24">' +
          '<circle class="prog-bg" cx="12" cy="12" r="' + r + '" />' +
          '<circle class="prog-fg" cx="12" cy="12" r="' + r + '" ' +
            'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" />' +
        '</svg>' +
        '<span class="prog-pct">' + pct + '</span>' +
      '</span>'
    );
  }

  function paintProgress(btn, pct, estado) {
    if (!btn) return;
    btn.classList.add('loading');
    if (!btn.disabled) btn.disabled = true;
    const progressKey = String(Math.max(0, Math.min(100, Number(pct) || 0)));
    btn.title = (estado || 'Descargando...') + ' ' + progressKey + '%';
    btn.setAttribute('aria-label', btn.title);
    // Replacing the button contents on every poll retriggered the body observer
    // and could create an endless mutation/repaint loop while a download ran.
    if (btn.dataset.progressPct !== progressKey) {
      btn.innerHTML = progressRingHTML(pct);
      btn.dataset.progressPct = progressKey;
    }
    const row = btn.closest('.track-row');
    if (row && !row.classList.contains('downloading')) row.classList.add('downloading');
  }

  function clearProgress(btn, doneHtml) {
    if (!btn) return;
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = doneHtml || '⬇';
    delete btn.dataset.progressPct;
    const row = btn.closest('.track-row');
    if (row) row.classList.remove('downloading');
  }

  function restoreProgressAfterRender() {
    const local = loadLocalDownloads();
    Object.keys(local).forEach((archivo) => {
      const btn = findDownloadButton(archivo);
      if (btn) paintProgress(btn, local[archivo].porcentaje, local[archivo].estado);
    });
  }

  // Consultar todo el progreso con una petición, evitando solapar sondeos.
  let pollingDownloads = false;
  async function pollDownloads() {
    if (pollingDownloads || !Object.keys(loadLocalDownloads()).length) return;
    pollingDownloads = true;
    try {
      let all = null;
      try {
        const res = await fetch('/api/progress-all', { cache: 'no-store' });
        if (res.ok) all = await res.json();
      } catch (_) {}
      let completed = false;
      for (const archivo of Object.keys(loadLocalDownloads())) {
        let data = all && all[archivo];
        // Older proxy versions expose only the per-file progress route.
        if (!all) {
          try {
            const res = await fetch('/api/progress?archivo=' + encodeURIComponent(archivo), { cache: 'no-store' });
            if (res.ok) data = await res.json();
          } catch (_) {}
        }
        if (!data) continue;
        if (data.estado === '¡Completado!') {
          unmarkDownloading(archivo);
          clearProgress(findDownloadButton(archivo), '✓');
          completed = true;
          continue;
        }
        if (data.estado === 'Error' || data.estado === 'Inactivo') {
          unmarkDownloading(archivo);
          clearProgress(findDownloadButton(archivo), '⬇');
          if (data.estado === 'Error' && typeof showToast === 'function') showToast('❌ Error al descargar');
          continue;
        }
        const pct = data.porcentaje || 0;
        const estado = data.progresoEstimado ? data.estado + ' (aprox.)' : data.estado;
        markDownloading(archivo, pct, estado);
        paintProgress(findDownloadButton(archivo), pct, estado);
      }
      if (completed) {
        if (typeof cancionesAnteriores !== 'undefined') cancionesAnteriores = '';
        if (typeof cargarCanciones === 'function') cargarCanciones();
      }
    } catch (_) {
      // La siguiente ronda reintentará la consulta sin bloquear la página.
    } finally {
      pollingDownloads = false;
    }
  }
  setInterval(pollDownloads, 1200);

  async function syncDownloadsFromServer() {
    try {
      const res = await fetch('/api/downloads-active');
      const data = await res.json();
      const active = data.active || {};
      Object.keys(active).forEach((archivo) => {
        const st = active[archivo];
        markDownloading(archivo, st.porcentaje, st.estado);
        paintProgress(findDownloadButton(archivo), st.porcentaje, st.estado);
      });
    } catch (_) {}
  }

  // ---------- Descarga en background (no congela) ----------
  function patchDownloads() {
    window.iniciarFFmpeg = async function (archivo, btn) {
      markDownloading(archivo, 0, 'Descargando...');
      paintProgress(btn, 0, 'Descargando...');
      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivo })
        });
        const data = await res.json();
        if (!data.success) {
          unmarkDownloading(archivo);
          clearProgress(btn, '⬇');
          if (typeof showToast === 'function') showToast('❌ ' + (data.error || 'Error'));
          return;
        }
        // El progreso lo actualiza el poll; no esperamos aquí
        if (typeof showToast === 'function') showToast('⬇ Descargando...');
      } catch (_) {
        if (typeof showToast === 'function') showToast('⏳ Descarga en segundo plano...');
      }
    };
    window.iniciarFFmpeg.__patched = true;

    const origAlbum = window.descargarAlbumActual;
    if (typeof origAlbum === 'function' && !origAlbum.__patched) {
      window.descargarAlbumActual = async function () {
        const btn = document.querySelector('.btn-download-all');
        if (btn) {
          btn.classList.add('loading');
          btn.innerHTML = progressRingHTML(0);
        }
        try {
          if (!window.albumActual || !window.gruposCache || !window.gruposCache[window.albumActual]) {
            // fallback a original usando variables globales del script embebido
          }
          await origAlbum.apply(this, arguments);
        } finally {
          if (btn) {
            btn.classList.remove('loading');
            btn.innerHTML = '⬇';
          }
        }
      };
      window.descargarAlbumActual.__patched = true;
    }
  }

  // ---------- Volumen ----------
  let lastVol = 1;
  function volIcon(pct) {
    if (pct <= 0.001) return '🔇';
    if (pct < 0.35) return '🔈';
    if (pct < 0.7) return '🔉';
    return '🔊';
  }
  function updateVolumeUI() {
    const bar = document.getElementById('vol-bar');
    const audio = document.getElementById('main-player');
    if (!bar) return;
    const pct = Number(bar.value) / 100;
    bar.style.setProperty('--vol-pct', (pct * 100) + '%');
    const btn = document.getElementById('vol-btn');
    if (btn) btn.textContent = volIcon(pct);
    if (audio) audio.volume = pct;
  }
  function toggleMute() {
    const bar = document.getElementById('vol-bar');
    if (!bar) return;
    const v = Number(bar.value);
    if (v > 0) { lastVol = v; bar.value = 0; }
    else { bar.value = lastVol || 80; }
    bar.dispatchEvent(new Event('input', { bubbles: true }));
    updateVolumeUI();
  }
  function enhanceVolume() {
    const wrap = document.querySelector('.player-volume');
    const bar = document.getElementById('vol-bar');
    if (!wrap || !bar) return;
    const oldSpan = wrap.querySelector('span');
    if (oldSpan && oldSpan.id !== 'vol-btn') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'vol-btn';
      btn.className = 'vol-btn';
      btn.title = 'Silenciar';
      btn.textContent = volIcon(Number(bar.value) / 100);
      btn.onclick = toggleMute;
      oldSpan.replaceWith(btn);
    }
    bar.addEventListener('input', updateVolumeUI);
    updateVolumeUI();
  }

  function enhanceSeek() {
    const seek = document.getElementById('seek-bar');
    const audio = document.getElementById('main-player');
    if (!seek || !audio) return;
    const sync = () => seek.style.setProperty('--seek-pct', (seek.value || 0) + '%');
    seek.addEventListener('input', sync);
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) {
        seek.style.setProperty('--seek-pct', ((audio.currentTime / audio.duration) * 100) + '%');
      }
    });
    sync();
  }

  function enhancePlayer() {
    const bar = $('.player-bar');
    const audio = $('#main-player');
    const details = $('.player-details');
    if (!bar || !audio) return;
    if (details && !$('.eq-bars', details)) {
      const eq = document.createElement('div');
      eq.className = 'eq-bars';
      eq.innerHTML = '<span></span><span></span><span></span><span></span>';
      const title = $('.p-title', details);
      if (title) {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'center';
        title.parentNode.insertBefore(wrap, title);
        wrap.appendChild(eq);
        wrap.appendChild(title);
      }
    }
    const sync = () => {
      if (!audio.paused && audio.src) bar.classList.add('is-playing');
      else bar.classList.remove('is-playing');
    };
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('ended', sync);
  }

  function patchCargarCanciones() {
    const orig = window.cargarCanciones;
    if (typeof orig !== 'function' || orig.__fast) return;
    window.cargarCanciones = async function () {
      await orig.apply(this, arguments);
      restoreProgressAfterRender();
    };
    window.cargarCanciones.__fast = true;
  }

  const mo = new MutationObserver((records) => {
    const tracksRendered = records.some((record) => Array.from(record.addedNodes).some((node) => {
      if (node.nodeType !== 1) return false;
      return (node.matches && node.matches('.track-row')) || (node.querySelector && node.querySelector('.track-row'));
    }));
    if (tracksRendered) restoreProgressAfterRender();
    patchDownloads();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  function boot() {
    patchDownloads();
    patchCargarCanciones();
    enhancePlayer();
    enhanceVolume();
    enhanceSeek();
    syncDownloadsFromServer();
    setTimeout(() => applyTheme(localStorage.getItem(THEME_KEY) || 'spotify'), 50);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
