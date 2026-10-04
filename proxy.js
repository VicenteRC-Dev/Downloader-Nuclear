/**
 * jam-logger — proxy + vigilante + interfaz de descarga para Nuclear
 *
 * - Proxy de intercepción en :4120 (Jam como intermediario)
 * - Endpoints /__intercept/logs y /__intercept/clear para el plugin
 * - Vigilante de cola cada 5 s → genera JSON de canciones
 * - Interfaz web en :3000 para descargar MP3 con carátula e ID3
 *
 * Solo módulos nativos de Node.js. Requiere FFmpeg en el PATH.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { URL } = require('url');

// ---------- Configuración ----------
function obtenerIPLocal() {
  const interfaces = os.networkInterfaces();
  for (const nombre of Object.keys(interfaces)) {
    for (const det of interfaces[nombre]) {
      if (det.family === 'IPv4' && !det.internal) return det.address;
    }
  }
  return '127.0.0.1';
}

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 4120);
// Destino real del tráfico (MCP de Nuclear por defecto en 8800)
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT || 8800);
const UI_PORT = Number(process.env.UI_PORT || 3000);

const CAPTURES_TXT = path.join(__dirname, 'capturas_200.txt');
const DIR_JSON = path.join(__dirname, 'songs_json');
const DIR_DESCARGAS = path.join(__dirname, 'canciones_descargas');

const MAX_MEMORY_LIMIT = 10 * 1024 * 1024; // 10 MB por petición
const MAX_LOG_ENTRIES = 2000;

const C = {
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

// ---------- Carpetas ----------
if (!fs.existsSync(DIR_JSON)) fs.mkdirSync(DIR_JSON, { recursive: true });
if (!fs.existsSync(DIR_DESCARGAS)) fs.mkdirSync(DIR_DESCARGAS, { recursive: true });

// ---------- Buffer de logs para el plugin ----------
let logSeq = 0;
const logEntries = []; // { seq, id, t, dir, method, status, url, summary, body }

function pushLog(entry) {
  logSeq += 1;
  const full = {
    seq: logSeq,
    id: logSeq,
    t: new Date().toISOString(),
    ...entry
  };
  logEntries.push(full);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  }

  // También a disco (solo status 200 o errores)
  try {
    const line = `[${full.t}] ${full.dir} ${full.method || ''} ${full.status || ''} ${full.summary || full.url || ''}\n`;
    fs.appendFileSync(CAPTURES_TXT, line, 'utf8');
  } catch (_) {}

  return full;
}

function getLogsSince(since) {
  const n = Number(since) || 0;
  const entries = logEntries.filter((e) => e.seq > n);
  return { last: logSeq, entries };
}

function clearLogs() {
  logEntries.length = 0;
  logSeq = 0;
  try {
    fs.writeFileSync(CAPTURES_TXT, '', 'utf8');
  } catch (_) {}
}

// ---------- Vigilante de canciones ----------
let memoria = { cancion: null, video: null };

function guardarArchivoJson(track, tituloCancion, streamUrl) {
  const albumName = track.album?.title || 'Desconocido';
  let imageUrl =
    track.artwork?.items?.[0]?.url ||
    track.album?.artwork?.items?.[0]?.url ||
    '';

  const nombreSeguro =
    tituloCancion.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Cancion_Desconocida';
  const nombreArchivo = path.join(DIR_JSON, `${nombreSeguro}.json`);

  const datosCancion = {
    cancion: tituloCancion,
    album: albumName,
    imagen: imageUrl,
    stream_url: streamUrl
  };

  fs.writeFile(nombreArchivo, JSON.stringify(datosCancion, null, 2), (err) => {
    if (err) {
      console.error(`${C.red}❌ Error al guardar JSON: ${err.message}${C.reset}`);
    } else {
      console.log(`${C.green}💾 JSON guardado en songs_json/: ${nombreSeguro}.json${C.reset}`);
    }
  });
}

function iniciarVigilante() {
  setInterval(() => {
    const timestamp = Date.now();
    const options = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: `/api/queue?_t=${timestamp}`,
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
    };

    http
      .get(options, (res) => {
        if (res.statusCode !== 200) return;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data.items) return;

            const index = data.currentIndex !== undefined ? data.currentIndex : 0;
            const itemActual = data.items[index];
            if (!itemActual || !itemActual.track) return;

            const track = itemActual.track;
            const tituloCancion = track.title || 'Desconocido';
            const idUnico = itemActual.id || tituloCancion;

            let streamUrl = '';
            let idVideoActual = 'sin_video';

            if (Array.isArray(track.streamCandidates)) {
              const candidatoValido = track.streamCandidates.find(
                (c) => c.stream && c.stream.url
              );
              if (candidatoValido) {
                streamUrl = candidatoValido.stream.url;
                idVideoActual = candidatoValido.id || 'sin_video';
              }
            }

            const cambioDeCancion = idUnico !== memoria.cancion;
            const cambioDeVideo =
              idVideoActual !== memoria.video && idVideoActual !== 'sin_video';

            if (cambioDeCancion || cambioDeVideo) {
              memoria.cancion = idUnico;
              memoria.video = idVideoActual;
              if (streamUrl) guardarArchivoJson(track, tituloCancion, streamUrl);
            }
          } catch (_) {}
        });
      })
      .on('error', () => {});
  }, 5000);
}

// ---------- Descarga + FFmpeg ----------
function descargarArchivo(url, rutaDestino) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(rutaDestino);
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(rutaDestino, () => {});
          return reject(new Error(`Status ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(rutaDestino, () => {});
        reject(err);
      });
  });
}

async function procesarDescarga(rutaJsonCompleta) {
  try {
    const datos = JSON.parse(fs.readFileSync(rutaJsonCompleta, 'utf8'));
    if (!datos.stream_url) throw new Error('No hay URL de stream');

    const nombreSeguro = datos.cancion.replace(/[<>:"/\\|?*]+/g, '').trim();
    const tempAudio = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.m4a`);
    const tempImg = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.jpg`);
    const finalMp3 = path.join(DIR_DESCARGAS, `${nombreSeguro}.mp3`);

    console.log(`${C.cyan}⬇️ Descargando audio e imagen de: ${datos.cancion}...${C.reset}`);
    await Promise.all([
      descargarArchivo(datos.stream_url, tempAudio),
      descargarArchivo(datos.imagen, tempImg)
    ]);

    console.log(`${C.yellow}⚙️ Procesando con FFmpeg: ${datos.cancion}...${C.reset}`);

    // Escapar comillas para el shell
    const esc = (s) => String(s).replace(/"/g, '\\"');
    const cmd = `ffmpeg -y -i "${tempAudio}" -i "${tempImg}" -map 0:a -map 1:v -c:v mjpeg -id3v2_version 3 -metadata title="${esc(datos.cancion)}" -metadata album="${esc(datos.album)}" "${finalMp3}"`;

    await new Promise((resolve, reject) => {
      exec(cmd, (error) => {
        if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
        if (fs.existsSync(tempImg)) fs.unlinkSync(tempImg);
        if (error) reject(error);
        else resolve();
      });
    });

    console.log(`${C.green}✅ ¡MP3 guardado en canciones_descargas/: ${nombreSeguro}.mp3${C.reset}`);
    return { success: true, message: 'Descarga y conversión completada' };
  } catch (error) {
    console.log(`${C.red}❌ Error en descarga: ${error.message}${C.reset}`);
    return { success: false, error: error.message };
  }
}

// ---------- Proxy principal (escucha en LISTEN_PORT) ----------
const proxyServer = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${LISTEN_PORT}`);

  // Endpoints internos del plugin (no se reenvían)
  if (urlObj.pathname === '/__intercept/logs' && req.method === 'GET') {
    const since = urlObj.searchParams.get('since') || '0';
    const data = getLogsSince(since);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (urlObj.pathname === '/__intercept/clear' && req.method === 'POST') {
    clearLogs();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Proxy genérico: captura body, reenvía y registra
  const chunks = [];
  let reqSize = 0;

  req.on('data', (c) => {
    reqSize += c.length;
    if (reqSize > MAX_MEMORY_LIMIT) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const bodyStr = body.length ? body.toString('utf8') : '';

    // Registrar request
    pushLog({
      dir: 'request',
      method: req.method,
      url: req.url,
      summary: `${req.method} ${req.url}`,
      body: bodyStr.slice(0, 50_000) // límite para no inflar memoria
    });

    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    delete headers['transfer-encoding'];
    delete headers['content-length']; // se recalcula

    const upstream = http.request(
      {
        host: TARGET_HOST,
        port: TARGET_PORT,
        method: req.method,
        path: req.url,
        headers
      },
      (upRes) => {
        const resChunks = [];
        upRes.on('data', (chunk) => {
          resChunks.push(chunk);
          res.write(chunk);
        });
        upRes.on('end', () => {
          const resBody = Buffer.concat(resChunks).toString('utf8');
          pushLog({
            dir: 'response',
            method: req.method,
            status: upRes.statusCode,
            url: req.url,
            summary: `${upRes.statusCode} ${req.url}`,
            body: resBody.slice(0, 50_000)
          });
          res.end();
        });
        res.writeHead(upRes.statusCode, upRes.headers);
      }
    );

    upstream.on('error', (err) => {
      pushLog({
        dir: 'error',
        method: req.method,
        url: req.url,
        summary: `upstream error: ${err.message}`,
        body: ''
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('Bad gateway');
    });

    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
});

// ---------- Interfaz web (puerto UI_PORT) ----------
const HTML_UI = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jam Logger · Biblioteca capturada</title>
  <style>
    :root { --bg: #121212; --surface: #1e1e1e; --primary: #bb86fc; --text: #e0e0e0; --text-dim: #a0a0a0; }
    body { margin: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
    h1 { text-align: center; color: var(--primary); font-weight: 300; margin-bottom: 8px; }
    .sub { text-align: center; color: var(--text-dim); margin-bottom: 40px; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; max-width: 1200px; margin: 0 auto; }
    .card { background: var(--surface); border-radius: 12px; padding: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); display: flex; flex-direction: column; align-items: center; text-align: center; transition: transform 0.2s; }
    .card:hover { transform: translateY(-5px); }
    .cover { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; margin-bottom: 15px; background: #333; }
    .title { font-size: 1.1rem; font-weight: 600; margin: 0 0 5px 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .album { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 15px 0; }
    .btn { background: var(--primary); color: #000; border: none; padding: 10px 20px; border-radius: 20px; font-weight: bold; cursor: pointer; width: 100%; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn:disabled { background: #555; cursor: not-allowed; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #323232; color: #fff; padding: 12px 24px; border-radius: 8px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .empty { text-align: center; color: var(--text-dim); margin-top: 60px; }
  </style>
</head>
<body>
  <h1>🎵 Jam Logger</h1>
  <p class="sub">Biblioteca musical capturada · Nuclear</p>
  <div class="grid" id="grid"></div>
  <div class="toast" id="toast">Notificación</div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg; t.style.opacity = 1;
      setTimeout(() => t.style.opacity = 0, 3000);
    }

    async function cargarCanciones() {
      try {
        const res = await fetch('/api/songs');
        const canciones = await res.json();
        const grid = document.getElementById('grid');
        grid.innerHTML = '';

        if (!canciones.length) {
          grid.innerHTML = '<p class="empty">Aún no hay canciones. Reproduce algo en Nuclear y espera unos segundos.</p>';
          return;
        }

        canciones.forEach(c => {
          const card = document.createElement('div');
          card.className = 'card';
          card.innerHTML = \`
            <img src="\${c.imagen}" class="cover" alt="Portada" onerror="this.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='">
            <h3 class="title">\${c.cancion}</h3>
            <p class="album">\${c.album}</p>
            <button class="btn" onclick="descargar('\${c.archivo}', this)">⬇️ Descargar MP3</button>
          \`;
          grid.appendChild(card);
        });
      } catch (e) {
        console.error(e);
      }
    }

    async function descargar(archivo, btn) {
      btn.disabled = true;
      btn.innerText = '⏳ Procesando...';
      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivo })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✅ MP3 generado en canciones_descargas/');
          btn.innerText = '✅ ¡Listo!';
        } else {
          showToast('❌ Error: ' + data.error);
          btn.innerText = '⬇️ Reintentar';
          btn.disabled = false;
        }
      } catch (e) {
        showToast('❌ Error de conexión');
        btn.innerText = '⬇️ Reintentar';
        btn.disabled = false;
      }
    }

    cargarCanciones();
    setInterval(cargarCanciones, 5000);
  </script>
</body>
</html>
`;

const uiServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_UI);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/songs') {
    const archivos = fs.readdirSync(DIR_JSON).filter((f) => f.endsWith('.json'));
    const canciones = archivos
      .map((archivo) => {
        try {
          const rutaCompleta = path.join(DIR_JSON, archivo);
          const datos = JSON.parse(fs.readFileSync(rutaCompleta, 'utf8'));
          return { archivo, ...datos };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(canciones));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/download') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.archivo || !payload.archivo.endsWith('.json')) {
          throw new Error('Archivo inválido');
        }

        const rutaJson = path.join(DIR_JSON, payload.archivo);
        if (!fs.existsSync(rutaJson)) throw new Error('El archivo JSON no existe');

        const resultado = await procesarDescarga(rutaJson);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// ---------- Arranque ----------
proxyServer.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`${C.green}🚀 jam-logger proxy activo${C.reset}`);
  console.log(`   Interceptación : http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`   Destino        : http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`   Logs plugin    : GET  /__intercept/logs?since=N`);
  console.log(`                   POST /__intercept/clear`);
  iniciarVigilante();
});

uiServer.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`${C.cyan}🖥️  Interfaz gráfica  : http://127.0.0.1:${UI_PORT}${C.reset}`);
});

process.on('SIGINT', () => {
  console.log('\nCerrando jam-logger...');
  process.exit(0);
});
