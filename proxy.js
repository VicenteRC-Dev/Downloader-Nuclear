const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };

// ---------- Algoritmo de IP LAN (Corregido para Node v24) ----------
function obtenerIPLocal() {
  const interfaces = os.networkInterfaces();
  
  // 1. Prioridad absoluta: Buscar específicamente adaptadores de Wi-Fi / Inalámbricos
  for (const nombre of Object.keys(interfaces)) {
    const nombreLow = nombre.toLowerCase();
    if (nombreLow.includes('wi-fi') || nombreLow.includes('wifi') || nombreLow.includes('wlan') || nombreLow.includes('wireless')) {
      for (const red of interfaces[nombre]) {
        if ((red.family === 'IPv4' || red.family === 4) && !red.internal) {
          return red.address; // Devuelve directamente la IP del Wi-Fi
        }
      }
    }
  }

  // 2. Respaldo: Si no detecta la etiqueta Wi-Fi por nombre, busca por rangos LAN clásicos (ej. Ethernet)
  let ips = [];
  for (const nombre of Object.keys(interfaces)) {
    if (nombre.toLowerCase().match(/(wsl|vmware|vbox|docker|hyper|lo)/)) continue;
    for (const red of interfaces[nombre]) {
      if ((red.family === 'IPv4' || red.family === 4) && !red.internal) {
        ips.push(red.address);
      }
    }
  }

  for (const ip of ips) {
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
      return ip;
    }
  }
  
  return ips.length > 0 ? ips[0] : '127.0.0.1';
}

const LAN_IP = obtenerIPLocal();
// ¡CAMBIO CLAVE! El proxy ahora escucha en 4121 para no chocar con Nuclear
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 4121);
const TARGET_HOST = '127.0.0.1'; 
// Nuclear sigue estando en 4120
const TARGET_PORT = Number(process.env.TARGET_PORT || 4120);
const UI_PORT = 3000; 

const CAPTURES_TXT = 'capturas_200.txt'; 
const DIR_JSON = path.join(__dirname, 'songs_json');          
const DIR_DESCARGAS = path.join(__dirname, 'canciones_descargas'); 
const MAX_MEMORY_LIMIT = 10 * 1024 * 1024; 
const MAX_LOG_ENTRIES = 300;
// ---------- Carpetas y Limpieza ----------
if (!fs.existsSync(DIR_JSON)) fs.mkdirSync(DIR_JSON, { recursive: true });
if (!fs.existsSync(DIR_DESCARGAS)) fs.mkdirSync(DIR_DESCARGAS, { recursive: true });

function limpiarArchivosTemporales() {
  try {
    const archivos = fs.readdirSync(DIR_DESCARGAS);
    for (const archivo of archivos) {
      if (archivo.startsWith('temp_')) {
        fs.unlinkSync(path.join(DIR_DESCARGAS, archivo));
        console.log(`${C.dim}🗑️ Archivo temporal residual eliminado: ${archivo}${C.reset}`);
      }
    }
  } catch (e) {}
}
limpiarArchivosTemporales();

const estadoDescargas = {}; 
let logSeq = 0;
const logEntries = []; 

function pushLog(entry) {
  logSeq += 1;
  const full = { seq: logSeq, id: logSeq, t: new Date().toISOString(), ...entry };
  logEntries.push(full);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  try {
    const line = `[${full.t}] ${full.dir} ${full.method || ''} ${full.status || ''} ${full.summary || full.url || ''}\n`;
    fs.appendFileSync(CAPTURES_TXT, line, 'utf8');
  } catch (_) {}
  return full;
}

function getLogsSince(since) {
  const n = Number(since) || 0;
  return { last: logSeq, entries: logEntries.filter((e) => e.seq > n) };
}

function clearLogs() {
  logEntries.length = 0; logSeq = 0;
  try { fs.writeFileSync(CAPTURES_TXT, '', 'utf8'); } catch (_) {}
}

// ---------- Vigilante de canciones ----------
let memoria = { cancion: null, video: null };

function guardarArchivoJson(track, tituloCancion, streamUrl) {
  let albumName = 'Desconocido';
  if (typeof track.album === 'string') albumName = track.album;
  else if (track.album?.title) albumName = track.album.title;
  else if (track.album?.name) albumName = track.album.name;

  let artistName = 'Desconocido';
  if (typeof track.artist === 'string') artistName = track.artist;
  else if (track.artists && track.artists.length > 0) artistName = track.artists[0].name || track.artists[0];
  else if (track.artist?.name) artistName = track.artist.name;
  else if (track.album?.artist) artistName = typeof track.album.artist === 'string' ? track.album.artist : track.album.artist.name;

  let imageUrl = track.artwork?.items?.[0]?.url || track.album?.artwork?.items?.[0]?.url || track.thumbnail || track.image || '';
  if (typeof artistName !== 'string') artistName = 'Desconocido';
  if (typeof albumName !== 'string') albumName = 'Desconocido';

  const nombreSeguro = tituloCancion.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Cancion_Desconocida';
  const nombreArchivo = path.join(DIR_JSON, `${nombreSeguro}.json`);
  const datosCancion = { cancion: tituloCancion, album: albumName, artista: artistName, imagen: imageUrl, stream_url: streamUrl };

  fs.writeFile(nombreArchivo, JSON.stringify(datosCancion, null, 2), (err) => {
    if (err) console.error(`${C.red}❌ Error al guardar JSON: ${err.message}${C.reset}`);
    else {
      console.log(`${C.green}🎵 Capturado: ${tituloCancion} - ${artistName}${C.reset}`);
    }
  });
}

function iniciarVigilante() {
  setInterval(() => {
    http.get({ hostname: TARGET_HOST, port: TARGET_PORT, path: `/api/queue?_t=${Date.now()}`, method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
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
          let streamUrl = '', idVideoActual = 'sin_video';

          if (Array.isArray(track.streamCandidates)) {
            const candidatoValido = track.streamCandidates.find(c => c.stream && c.stream.url);
            if (candidatoValido) { streamUrl = candidatoValido.stream.url; idVideoActual = candidatoValido.id || 'sin_video'; }
          }
          if (idUnico !== memoria.cancion || (idVideoActual !== memoria.video && idVideoActual !== 'sin_video')) {
            memoria.cancion = idUnico; memoria.video = idVideoActual;
            if (streamUrl) guardarArchivoJson(track, tituloCancion, streamUrl);
          }
        } catch (_) {}
      });
    }).on('error', () => {}); 
  }, 5000);
}

// ---------- Descargas ----------
function descargarArchivo(url, rutaDestino, idArchivo, esAudio) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(rutaDestino);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(rutaDestino, () => {}); return reject(new Error(`Status ${res.statusCode}`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let recibido = 0;
      res.on('data', (chunk) => {
        recibido += chunk.length;
        if (esAudio && total && idArchivo && estadoDescargas[idArchivo]) {
          estadoDescargas[idArchivo].porcentaje = Math.floor((recibido / total) * 100);
        }
      });
      res.pipe(file); file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(rutaDestino, () => {}); reject(err); });
  });
}

async function procesarDescarga(rutaJsonCompleta, idArchivo) {
  const datos = JSON.parse(fs.readFileSync(rutaJsonCompleta, 'utf8'));
  const nombreSeguro = datos.cancion.replace(/[<>:"/\\|?*]+/g, '').trim();
  const tempAudio = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.m4a`);
  const tempImg = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.jpg`);
  const finalMp3 = path.join(DIR_DESCARGAS, `${nombreSeguro}.mp3`);

  try {
    estadoDescargas[idArchivo] = { porcentaje: 0, estado: 'Descargando...' };
    console.log(`${C.cyan}⬇️ Descargando audio e imagen de: ${datos.cancion}...${C.reset}`);
    await Promise.all([
      descargarArchivo(datos.stream_url, tempAudio, idArchivo, true),
      descargarArchivo(datos.imagen, tempImg, idArchivo, false)
    ]);
    estadoDescargas[idArchivo] = { porcentaje: 100, estado: 'Convirtiendo...' };
    console.log(`${C.yellow}⚙️ Procesando con FFmpeg: ${datos.cancion}...${C.reset}`);
    const esc = (s) => String(s).replace(/"/g, '\\"');
    const cmd = `ffmpeg -y -i "${tempAudio}" -i "${tempImg}" -map 0:a -map 1:v -c:v mjpeg -id3v2_version 3 -metadata title="${esc(datos.cancion)}" -metadata album="${esc(datos.album)}" -metadata artist="${esc(datos.artista || '')}" "${finalMp3}"`;
    await new Promise((resolve, reject) => { exec(cmd, (error) => { if (error) reject(error); else resolve(); }); });
    estadoDescargas[idArchivo] = { porcentaje: 100, estado: '¡Completado!' };
    console.log(`${C.green}✅ ¡MP3 guardado en carpeta local: ${nombreSeguro}.mp3${C.reset}`);
    return { success: true };
  } catch (error) {
    estadoDescargas[idArchivo] = { porcentaje: 0, estado: 'Error' };
    console.log(`${C.red}❌ Error en descarga: ${error.message}${C.reset}`);
    return { success: false, error: error.message };
  } finally {
    if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
    if (fs.existsSync(tempImg)) fs.unlinkSync(tempImg);
  }
}

// ---------- Proxy principal ----------
const proxyServer = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${LISTEN_PORT}`);
  if (urlObj.pathname === '/__intercept/logs') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(getLogsSince(urlObj.searchParams.get('since') || '0'))); return; }
  
  const chunks = []; let reqSize = 0;
  req.on('data', (c) => { reqSize += c.length; if (reqSize > MAX_MEMORY_LIMIT) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    delete headers['transfer-encoding']; delete headers['content-length']; 

    const upstream = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers }, (upRes) => {
      upRes.on('data', (chunk) => { res.write(chunk); });
      upRes.on('end', () => { res.end(); });
      res.writeHead(upRes.statusCode, upRes.headers);
    });
    upstream.on('error', (err) => { if (!res.headersSent) res.writeHead(502); res.end('Bad gateway'); });
    upstream.end(body);
  });
});

// ---------- Interfaz Web ----------
const HTML_UI = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="https://images.emojiterra.com/google/android-11/512px/1f431.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jam Logger</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --surface: #18181b;
      --surface-hover: #27272a;
      --primary: #8b5cf6;
      --primary-glow: rgba(139, 92, 246, 0.4);
      --success: #10b981;
      --text: #f4f4f5;
      --text-dim: #a1a1aa;
      --border: rgba(255, 255, 255, 0.08);
    }
    
    body { 
      margin: 0; 
      font-family: 'Inter', sans-serif; 
      background: var(--bg); 
      color: var(--text); 
      padding: 20px; 
      padding-bottom: 120px; /* Espacio para el reproductor inferior */
    }

    /* Cabecera */
    .header { text-align: center; margin-bottom: 40px; margin-top: 20px; }
    .header h1 { color: var(--text); font-weight: 700; margin-bottom: 5px; font-size: 2.5rem; letter-spacing: -1px; }
    .header h1 span { color: var(--primary); text-shadow: 0 0 20px var(--primary-glow); }
    .header p { color: var(--text-dim); font-size: 1rem; background: var(--surface); display: inline-block; padding: 8px 16px; border-radius: 20px; border: 1px solid var(--border); }
    .header p b { color: #fff; }

    /* Secciones de Álbumes */
    .album-section { margin-bottom: 50px; }
    .album-section h2 { border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-top: 0; font-size: 1.4rem; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 10px; }
    
    /* Grid de Tarjetas */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 24px; margin-top: 20px; }
    .card { 
      background: var(--surface); 
      border-radius: 16px; 
      padding: 16px; 
      border: 1px solid var(--border);
      transition: all 0.3s ease; 
      display: flex; flex-direction: column; 
    }
    .card:hover { transform: translateY(-5px); background: var(--surface-hover); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    
    .cover { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 12px; margin-bottom: 16px; background: #000; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .title { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
    .album { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 16px 0; display: flex; align-items: center; gap: 5px; }
    
    /* Botones */
    .btn { 
      background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text); 
      padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; width: 100%; 
      transition: all 0.2s; margin-top: 8px; text-decoration: none; display: block; text-align: center; box-sizing: border-box; font-size: 0.9rem;
    }
    .btn:hover { background: rgba(255,255,255,0.1); }
    
    .btn-play { background: var(--primary); color: #fff; border: none; box-shadow: 0 4px 15px var(--primary-glow); }
    .btn-play:hover { background: #7c3aed; transform: scale(1.02); }
    
    .btn-download-lan { background: var(--success); border: none; color: #fff; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.2); }
    .btn-download-lan:hover { background: #059669; }

    /* REPRODUCTOR DE MÚSICA INFERIOR */
    .player-bar { 
      position: fixed; bottom: 0; left: 0; right: 0; 
      background: rgba(24, 24, 27, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border-top: 1px solid var(--border); padding: 16px 30px; z-index: 1000; 
      display: flex; align-items: center; justify-content: space-between; gap: 20px;
    }
    
    .player-info { display: flex; align-items: center; gap: 15px; width: 30%; min-width: 200px; }
    .player-info img { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: #000; }
    .player-details { display: flex; flex-direction: column; overflow: hidden; white-space: nowrap; }
    .player-details .p-title { font-weight: 600; font-size: 1rem; color: #fff; text-overflow: ellipsis; overflow: hidden; }
    .player-details .p-artist { font-size: 0.85rem; color: var(--text-dim); text-overflow: ellipsis; overflow: hidden; }

    .player-controls { display: flex; flex-direction: column; align-items: center; width: 40%; gap: 8px; }
    .control-buttons { display: flex; align-items: center; gap: 20px; }
    .btn-circle { 
      background: #fff; color: #000; border: none; width: 40px; height: 40px; border-radius: 50%; 
      display: flex; justify-content: center; align-items: center; cursor: pointer; font-size: 1.2rem; transition: transform 0.2s; 
    }
    .btn-circle:hover { transform: scale(1.08); }
    
    .progress-container { display: flex; align-items: center; gap: 10px; width: 100%; font-size: 0.75rem; color: var(--text-dim); }
    input[type="range"] { 
      -webkit-appearance: none; width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 5px; outline: none; cursor: pointer; 
    }
    input[type="range"]::-webkit-slider-thumb { 
      -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; cursor: pointer; transition: transform 0.1s; 
    }
    input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.3); }

    .player-volume { display: flex; align-items: center; gap: 10px; width: 30%; justify-content: flex-end; }
    .player-volume input { width: 100px; }

    .toast { position: fixed; bottom: 100px; right: 20px; background: var(--surface-hover); border: 1px solid var(--border); color: #fff; padding: 12px 24px; border-radius: 8px; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 2000; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    
    /* Responsive */
    @media (max-width: 768px) {
      .player-bar { padding: 12px; flex-direction: column; gap: 12px; }
      .player-info { width: 100%; justify-content: center; text-align: center; }
      .player-controls { width: 100%; }
      .player-volume { display: none; }
      body { padding-bottom: 160px; }
    }
  </style>
</head>
<body>
  
  <div class="header">
    <h1>Jam <span>Logger</span></h1>
    <p>📡 LAN Activa: <b>http://${LAN_IP}:${UI_PORT}</b></p>
  </div>
  
  <div id="contenedor-albumes">
    <p style="text-align:center; color:var(--text-dim); margin-top: 50px;">Aún no hay canciones. Reproduce algo en Nuclear.</p>
  </div>
  
  <!-- REPRODUCTOR CUSTOM INFERIOR -->
  <div class="player-bar">
    <div class="player-info">
      <img id="np-cover" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="Cover">
      <div class="player-details">
        <div class="p-title" id="np-title">Esperando pista...</div>
        <div class="p-artist" id="np-artist">---</div>
      </div>
    </div>
    
    <div class="player-controls">
      <div class="control-buttons">
        <button class="btn-circle" id="btn-play-pause">▶</button>
      </div>
      <div class="progress-container">
        <span id="time-current">0:00</span>
        <input type="range" id="seek-bar" value="0" max="100">
        <span id="time-total">0:00</span>
      </div>
    </div>
    
    <div class="player-volume">
      <span style="font-size: 1.2rem;">🔈</span>
      <input type="range" id="vol-bar" value="100" max="100">
    </div>
    
    <!-- Audio Oculto -->
    <audio id="main-player" style="display:none;"></audio>
  </div>

  <div class="toast" id="toast">Notificación</div>

  <script>
    const audio = document.getElementById('main-player');
    const playPauseBtn = document.getElementById('btn-play-pause');
    const seekBar = document.getElementById('seek-bar');
    const volBar = document.getElementById('vol-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');
    let cancionesAnteriores = ''; 

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg; t.style.opacity = 1;
      setTimeout(() => t.style.opacity = 0, 3000);
    }

    function formatTime(sec) {
      if (isNaN(sec)) return "0:00";
      let m = Math.floor(sec / 60);
      let s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0'+s : s);
    }

    // Funciones del Reproductor Custom
    function playAudio(url, title, artist, cover) {
      audio.src = url;
      audio.play().catch(e => showToast('⚠️ Error reproduciendo stream.'));
      
      document.getElementById('np-title').innerText = title;
      document.getElementById('np-artist').innerText = artist;
      document.getElementById('np-cover').src = cover;
      playPauseBtn.innerText = '⏸';
    }

    playPauseBtn.onclick = () => {
      if(audio.paused && audio.src) { audio.play(); playPauseBtn.innerText = '⏸'; }
      else if (!audio.paused) { audio.pause(); playPauseBtn.innerText = '▶'; }
    };

    audio.ontimeupdate = () => {
      if(audio.duration) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
        timeCurrent.innerText = formatTime(audio.currentTime);
        timeTotal.innerText = formatTime(audio.duration);
      }
    };

    seekBar.oninput = () => { if(audio.duration) audio.currentTime = (seekBar.value / 100) * audio.duration; };
    volBar.oninput = () => { audio.volume = volBar.value / 100; };
    audio.onended = () => { playPauseBtn.innerText = '▶'; seekBar.value = 0; timeCurrent.innerText = "0:00"; };

    // Carga de la biblioteca
    async function cargarCanciones() {
      try {
        const res = await fetch('/api/songs');
        const canciones = await res.json();
        
        const estadoActual = JSON.stringify(canciones);
        if (estadoActual === cancionesAnteriores) return; 
        cancionesAnteriores = estadoActual;

        const contenedor = document.getElementById('contenedor-albumes');
        if (!canciones.length) return;

        const gruposAlbumes = {};
        canciones.forEach(c => {
          const nombreAlbum = c.album || 'Desconocido';
          if (!gruposAlbumes[nombreAlbum]) gruposAlbumes[nombreAlbum] = [];
          gruposAlbumes[nombreAlbum].push(c);
        });

        let htmlFinal = '';
        for (const album in gruposAlbumes) {
          htmlFinal += \`<div class="album-section"><h2>💿 \${album}</h2><div class="grid">\`;
          
          gruposAlbumes[album].forEach(c => {
            const enlaceMp3LAN = '/canciones/' + encodeURIComponent(c.archivo.replace('.json', '.mp3'));
            const playLink = c.hasMp3 ? enlaceMp3LAN : c.stream_url;

            let btnHtml = '';
            if (c.hasMp3) {
              btnHtml = \`<a class="btn btn-download-lan" href="\${enlaceMp3LAN}" download="\${c.cancion}.mp3">⬇️ Guardar MP3</a>\`;
            } else {
              btnHtml = \`<button class="btn" onclick="iniciarFFmpeg('\${c.archivo}', this)">⚙️ Extraer MP3</button>\`;
            }
            
            // Escapar comillas en variables para la inyección JS
            const safeTitle = c.cancion.replace(/'/g, "\\'");
            const safeArtist = (c.artista || 'Desconocido').replace(/'/g, "\\'");
            const safeCover = c.imagen || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

            htmlFinal += \`
              <div class="card">
                <img src="\${safeCover}" class="cover">
                <h3 class="title">\${c.cancion}</h3>
                <p class="album">👤 \${c.artista || 'Desconocido'}</p>
                <button class="btn btn-play" onclick="playAudio('\${playLink}', '\${safeTitle}', '\${safeArtist}', '\${safeCover}')">▶ Escuchar</button>
                \${btnHtml}
              </div>
            \`;
          });
          htmlFinal += \`</div></div>\`;
        }
        
        contenedor.innerHTML = htmlFinal;
      } catch (e) { console.error(e); }
    }

    async function iniciarFFmpeg(archivo, btn) {
      btn.disabled = true; btn.innerText = '⏳ Procesando...';
      
      const intervalo = setInterval(async () => {
        try {
          const res = await fetch(\`/api/progress?archivo=\${encodeURIComponent(archivo)}\`);
          const data = await res.json();
          if (data.estado !== 'Inactivo') btn.innerText = \`⏳ \${data.porcentaje || 0}% (\${data.estado})\`;
        } catch (e) {}
      }, 500);

      try {
        const res = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivo }) });
        clearInterval(intervalo);
        const data = await res.json();
        
        if (data.success) {
          showToast('✅ MP3 extraído con éxito.');
          cargarCanciones(); 
        } else {
          showToast('❌ Error: ' + data.error); btn.innerText = '⚙️ Reintentar'; btn.disabled = false;
        }
      } catch (e) {
        clearInterval(intervalo);
        showToast('❌ Error de red'); btn.innerText = '⚙️ Reintentar'; btn.disabled = false;
      }
    }

    cargarCanciones();
    setInterval(cargarCanciones, 5000);
  </script>
</body>
</html>
`;

// ---------- SERVIDOR INTERFAZ WEB ----------
const uiServer = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${UI_PORT}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_UI);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/canciones/')) {
    const fileName = pathname.replace('/canciones/', '');
    const safePath = path.normalize(path.join(DIR_DESCARGAS, fileName));
    
    if (!safePath.startsWith(DIR_DESCARGAS) || !fs.existsSync(safePath)) {
      res.writeHead(404); return res.end();
    }
    
    const stat = fs.statSync(safePath);
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/songs') {
    try {
      const archivos = fs.readdirSync(DIR_JSON).filter((f) => f.endsWith('.json'));
      const canciones = archivos.map((archivo) => {
        try {
          const rutaCompleta = path.join(DIR_JSON, archivo);
          const datos = JSON.parse(fs.readFileSync(rutaCompleta, 'utf8'));
          const mp3Name = archivo.replace('.json', '.mp3');
          const hasMp3 = fs.existsSync(path.join(DIR_DESCARGAS, mp3Name));
          return { archivo, hasMp3, ...datos };
        } catch (_) { return null; }
      }).filter(Boolean);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(canciones));
    } catch(e) { res.writeHead(500); res.end('[]'); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/progress') {
    const archivo = urlObj.searchParams.get('archivo');
    const estado = estadoDescargas[archivo] || { porcentaje: 0, estado: 'Inactivo' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(estado));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/download') {
    let body = ''; req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.archivo || !payload.archivo.endsWith('.json')) throw new Error('Archivo inválido');
        const rutaJson = path.join(DIR_JSON, payload.archivo);
        if (!fs.existsSync(rutaJson)) throw new Error('El archivo JSON no existe');
        const resultado = await procesarDescarga(rutaJson, payload.archivo);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resultado));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ---------- ARRANQUE DE SERVIDORES ----------
proxyServer.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.green}🚀 Jam Logger Proxy Activo${C.reset}`);
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.cyan}📡 Escuchando peticiones Plugin Nuclear en: http://127.0.0.1:${LISTEN_PORT}${C.reset}`);
  iniciarVigilante();
});

uiServer.listen(UI_PORT, '0.0.0.0', () => {
  console.log(`${C.yellow}🖥️  Interfaz en Servidor PC : http://127.0.0.1:${UI_PORT}${C.reset}`);
  console.log(`${C.yellow}🌐 Interfaz en Red LAN    : http://${LAN_IP}:${UI_PORT}${C.reset}`);
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.dim}Esperando canciones en Nuclear...${C.reset}\n`);
});

process.on('SIGINT', () => {
  console.log('\nCerrando jam-logger...');
  process.exit(0);
});