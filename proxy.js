const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
          return red.address;
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
// Puerto único 4121: proxy + UI + APIs
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3000);
const TARGET_HOST = '127.0.0.1'; 
const TARGET_PORT = Number(process.env.TARGET_PORT || 4120);

// ---------- Detectar yt-dlp (Windows: yt-dlp.exe en la misma carpeta) ----------
function resolverYtDlp() {
  const candidatos = [
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp'),
    path.join(process.cwd(), 'yt-dlp.exe'),
    path.join(process.cwd(), 'yt-dlp'),
    'yt-dlp.exe',
    'yt-dlp'
  ];
  for (const c of candidatos) {
    try {
      if (c.includes(path.sep) || c.endsWith('.exe')) {
        if (fs.existsSync(c)) return c;
      }
    } catch (_) {}
  }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}
const YTDLP_BIN = resolverYtDlp();
console.log(`${C.dim}yt-dlp → ${YTDLP_BIN}${C.reset}`);


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

// ---------- Helpers de álbum / yt-dlp (mezclados de nuclear-album-urls.js) ----------
const albumsResueltos = new Set(); // álbumes ya procesados en esta sesión
let resolviendoAlbum = false;
let regeneracionFuentes = { running: false, total: 0, processed: 0, updated: 0, failed: 0, current: '' };
let albumPendienteUI = null; // { name, items, existingCount, total } — espera decisión del usuario

/** Comprueba cuántas pistas de un álbum ya existen en songs_json */
function estadoAlbumEnDisco(albumName, items) {
  let existentes = 0;
  const faltantes = [];
  for (const it of items) {
    const title = (it.track && it.track.title) || 'Unknown';
    const ruta = path.join(DIR_JSON, `${safeFilename(title)}.json`);
    if (fs.existsSync(ruta)) {
      try {
        const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        if (d.stream_url) { existentes++; continue; }
      } catch (_) {}
    }
    faltantes.push(it);
  }
  return { existentes, total: items.length, faltantes, completo: existentes === items.length && items.length > 0 };
}


function artistsOf(track) {
  if (typeof track.artist === 'string') return track.artist;
  if (track.artists && track.artists.length > 0) {
    return track.artists.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean).join(', ') || 'Unknown';
  }
  if (track.artist?.name) return track.artist.name;
  if (track.album?.artist) {
    return typeof track.album.artist === 'string' ? track.album.artist : (track.album.artist.name || 'Unknown');
  }
  return 'Unknown';
}

function albumOf(track) {
  if (typeof track.album === 'string') return track.album;
  if (track.album?.title) return track.album.title;
  if (track.album?.name) return track.album.name;
  return 'Desconocido';
}

function safeFilename(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'Cancion_Desconocida';
}

/** Ruta relativa del MP3 dentro de canciones_descargas: "Album/Cancion.mp3" (separador /) */
function mp3RelPath(datos) {
  const album = safeFilename(datos.album || 'Desconocido');
  const song = safeFilename(datos.cancion || 'Cancion_Desconocida');
  return `${album}/${song}.mp3`;
}

/** Ruta absoluta del MP3 en disco (carpeta por álbum) */
function mp3AbsPath(datos) {
  return path.join(DIR_DESCARGAS, safeFilename(datos.album || 'Desconocido'), `${safeFilename(datos.cancion || 'Cancion_Desconocida')}.mp3`);
}

/** Comprueba si existe el MP3 (carpeta de álbum o legacy plano en la raíz) */
function resolverMp3Existente(datos, archivoJson) {
  const enAlbum = mp3AbsPath(datos);
  if (fs.existsSync(enAlbum)) return { exists: true, abs: enAlbum, rel: mp3RelPath(datos) };
  // Compatibilidad con descargas antiguas (sin carpeta de álbum)
  const legacyName = (archivoJson || '').replace(/\.json$/i, '.mp3') || `${safeFilename(datos.cancion)}.mp3`;
  const legacy = path.join(DIR_DESCARGAS, legacyName);
  if (fs.existsSync(legacy)) return { exists: true, abs: legacy, rel: legacyName };
  return { exists: false, abs: enAlbum, rel: mp3RelPath(datos) };
}

function fromQueueCandidate(track) {
  const candidates = track.streamCandidates || [];
  const ready = candidates.find((c) => c.stream && c.stream.url && !c.failed);
  if (!ready) return null;
  return {
    videoId: ready.id,
    stream_url: ready.stream.url,
    container: ready.stream.container || 'm4a',
    from: 'queue',
    ytTitle: ready.title,
  };
}

/** Puntúa un resultado de YouTube para preferir audio oficial y evitar intros/outros/live */
/** Normaliza texto para comparar (minúsculas, sin acentos, sin signos) */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens significativos (quita palabras muy cortas / comunes) */
function tokens(s) {
  const stop = new Set(['the', 'a', 'an', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'e', 'o', 'en', 'un', 'una', 'feat', 'ft', 'with', 'official', 'audio', 'video', 'lyrics', 'letra', 'visualizer', 'visualiser']);
  return norm(s).split(' ').filter((w) => w.length > 1 && !stop.has(w));
}

/** Solapamiento de tokens del título de la canción dentro del título de YouTube (0..1) */
function titleOverlap(songTitle, ytTitle) {
  const st = tokens(songTitle);
  if (!st.length) return 0;
  const yt = new Set(tokens(ytTitle));
  let hit = 0;
  for (const w of st) if (yt.has(w)) hit++;
  return hit / st.length;
}

/** ¿El artista principal aparece en el título o canal de YT? */
function artistPresent(artist, ytTitle, channel) {
  const main = norm(String(artist).split(',')[0].split('&')[0].trim());
  if (!main || main.length < 2 || ['unknown', 'desconocido', 'unknown artist'].includes(main)) return true; // sin artista no filtramos
  const haystack = norm(ytTitle) + ' ' + norm(channel || '');
  // coincidencia de todas las palabras del artista principal
  const parts = main.split(' ').filter((w) => w.length > 1);
  if (!parts.length) return haystack.includes(main);
  return parts.every((p) => haystack.includes(p));
}

/**
 * Puntuación estricta. Si no pasa filtros mínimos devuelve -999 (descartar).
 * Requiere: artista presente + al menos 50% de tokens del título de la canción.
 */
function scoreYtHit(hit, artist, title) {
  const ytTitle = String(hit.title || '');
  const channel = String(hit.channel || hit.uploader || '');
  const t = norm(ytTitle);
  const song = norm(title);

  // FILTRO DURO 1: el artista tiene que estar
  if (!artistPresent(artist, ytTitle, channel)) return -999;

  // FILTRO DURO 2: solapamiento de título
  const overlap = titleOverlap(title, ytTitle);
  if (overlap < 0.5) return -999;

  let score = overlap * 100; // base 50..100

  // Bonus si el título de la canción aparece casi completo
  if (t.includes(song) || song.length > 4 && t.includes(song.slice(0, Math.min(song.length, 40)))) score += 40;

  // Preferencias de tipo de vídeo
  if (t.includes('official audio') || t.includes('audio oficial')) score += 45;
  else if (t.includes('official video') || t.includes('video oficial')) score += 25;
  else if (t.includes('visualizer') || t.includes('visualiser')) score += 22;
  else if (t.includes('lyrics') || t.includes('letra')) score += 12;
  else if (/\baudio\b/.test(t)) score += 8;

  // Penalizaciones
  if (/\bintro\b/.test(t)) score -= 100;
  if (/\boutro\b/.test(t)) score -= 100;
  if (/\bteaser\b/.test(t) || /\btrailer\b/.test(t)) score -= 80;
  if (/\blive\b/.test(t) || /\ben vivo\b/.test(t)) score -= 50;
  if (/\bcover\b/.test(t) && !song.includes('cover')) score -= 45;
  if (/\bkaraoke\b/.test(t) || /\breaction\b/.test(t)) score -= 70;
  if (/\bremix\b/.test(t) && !song.includes('remix')) score -= 30;
  if (/\bsped up\b/.test(t) || /\bslowed\b/.test(t) || /\bnightcore\b/.test(t)) score -= 50;
  if (/\b8d\b/.test(t) || /\b1 hour\b/.test(t) || /\bloop\b/.test(t)) score -= 40;
  if (/\binstrumental\b/.test(t) && !song.includes('instrumental')) score -= 35;

  // Duración razonable
  const dur = Number(hit.duration) || 0;
  if (dur > 0) {
    if (dur >= 90 && dur <= 480) score += 12;
    else if (dur < 50) score -= 60;
    else if (dur > 720) score -= 30;
  }

  return score;
}

async function ytdlpSearch(artist, title, max = 10) {
  const cleanTitle = String(title).replace(/"/g, '').trim();
  const mainArtist = String(artist).split(',')[0].split('&')[0].trim();

  // Dos búsquedas cortas: la mayoría de pistas quedan resueltas en la primera.
  const queries = [
    `${mainArtist} ${cleanTitle} official audio`,
    `${mainArtist} ${cleanTitle}`,
  ];

  const run = async (q) => {
    try {
      const { stdout } = await execFileAsync(
        YTDLP_BIN,
        ['--dump-json', '--flat-playlist', '--no-warnings', '--no-check-certificates', `ytsearch${max}:${q}`],
        { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 120000 }
      );
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((x) => x && x.id);
    } catch (e) {
      console.log(`${C.dim}     search error: ${e.message.split('\n')[0]}${C.reset}`);
      return [];
    }
  };

  const seen = new Set();
  const merged = [];
  for (const q of queries) {
    for (const r of await run(q)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    // Si ya tenemos algún resultado con buen score, no hace falta seguir
    const good = merged.filter((h) => scoreYtHit(h, artist, title) >= 70);
    if (good.length >= 2) break;
  }

  // Filtrar descartados (-999) y ordenar
  const ranked = merged
    .map((h) => ({ h, s: scoreYtHit(h, artist, title) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  return ranked.map((x) => x.h);
}



async function ytdlpGetStream(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const { stdout } = await execFileAsync(
    YTDLP_BIN,
    [
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      url,
    ],
    { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 120000 }
  );
  const info = JSON.parse(stdout);
  if (!info.url) throw new Error('yt-dlp sin url');
  return {
    stream_url: info.url,
    container: info.ext || 'm4a',
    codec: info.acodec,
    duration: info.duration,
    title: info.title,
  };
}

function extractYouTubeId(value) {
  const text = String(value || '');
  const match = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/))([\w-]{11})/i);
  return match ? match[1] : (/^[\w-]{11}$/.test(text) ? text : '');
}

async function refrescarArchivoFuente(fileName) {
  const filePath = path.join(DIR_JSON, fileName);
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const title = String(record.cancion || path.basename(fileName, '.json'));
  const artist = String(record.artista || '');
  let videoId = extractYouTubeId(record.videoId) || extractYouTubeId(record.youtube);
  let streamInfo = null;

  if (videoId) {
    try { streamInfo = await ytdlpGetStream(videoId); }
    catch (_) { videoId = ''; }
  }

  if (!streamInfo) {
    const hits = await ytdlpSearch(artist, title, 6);
    for (const hit of hits.slice(0, 2)) {
      try {
        streamInfo = await ytdlpGetStream(hit.id);
        videoId = hit.id;
        record.matchTitle = hit.title;
        break;
      } catch (_) {}
    }
  }
  if (!streamInfo || !streamInfo.stream_url) throw new Error('No se encontró una fuente vigente');

  record.stream_url = streamInfo.stream_url;
  record.videoId = videoId;
  record.youtube = `https://www.youtube.com/watch?v=${videoId}`;
  record.container = streamInfo.container || record.container || 'm4a';
  if (streamInfo.codec) record.codec = streamInfo.codec;
  if (streamInfo.duration) record.duration = streamInfo.duration;
  record.sourceRefreshedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  return title;
}

async function ejecutarRegeneracionFuentes(files) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
    while (cursor < files.length) {
      const fileName = files[cursor++];
      regeneracionFuentes.current = path.basename(fileName, '.json');
      try {
        await refrescarArchivoFuente(fileName);
        regeneracionFuentes.updated++;
      } catch (error) {
        regeneracionFuentes.failed++;
        console.log(`${C.yellow}No se pudo regenerar ${fileName}: ${error.message}${C.reset}`);
      } finally {
        regeneracionFuentes.processed++;
      }
    }
  });
  await Promise.all(workers);
  regeneracionFuentes.current = '';
  regeneracionFuentes.running = false;
}


function guardarArchivoJson(track, tituloCancion, streamUrl, extra = {}) {
  let albumName = albumOf(track);
  let artistName = artistsOf(track);
  let imageUrl = track.artwork?.items?.[0]?.url || track.album?.artwork?.items?.[0]?.url || track.thumbnail || track.image || '';

  if (typeof artistName !== 'string') artistName = 'Desconocido';
  if (typeof albumName !== 'string') albumName = 'Desconocido';

  const nombreSeguro = safeFilename(tituloCancion);
  const nombreArchivo = path.join(DIR_JSON, `${nombreSeguro}.json`);
  const force = !!(extra && extra.force);

  // Si ya existe y tiene stream, NO tocar orden ni sobrescribir (evita desordenar)
  if (fs.existsSync(nombreArchivo) && !force) {
    try {
      const existente = JSON.parse(fs.readFileSync(nombreArchivo, 'utf8'));
      // Solo rellenar stream si faltaba
      if (!existente.stream_url && streamUrl) {
        existente.stream_url = streamUrl;
        if (extra.videoId) existente.videoId = extra.videoId;
        if (extra.matchTitle) existente.matchTitle = extra.matchTitle;
        if (extra.from) existente.from = extra.from;
        delete existente.missing;
        fs.writeFileSync(nombreArchivo, JSON.stringify(existente, null, 2));
        console.log(`${C.green}🔄 Stream añadido (sin tocar orden): ${tituloCancion}${C.reset}`);
      }
      return; // nunca reescribir orden ni metadatos de un archivo ya guardado
    } catch (_) {}
  }

  const datosCancion = {
    cancion: tituloCancion,
    album: albumName,
    artista: artistName,
    imagen: imageUrl,
    stream_url: streamUrl || null,
    ...extra
  };
  delete datosCancion.force;

  fs.writeFile(nombreArchivo, JSON.stringify(datosCancion, null, 2), (err) => {
    if (err) console.error(`${C.red}❌ Error al guardar JSON: ${err.message}${C.reset}`);
    else {
      if (streamUrl) console.log(`${C.green}🎵 Capturado: ${tituloCancion} - ${artistName} [${albumName}]${C.reset}`);
      else console.log(`${C.yellow}⚠ Sin fuente: ${tituloCancion} (puedes cambiarla en el navegador)${C.reset}`);
    }
  });
}

async function resolveOneTrack(item, index, total) {
  const track = item.track || {};
  const title = track.title || 'Unknown';
  const artist = artistsOf(track);
  const n = `${index + 1}/${total}`;
  process.stderr.write(`\n[${n}] ${artist} — ${title}\n`);

  // 1. Intentar del queue (streamCandidates)
  const cached = fromQueueCandidate(track);
  if (cached) {
    process.stderr.write(`  ✓ del queue  yt:${cached.videoId}\n`);
    return {
      index: index + 1,
      artist,
      title,
      videoId: cached.videoId,
      youtube: `https://www.youtube.com/watch?v=${cached.videoId}`,
      stream_url: cached.stream_url,
      container: cached.container,
      from: 'queue',
      track, // para guardar metadata completa
    };
  }

  // 2. Buscar con yt-dlp (filtros estrictos: artista + título)
  process.stderr.write('  → buscando en YouTube (filtros estrictos)...\n');
  const hits = await ytdlpSearch(artist, title, 6);
  if (!hits.length) {
    process.stderr.write('  ✗ sin resultados válidos (ninguno pasó filtros de artista/título)\n');
    return { index: index + 1, artist, title, error: 'no valid matches', track };
  }

  let lastErr = null;
  // Solo los mejores (score ya filtrado > 0); máximo 4 intentos
  for (const hit of hits.slice(0, 2)) {
    const sc = scoreYtHit(hit, artist, title);
    // Umbral mínimo de confianza
    if (sc < 55) {
      process.stderr.write(`  ✗ score bajo (${sc}): ${hit.title}\n`);
      continue;
    }
    process.stderr.write(`  → [score ${Math.round(sc)}] ${hit.title}\n`);
    try {
      const info = await ytdlpGetStream(hit.id);
      process.stderr.write(`  ✓ OK → ${info.container}\n`);
      return {
        index: index + 1,
        artist,
        title,
        videoId: hit.id,
        youtube: `https://www.youtube.com/watch?v=${hit.id}`,
        stream_url: info.stream_url,
        container: info.container,
        from: 'ytdlp',
        matchTitle: hit.title,
        track,
      };
    } catch (e) {
      lastErr = e.message;
      process.stderr.write(`  ✗ falló stream: ${e.message.split('\n')[0]}\n`);
    }
  }

  return {
    index: index + 1,
    artist,
    title,
    error: lastErr || 'no confident match',
    track,
  };
}



/**
 * mode:
 *   'all'     → resuelve/actualiza TODAS las pistas
 *   'missing' → solo las que no tienen JSON/stream aún
 *   'skip'    → no hace nada (marca como resuelto)
 */
async function resolverAlbumCompleto(items, albumName, mode = 'all') {
  if (resolviendoAlbum || regeneracionFuentes.running) {
    console.log(`${C.yellow}⏳ Ya hay una resolución de álbum en curso, se omite...${C.reset}`);
    return { ok: false, reason: 'busy' };
  }

  if (mode === 'skip') {
    albumsResueltos.add(albumName);
    albumPendienteUI = null;
    console.log(`${C.dim}⏭ Álbum omitido por el usuario: ${albumName}${C.reset}`);
    return { ok: true, skipped: true };
  }

  resolviendoAlbum = true;
  albumPendienteUI = null;
  const estado = estadoAlbumEnDisco(albumName, items);
  const aResolver = mode === 'missing' ? estado.faltantes : items;

  console.log(`${C.cyan}📀 Resolviendo álbum "${albumName}" [${mode}] — ${aResolver.length}/${items.length} pistas...${C.reset}`);

  try {
    // Necesitamos el índice original dentro de la cola completa
    const indexMap = new Map();
    items.forEach((it, i) => indexMap.set(it, i));

    const rows = new Array(aResolver.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(3, aResolver.length) }, async () => {
      while (nextIndex < aResolver.length) {
        const i = nextIndex++;
        const item = aResolver[i];
        const originalIndex = indexMap.has(item) ? indexMap.get(item) : i;
        rows[i] = await resolveOneTrack(item, originalIndex, items.length);
      }
    });
    await Promise.all(workers);

    for (const row of rows) {

      if (row.stream_url && row.track) {
        const nombreSeguro = safeFilename(row.title);
        const rutaJson = path.join(DIR_JSON, `${nombreSeguro}.json`);

        if (!fs.existsSync(rutaJson) || mode === 'all') {
          // mode all: actualizar stream pero conservar orden si ya existía
          let ordenFinal = row.index;
          if (fs.existsSync(rutaJson)) {
            try {
              const prev = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
              if (prev.orden != null) ordenFinal = prev.orden;
            } catch (_) {}
          }
          guardarArchivoJson(row.track, row.title, row.stream_url, {
            videoId: row.videoId,
            from: row.from,
            matchTitle: row.matchTitle || null,
            orden: ordenFinal,
            force: mode === 'all'
          });
        } else {
          try {
            const existente = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
            let changed = false;
            if (!existente.stream_url) { existente.stream_url = row.stream_url; changed = true; }
            if (row.videoId && !existente.videoId) { existente.videoId = row.videoId; changed = true; }
            if (existente.orden !== row.index) { existente.orden = row.index; changed = true; }
            if (changed) {
              fs.writeFileSync(rutaJson, JSON.stringify(existente, null, 2));
              console.log(`${C.green}🔄 Actualizado: ${row.title} (#${row.index})${C.reset}`);
            }
          } catch (_) {}
        }
      } else if (row.error || !row.stream_url) {
        console.log(`${C.red}❌ Falló: ${row.artist} - ${row.title}: ${row.error || 'sin stream'}${C.reset}`);
        // Guardar placeholder para que aparezca en el navegador y se pueda "Cambiar fuente"
        if (row.track) {
          const nombreSeguro = safeFilename(row.title);
          const rutaJson = path.join(DIR_JSON, `${nombreSeguro}.json`);
          if (!fs.existsSync(rutaJson)) {
            guardarArchivoJson(row.track, row.title, null, {
              orden: row.index,
              missing: true,
              error: row.error || 'no match'
            });
          }
        }
      }
    }
    albumsResueltos.add(albumName);
    console.log(`${C.green}✅ Álbum "${albumName}" listo (${mode}).${C.reset}`);
    return { ok: true, mode, processed: aResolver.length };
  } catch (e) {
    console.error(`${C.red}Error resolviendo álbum: ${e.message}${C.reset}`);
    return { ok: false, error: e.message };
  } finally {
    resolviendoAlbum = false;
  }
}


// ---------- Vigilante de canciones (ahora con detección de álbum) ----------
let memoria = { cancion: null, video: null, album: null };

function iniciarVigilante() {
  setInterval(() => {
    http.get({ hostname: TARGET_HOST, port: TARGET_PORT, path: `/api/queue?_t=${Date.now()}`, method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data.items || !Array.isArray(data.items) || data.items.length === 0) return;

          const index = data.currentIndex !== undefined ? data.currentIndex : 0;
          const itemActual = data.items[index];
          if (!itemActual || !itemActual.track) return;
          
          const track = itemActual.track;
          const tituloCancion = track.title || 'Desconocido';
          const idUnico = itemActual.id || tituloCancion;
          const albumActual = albumOf(track);
          let streamUrl = '', idVideoActual = 'sin_video';

          // Captura normal de la canción actual (comportamiento original)
          if (Array.isArray(track.streamCandidates)) {
            const candidatoValido = track.streamCandidates.find(c => c.stream && c.stream.url);
            if (candidatoValido) { 
              streamUrl = candidatoValido.stream.url; 
              idVideoActual = candidatoValido.id || 'sin_video'; 
            }
          }

          if (idUnico !== memoria.cancion || (idVideoActual !== memoria.video && idVideoActual !== 'sin_video')) {
            memoria.cancion = idUnico; 
            memoria.video = idVideoActual;

            // NUNCA reescribir canciones que ya existen en disco (evita desordenar el álbum)
            const rutaExistente = path.join(DIR_JSON, `${safeFilename(tituloCancion)}.json`);
            const yaExiste = fs.existsSync(rutaExistente);

            if (streamUrl && !yaExiste) {
              // Solo crear JSON nuevo si no existe; no tocar los que ya están
              const tracksMismo = data.items.filter(it => it.track && albumOf(it.track) === albumActual);
              if (tracksMismo.length <= 1) {
                guardarArchivoJson(track, tituloCancion, streamUrl, { orden: index + 1, videoId: idVideoActual !== 'sin_video' ? idVideoActual : undefined, from: 'queue' });
              }
            }
            // Si ya existe: no hacer nada (ni orden, ni stream, ni ID)
          }

          // ---------- DETECCIÓN DE ÁLBUM ----------
          if (albumActual && albumActual !== 'Desconocido' && !resolviendoAlbum && !regeneracionFuentes.running && !albumsResueltos.has(albumActual)) {
            const tracksMismoAlbum = data.items.filter(it => {
              if (!it.track) return false;
              return albumOf(it.track) === albumActual;
            });

            if (tracksMismoAlbum.length > 1) {
              const estado = estadoAlbumEnDisco(albumActual, tracksMismoAlbum);

              if (estado.completo) {
                // Álbum ya existe completo en disco → no hacer nada, esperar el siguiente
                console.log(`${C.dim}📂 Álbum "${albumActual}" ya existe completo (${estado.existentes}/${estado.total}). Se omite.${C.reset}`);
                albumsResueltos.add(albumActual);
                albumPendienteUI = null;
              } else if (estado.existentes > 0) {
                // Existe parcialmente → dejar que la UI pregunte al usuario
                if (!albumPendienteUI || albumPendienteUI.name !== albumActual) {
                  console.log(`${C.yellow}❓ Álbum "${albumActual}" parcial (${estado.existentes}/${estado.total}). Esperando decisión en la web...${C.reset}`);
                  albumPendienteUI = {
                    name: albumActual,
                    items: tracksMismoAlbum,
                    existentes: estado.existentes,
                    total: estado.total,
                    faltantes: estado.faltantes.length
                  };
                }
              } else {
                // Álbum completamente nuevo → resolver automáticamente todas
                console.log(`${C.cyan}📀 Álbum NUEVO: "${albumActual}" (${tracksMismoAlbum.length} pistas) → resolviendo...${C.reset}`);
                resolverAlbumCompleto(tracksMismoAlbum, albumActual, 'all').catch(e => {
                  console.error(`${C.red}Error en resolución de álbum: ${e.message}${C.reset}`);
                });
              }
            }
          }

        } catch (_) {}
      });
    }).on('error', () => {}); 
  }, 5000);
}

// ---------- Descargas ----------
function isCancelado(idArchivo) {
  return !!(estadoDescargas[idArchivo] && estadoDescargas[idArchivo].cancel);
}

/** Cierra de forma segura streams HTTP / archivo sin lanzar 'write after end' */
function destruirStreamsDescarga(st) {
  if (!st) return;
  const res = st.res;
  const file = st.file;
  if (res) {
    try { res.unpipe && file && res.unpipe(file); } catch (_) {}
    try { res.removeAllListeners('data'); } catch (_) {}
    try { res.destroy(); } catch (_) {}
    st.res = null;
  }
  if (file) {
    try { file.removeAllListeners('error'); } catch (_) {}
    try { file.removeAllListeners('finish'); } catch (_) {}
    // destroy en lugar de close: evita write-after-end si aún llegaba data
    try { file.destroy(); } catch (_) {}
    st.file = null;
  }
  if (st.req) {
    try { st.req.destroy(); } catch (_) {}
    st.req = null;
  }
}

function cancelarDescarga(idArchivo) {
  if (!idArchivo) return false;
  const st = estadoDescargas[idArchivo] || (estadoDescargas[idArchivo] = { porcentaje: 0, estado: 'Cancelado' });
  st.cancel = true;
  st.estado = 'Cancelado';
  destruirStreamsDescarga(st);
  if (st.ffmpeg) {
    try { st.ffmpeg.kill('SIGKILL'); } catch (_) {}
    st.ffmpeg = null;
  }
  console.log(`${C.yellow}⏹ Descarga cancelada: ${idArchivo}${C.reset}`);
  return true;
}

function descargarArchivo(url, rutaDestino, idArchivo, esAudio) {
  return new Promise((resolve, reject) => {
    if (isCancelado(idArchivo)) return reject(new Error('Cancelado'));

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      const st = idArchivo && estadoDescargas[idArchivo];
      if (st) {
        st.req = null;
        st.res = null;
        st.file = null;
      }
      if (err) {
        try { fs.unlinkSync(rutaDestino); } catch (_) {}
        reject(err);
      } else {
        resolve();
      }
    };

    const file = fs.createWriteStream(rutaDestino);
    // Ignorar errores de escritura tras cancelar (write after end / destroy)
    file.on('error', (err) => {
      if (isCancelado(idArchivo) || settled) return;
      done(err);
    });

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 180000 }, (res) => {
      if (settled) {
        res.resume();
        return;
      }
      if (isCancelado(idArchivo)) {
        res.resume();
        try { file.destroy(); } catch (_) {}
        return done(new Error('Cancelado'));
      }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try { file.destroy(); } catch (_) {}
        try { fs.unlinkSync(rutaDestino); } catch (_) {}
        return descargarArchivo(res.headers.location, rutaDestino, idArchivo, esAudio).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        try { file.destroy(); } catch (_) {}
        return done(new Error(`Status ${res.statusCode}`));
      }

      if (idArchivo && estadoDescargas[idArchivo]) {
        estadoDescargas[idArchivo].res = res;
        estadoDescargas[idArchivo].file = file;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let recibido = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        if (isCancelado(idArchivo)) {
          try { res.unpipe(file); } catch (_) {}
          try { res.destroy(); } catch (_) {}
          try { file.destroy(); } catch (_) {}
          return done(new Error('Cancelado'));
        }
        recibido += chunk.length;
        if (esAudio && total && idArchivo && estadoDescargas[idArchivo]) {
          estadoDescargas[idArchivo].porcentaje = Math.floor((recibido / total) * 100);
        }
      });

      res.on('error', (err) => {
        if (settled || isCancelado(idArchivo)) return done(new Error('Cancelado'));
        done(err);
      });

      // No usar pipe ciego: al cancelar unpipe + destroy evita write-after-end
      res.pipe(file);

      file.on('finish', () => {
        if (settled) return;
        if (isCancelado(idArchivo)) return done(new Error('Cancelado'));
        done(null);
      });
    });

    if (idArchivo && estadoDescargas[idArchivo]) estadoDescargas[idArchivo].req = req;

    req.on('error', (err) => {
      if (settled) return;
      try { file.destroy(); } catch (_) {}
      if (isCancelado(idArchivo) || (err && /socket hang up|ECONNRESET|aborted/i.test(String(err.message || err)))) {
        done(new Error('Cancelado'));
      } else {
        done(err);
      }
    });
  });
}

async function procesarDescarga(rutaJsonCompleta, idArchivo) {
  const datos = JSON.parse(fs.readFileSync(rutaJsonCompleta, 'utf8'));
  const nombreSeguro = safeFilename(datos.cancion);
  const albumSeguro = safeFilename(datos.album || 'Desconocido');
  const dirAlbum = path.join(DIR_DESCARGAS, albumSeguro);
  const tempAudio = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.m4a`);
  const tempImg = path.join(DIR_DESCARGAS, `temp_${nombreSeguro}.jpg`);
  const finalMp3 = path.join(dirAlbum, `${nombreSeguro}.mp3`);

  try {
    if (!fs.existsSync(dirAlbum)) fs.mkdirSync(dirAlbum, { recursive: true });

    estadoDescargas[idArchivo] = { porcentaje: 0, estado: 'Descargando...', cancel: false, req: null, ffmpeg: null };
    console.log(`${C.cyan}⬇️ Descargando audio e imagen de: ${datos.cancion} → ${albumSeguro}/...${C.reset}`);
    
    const promesas = [descargarArchivo(datos.stream_url, tempAudio, idArchivo, true)];
    if (datos.imagen) {
      promesas.push(descargarArchivo(datos.imagen, tempImg, idArchivo, false).catch(() => null));
    }
    await Promise.all(promesas);

    if (isCancelado(idArchivo)) throw new Error('Cancelado');

    estadoDescargas[idArchivo].porcentaje = 95;
    estadoDescargas[idArchivo].estado = 'Convirtiendo HQ...';
    estadoDescargas[idArchivo].req = null;
    console.log(`${C.yellow}⚙️ FFmpeg calidad alta (320kbps): ${datos.cancion}...${C.reset}`);
    
    const esc = (s) => String(s || '').replace(/"/g, '\\"');
    // MP3 320kbps CBR + joint stereo = máxima calidad práctica sin pérdidas perceptibles
    // Incluye número de pista (orden) para que el explorador/reproductor ordene correctamente
    const trackNum = Number(datos.orden);
    const trackMeta = Number.isFinite(trackNum) && trackNum > 0 ? ` -metadata track="${trackNum}"` : '';
    const meta = `-id3v2_version 3 -metadata title="${esc(datos.cancion)}" -metadata album="${esc(datos.album)}" -metadata artist="${esc(datos.artista || '')}"${trackMeta}`;
    const audioOpts = `-c:a libmp3lame -b:a 320k -ar 44100 -joint_stereo 1`;
    let cmd;
    if (fs.existsSync(tempImg)) {
      cmd = `ffmpeg -y -i "${tempAudio}" -i "${tempImg}" -map 0:a -map 1:v -c:v mjpeg -vf "scale=600:600:force_original_aspect_ratio=decrease,pad=600:600:(ow-iw)/2:(oh-ih)/2" ${audioOpts} ${meta} "${finalMp3}"`;
    } else {
      cmd = `ffmpeg -y -i "${tempAudio}" ${audioOpts} ${meta} "${finalMp3}"`;
    }
    
    await new Promise((resolve, reject) => {
      // spawn vía shell para poder matar el proceso al cancelar
      const child = spawn(cmd, { shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
      if (estadoDescargas[idArchivo]) estadoDescargas[idArchivo].ffmpeg = child;
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
        if (estadoDescargas[idArchivo]) estadoDescargas[idArchivo].ffmpeg = null;
        if (isCancelado(idArchivo) || signal === 'SIGKILL' || signal === 'SIGTERM') {
          reject(new Error('Cancelado'));
        } else if (code !== 0) {
          reject(new Error(stderr.split('\n').filter(Boolean).pop() || `ffmpeg exit ${code}`));
        } else {
          resolve();
        }
      });
    });

    if (isCancelado(idArchivo)) throw new Error('Cancelado');

    // Limpiar copia legacy plana si existía
    const legacyFlat = path.join(DIR_DESCARGAS, `${nombreSeguro}.mp3`);
    if (legacyFlat !== finalMp3 && fs.existsSync(legacyFlat)) {
      try { fs.unlinkSync(legacyFlat); } catch (_) {}
    }
    
    estadoDescargas[idArchivo] = { porcentaje: 100, estado: '¡Completado!' };
    console.log(`${C.green}✅ MP3 HQ guardado: ${albumSeguro}/${nombreSeguro}.mp3${C.reset}`);
    return { success: true, path: `${albumSeguro}/${nombreSeguro}.mp3` };

  } catch (error) {
    const cancelled = error.message === 'Cancelado' || isCancelado(idArchivo);
    // Borrar MP3 incompleto si se canceló a mitad de conversión
    try { if (fs.existsSync(finalMp3) && cancelled) fs.unlinkSync(finalMp3); } catch (_) {}
    estadoDescargas[idArchivo] = { porcentaje: 0, estado: cancelled ? 'Cancelado' : 'Error' };
    if (cancelled) {
      console.log(`${C.yellow}⏹ Cancelado: ${datos.cancion}${C.reset}`);
      return { success: false, cancelled: true, error: 'Cancelado' };
    }
    console.log(`${C.red}❌ Error en descarga: ${error.message}${C.reset}`);
    return { success: false, error: error.message };
  } finally {
    if (fs.existsSync(tempAudio)) try { fs.unlinkSync(tempAudio); } catch (_) {}
    if (fs.existsSync(tempImg)) try { fs.unlinkSync(tempImg); } catch (_) {}
  }
}

// ---------- Interfaz Web (integrada) ----------
const HTML_UI = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="https://images.emojiterra.com/google/android-11/512px/1f431.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jam Logger</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/app.css?v=3">
  <style>
    :root {
      --bg: #121212;
      --bg-elevated: #181818;
      --surface: #181818;
      --surface-hover: #282828;
      --primary: #1db954;
      --primary-hover: #1ed760;
      --text: #ffffff;
      --text-dim: #b3b3b3;
      --text-muted: #6a6a6a;
      --border: rgba(255,255,255,0.08);
      --row-hover: rgba(255,255,255,0.1);
      --highlight: #2a2a2a;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding-bottom: 100px;
    }

    /* ===== HEADER ===== */
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 32px;
      background: linear-gradient(180deg, #1a1a1a 0%, var(--bg) 100%);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .topbar-left { display: flex; align-items: center; gap: 16px; }
    .logo { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.5px; }
    .logo span { color: var(--primary); }
    .lan-badge {
      font-size: 0.75rem;
      color: var(--text-dim);
      background: var(--surface);
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
    }
    .lan-badge b { color: #fff; }

    /* ===== MAIN CONTENT ===== */
    .main { padding: 0 32px 40px; max-width: 1400px; margin: 0 auto; }

    .section-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 24px 0 20px;
      letter-spacing: -0.3px;
    }

    /* ===== ALBUM GRID (home) ===== */
    .albums-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 24px;
    }

    .album-card {
      background: var(--surface);
      border-radius: 8px;
      padding: 16px;
      transition: background 0.2s ease, transform 0.2s ease;
      cursor: pointer;
      display: flex;
      flex-direction: column;
    }
    .album-card:hover {
      background: var(--surface-hover);
      transform: translateY(-4px);
    }
    .album-card:hover .play-overlay { opacity: 1; transform: translateY(0); }

    .cover-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      margin-bottom: 14px;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .cover-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      background: #282828;
    }
    .play-overlay {
      position: absolute;
      bottom: 10px;
      right: 10px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--primary);
      color: #000;
      border: none;
      font-size: 1.3rem;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.2s ease;
      box-shadow: 0 8px 16px rgba(0,0,0,0.4);
      cursor: pointer;
    }
    .play-overlay:hover { transform: scale(1.08); background: var(--primary-hover); }

    .card-title {
      font-size: 0.95rem;
      font-weight: 700;
      margin: 0 0 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-artist {
      font-size: 0.85rem;
      color: var(--text-dim);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 6px;
    }

    /* ===== ALBUM DETAIL VIEW (Spotify style) ===== */
    #view-detail { display: none; }
    #view-detail.active { display: block; }
    #view-home.hidden { display: none; }

    .album-hero {
      display: flex;
      gap: 28px;
      align-items: flex-end;
      padding: 32px 0 28px;
      background: linear-gradient(180deg, #3a3a3a 0%, var(--bg) 100%);
      margin: 0 -32px;
      padding-left: 32px;
      padding-right: 32px;
      border-radius: 0 0 8px 8px;
    }
    .hero-cover {
      width: 232px;
      height: 232px;
      object-fit: cover;
      border-radius: 6px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      flex-shrink: 0;
      background: #282828;
    }
    .hero-info { flex: 1; min-width: 0; padding-bottom: 8px; }
    .hero-type {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-dim);
      margin-bottom: 8px;
    }
    .hero-title {
      font-size: clamp(1.8rem, 5vw, 3.2rem);
      font-weight: 800;
      margin: 0 0 12px;
      line-height: 1.1;
      letter-spacing: -1px;
    }
    .hero-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
      color: var(--text-dim);
      flex-wrap: wrap;
    }
    .hero-meta .artist-name { color: #fff; font-weight: 600; }
    .hero-meta .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--text-dim); }

    .detail-actions {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 24px 0 12px;
    }
    .btn-play-all {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--primary);
      color: #000;
      border: none;
      font-size: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s;
      box-shadow: 0 4px 16px rgba(29,185,84,0.35);
    }

    .btn-play-all:hover { transform: scale(1.08); background: var(--primary-hover); }
    .btn-download-all {
      width: 48px; height: 48px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
      background: transparent; color: #fff; font-size: 1.2rem;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s;
    }
    .btn-download-all:hover { border-color: #fff; transform: scale(1.06); }
    .track-row.missing { opacity: 0.75; }
    .track-row.missing .track-title::after {
      content: ' · sin fuente';
      color: #e74c3c;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .btn-icon.fix {
      color: #f39c12; border: 1px solid rgba(243,156,18,0.35);
    }
    .btn-icon.fix:hover { background: rgba(243,156,18,0.15); color: #f5b041; }


    .btn-back {
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 0;
      transition: color 0.15s;
    }
    .btn-back:hover { color: #fff; }

    /* Tracklist estilo Spotify */
    .tracklist { margin-top: 4px; }
    .tracklist-header {
      display: grid;
      grid-template-columns: 48px 1fr 140px;
      gap: 12px;
      padding: 0 16px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      font-size: 0.72rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 500;
      margin-bottom: 4px;
    }
    .track-row {
      display: grid;
      grid-template-columns: 48px 1fr 140px;
      gap: 12px;
      align-items: center;
      padding: 8px 16px;
      border-radius: 4px;
      transition: background 0.12s;
      cursor: default;
      border-bottom: 1px solid transparent;
    }
    .track-row:hover { background: rgba(255,255,255,0.08); }
    .track-row:hover .track-num { opacity: 0; }
    .track-row:hover .track-play-btn { opacity: 1; }
    .track-row.playing .track-title { color: var(--primary); }
    .track-row.playing .track-num { color: var(--primary); }

    .track-num-wrap {
      width: 48px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .track-num {
      font-size: 0.95rem;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      font-weight: 500;
      transition: opacity 0.12s;
    }
    .track-play-btn {
      position: absolute;
      opacity: 0;
      background: none;
      border: none;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      padding: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.12s;
    }
    .track-play-btn:hover { transform: scale(1.15); }

    .track-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .track-title {
      font-size: 0.95rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #fff;
      line-height: 1.35;
    }
    .track-artist {
      font-size: 0.8rem;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }

    .track-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      opacity: 0.7;
    }
    .track-row:hover .track-actions { opacity: 1; }
    .btn-icon {
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 0.78rem;
      padding: 6px 12px;
      border-radius: 16px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.15s;
      white-space: nowrap;
      text-decoration: none;
    }
    .btn-icon:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .btn-icon.ready { color: var(--primary); }
    .btn-icon.ready:hover { background: rgba(29,185,84,0.15); color: var(--primary-hover); }


    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: var(--text-dim);
    }
    .empty-state h2 { font-size: 1.4rem; color: #fff; margin-bottom: 8px; }

    /* ===== PLAYER BAR ===== */
    .player-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 90px;
      background: #181818;
      border-top: 1px solid #282828;
      display: flex;
      align-items: center;
      padding: 0 16px;
      z-index: 1000;
      gap: 16px;
    }
    .player-info {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 30%;
      min-width: 180px;
    }
    .player-info img {
      width: 56px;
      height: 56px;
      border-radius: 4px;
      object-fit: cover;
      background: #282828;
    }
    .player-details { min-width: 0; }
    .player-details .p-title {
      font-size: 0.9rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .player-details .p-artist {
      font-size: 0.75rem;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .player-controls {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      max-width: 500px;
    }
    .control-buttons { display: flex; align-items: center; gap: 16px; }
    .btn-circle {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #fff;
      color: #000;
      border: none;
      font-size: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s;
    }
    .btn-circle:hover { transform: scale(1.08); }

    .progress-container {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      font-size: 0.7rem;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
    }
    input[type="range"] {
      -webkit-appearance: none;
      width: 100%;
      height: 4px;
      background: #4d4d4d;
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .progress-container:hover input[type="range"]::-webkit-slider-thumb { opacity: 1; }
    input[type="range"]::-webkit-slider-runnable-track { background: #4d4d4d; border-radius: 2px; }

    .player-volume {
      width: 30%;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .player-volume input { width: 100px; }

    .toast {
      position: fixed;
      bottom: 110px;
      right: 24px;
      background: #282828;
      border: 1px solid #3a3a3a;
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      z-index: 2000;
      font-size: 0.9rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }


    /* Context menu */
    .ctx-menu {
      display: none; position: fixed; z-index: 4000;
      background: #282828; border: 1px solid #3a3a3a; border-radius: 8px;
      padding: 6px 0; min-width: 190px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .ctx-menu.show { display: block; }
    .ctx-item { padding: 10px 16px; font-size: 0.9rem; color: #fff; cursor: pointer; }
    .ctx-item:hover { background: rgba(255,255,255,0.1); }

    .topbar-actions { display: flex; align-items: center; gap: 12px; }
    .btn-regenerate-sources {
      display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      min-height: 40px; padding: 0 16px; border-radius: 22px;
      border: 1px solid rgba(29, 185, 84, .45); background: rgba(29, 185, 84, .12);
      color: #dfffea; font: inherit; font-size: .86rem; font-weight: 650; cursor: pointer;
      transition: background .18s, border-color .18s, transform .18s;
    }
    .btn-regenerate-sources:hover { background: rgba(29, 185, 84, .22); border-color: #1db954; transform: translateY(-1px); }
    .btn-regenerate-sources:disabled { cursor: progress; opacity: .75; transform: none; }
    .btn-regenerate-sources .refresh-icon { font-size: 1.15rem; line-height: 1; }
    .regenerate-status { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: .75rem; }
    .regenerate-status[hidden] { display: none; }
    @media (max-width: 600px) {
      .topbar-actions { gap: 8px; }
      .btn-regenerate-sources { width: 40px; min-width: 40px; padding: 0; }
      .btn-regenerate-sources .regenerate-label { display: none; }
      .regenerate-status { max-width: 90px; }
    }

    .btn-settings {
      width: 40px; height: 40px; border-radius: 50%; border: 1px solid #3a3a3a;
      background: #282828; color: #fff; font-size: 1.15rem; cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: all 0.15s;
    }
    .btn-settings:hover { background: #333; border-color: #555; transform: rotate(25deg); }

    .settings-panel {
      display: none; position: fixed; top: 70px; right: 24px; width: 320px;
      background: #282828; border: 1px solid #3a3a3a; border-radius: 12px;
      padding: 20px; z-index: 3500; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    }
    .settings-panel.show { display: block; }
    .settings-panel h3 { margin: 0 0 16px; font-size: 1rem; }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 14px; gap: 12px;
    }
    .setting-row label { font-size: 0.9rem; color: #ddd; }
    .setting-row small { display: block; color: #888; font-size: 0.75rem; margin-top: 2px; }
    .toggle {
      width: 44px; height: 24px; border-radius: 12px; background: #555;
      position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0;
    }
    .toggle.on { background: #1db954; }
    .toggle::after {
      content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%;
      background: #fff; top: 3px; left: 3px; transition: left 0.2s;
    }
    .toggle.on::after { left: 23px; }
    .setting-row input[type=range] { width: 100px; }

    .src-results { max-height: 320px; overflow-y: auto; margin-top: 12px; }
    .src-item {
      display: flex; gap: 12px; align-items: center; padding: 10px;
      border-radius: 8px; cursor: pointer; transition: background 0.12s;
    }
    .src-item:hover { background: rgba(255,255,255,0.08); }
    .src-item img { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; background: #111; flex-shrink: 0; }
    .src-item .src-info { min-width: 0; flex: 1; }
    .src-item .src-title { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .src-item .src-meta { font-size: 0.75rem; color: #aaa; }
    .modal-input {
      width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #3a3a3a;
      background: #1a1a1a; color: #fff; font-size: 0.9rem; outline: none; margin-bottom: 10px;
      box-sizing: border-box;
    }
    .modal-input:focus { border-color: #1db954; }

    /* Modal decisión de álbum */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 3000;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    }
    .modal-overlay.show { display: flex; }
    .modal-box {
      background: #282828;
      border-radius: 12px;
      padding: 28px 32px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 16px 48px rgba(0,0,0,0.5);
      border: 1px solid #3a3a3a;
    }
    .modal-box h3 {
      margin: 0 0 8px;
      font-size: 1.2rem;
      font-weight: 700;
    }
    .modal-box p {
      color: var(--text-dim);
      font-size: 0.9rem;
      margin: 0 0 20px;
      line-height: 1.45;
    }
    .modal-box .modal-album-name {
      color: #fff;
      font-weight: 600;
    }
    .modal-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .modal-btn {
      padding: 12px 16px;
      border-radius: 8px;
      border: none;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.15s;
      text-align: left;
    }
    .modal-btn.primary { background: var(--primary); color: #000; }
    .modal-btn.primary:hover { background: var(--primary-hover); }
    .modal-btn.secondary { background: rgba(255,255,255,0.1); color: #fff; }
    .modal-btn.secondary:hover { background: rgba(255,255,255,0.16); }
    .modal-btn.ghost { background: transparent; color: var(--text-dim); border: 1px solid #3a3a3a; }
    .modal-btn.ghost:hover { color: #fff; border-color: #555; }
    .modal-btn small { display: block; font-weight: 400; font-size: 0.75rem; opacity: 0.7; margin-top: 2px; }

    /* Refined settings, centered playback controls, and circular download progress. */
    @media (min-width: 769px) {
      .player-bar {
        display: grid;
        grid-template-columns: minmax(0,1fr) minmax(360px,min(48vw,720px)) minmax(0,1fr);
        gap: clamp(14px,2vw,30px);
      }
      .player-info { width: auto; min-width: 0; }
      .player-controls { width: 100%; max-width: none; justify-self: center; }
      .player-volume { width: auto; min-width: 140px; justify-content: flex-end; }
    }
    .tracklist-header, .track-row { grid-template-columns: 56px minmax(0,1fr) 150px; column-gap: 26px; }
    .tracklist { margin-top: 22px; }
    .tracklist-header { padding: 18px 22px 14px; margin-bottom: 12px; }
    .tracklist-header > :nth-child(2) { padding-left: 14px; }
    .track-main { padding-left: 12px; }
    .track-row { min-height: 66px; margin: 6px 0; border-radius: 12px; }
    .settings-panel {
      width: min(390px,calc(100vw - 24px)); max-height: calc(100vh - 90px); overflow: auto;
      padding: 22px; border-radius: 20px; border: 1px solid var(--border);
      background: color-mix(in srgb,var(--bg-elevated) 92%,transparent);
      box-shadow: 0 24px 70px rgba(0,0,0,.52); backdrop-filter: blur(24px);
    }
    .settings-panel h3 { font-size: 1.2rem; letter-spacing: -.03em; }
    .settings-section-title { margin: 17px 0 7px; color: var(--primary); font-size: .68rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .settings-divider { height: 1px; margin: 15px 0; background: var(--border); }
    .settings-panel .setting-row { min-height: 45px; padding: 7px 0; margin: 0; }
    .settings-panel .setting-row label { color: var(--text); font-weight: 650; }
    .settings-panel .setting-row small { max-width: 245px; line-height: 1.4; }
    .settings-panel select, .settings-panel input[type="range"] { accent-color: var(--primary); }
    .settings-panel select { min-height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); }
    .setting-range-control { display: flex; align-items: center; gap: 9px; flex: 0 0 auto; }
    .setting-range-control input[type="range"] { width: 92px !important; }
    .range-value { min-width: 42px; padding: 6px 8px; border: 1px solid color-mix(in srgb,var(--primary) 30%,var(--border)); border-radius: 9px; background: color-mix(in srgb,var(--primary) 11%,var(--surface)); color: var(--primary); text-align: center; font-size: .76rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .timer-controls { display: flex; align-items: center; gap: 8px; }
    .timer-button { min-height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--primary); color: #101114; font-weight: 700; cursor: pointer; }
    .theme-grid { gap: 8px; margin-bottom: 12px; }
    .theme-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); }
    .theme-card { min-height: 42px; display: flex; align-items: center; gap: 9px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface); color: var(--text-dim); font-size: .82rem; font-weight: 650; cursor: pointer; transition: border-color .18s ease,background .18s ease,color .18s ease; }
    .theme-card:hover, .theme-card.active { border-color: var(--primary); background: color-mix(in srgb,var(--primary) 9%,var(--surface)); color: var(--text); }
    .theme-swatch { width: 22px; height: 16px; flex: 0 0 22px; border-radius: 5px; }
    .theme-swatch.sp { background: linear-gradient(135deg,#121212 50%,#1db954 50%); }
    .theme-swatch.ap { background: linear-gradient(135deg,#100b10 50%,#fa315d 50%); }
    .theme-swatch.lt { background: linear-gradient(135deg,#f4f5f7 50%,#24764b 50%); border: 1px solid var(--border); }
    .toggle { width: 42px; height: 24px; border-radius: 999px; background: #494d54; }
    .toggle.on { background: var(--primary); }
    .toggle::after { width: 18px; height: 18px; top: 3px; left: 3px; }
    .toggle.on::after { left: 21px; }
    .download-progress-control { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--text); cursor: pointer; transition: transform .18s ease,background .18s ease; }
    .download-progress-control:hover:not(:disabled) { transform: scale(1.08); background: color-mix(in srgb,var(--primary) 12%,transparent); }
    .download-progress-control:active:not(:disabled) { transform: scale(.94); }
    .download-progress-control:disabled { cursor: progress; opacity: 1; }
    .download-progress-ring { --download-progress: 0%; position: relative; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; background: conic-gradient(var(--primary) var(--download-progress),rgba(255,255,255,.12) 0); transition: background .2s linear; }
    .download-progress-ring::before { content: ''; position: absolute; inset: 2px; border-radius: inherit; background: var(--surface); }
    .download-progress-icon, .download-progress-value { position: relative; z-index: 1; }
    .download-progress-icon { font-size: 1rem; line-height: 1; }
    .download-progress-value { display: none; font-size: .57rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .download-progress-control.is-downloading .download-progress-icon { display: none; }
    .download-progress-control.is-downloading .download-progress-value { display: block; }
    .download-progress-control.is-complete .download-progress-icon { color: var(--primary); }
    .btn-cancel-dl {
      display: none;
      width: 36px; height: 36px; border-radius: 50%;
      border: 1px solid rgba(231,76,60,0.45);
      background: rgba(231,76,60,0.12);
      color: #e74c3c; font-size: 0.95rem; font-weight: 700;
      align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s; padding: 0; flex-shrink: 0;
    }
    .btn-cancel-dl:hover { background: rgba(231,76,60,0.28); border-color: #e74c3c; transform: scale(1.08); }
    .btn-cancel-dl.visible { display: inline-flex; }
    .btn-cancel-dl.album-cancel { width: 48px; height: 48px; font-size: 1.15rem; }
    @media (max-width: 768px) {
      .tracklist-header { display: none; }
      .track-row { grid-template-columns: 40px minmax(0,1fr) 48px; column-gap: 10px; }
      .track-main { padding-left: 4px; }
      .player-bar { display: flex; }
    }
    body.compact-player .player-bar { height: 72px; }
    body.compact-player .player-info img { width: 44px; height: 44px; }
    body.compact-player { padding-bottom: 82px; }
    body.reduce-motion *, body.reduce-motion *::before, body.reduce-motion *::after { animation: none !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }


    @media (max-width: 768px) {
      .topbar { padding: 12px 16px; }
      .main { padding: 0 16px 40px; }
      .albums-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }
      .album-hero { flex-direction: column; align-items: center; text-align: center; gap: 16px; padding: 24px 16px; margin: 0 -16px; }
      .hero-cover { width: 180px; height: 180px; }
      .hero-title { font-size: 1.6rem; }
      .hero-meta { justify-content: center; }
      .tracklist-header { display: none; }
      .track-row { grid-template-columns: 36px 1fr 90px; padding: 10px 8px; }
      .player-bar { height: auto; flex-wrap: wrap; padding: 10px 12px; gap: 8px; }
      .player-info { width: 100%; }
      .player-controls { width: 100%; max-width: none; }
      .player-volume { display: none; }
      body { padding-bottom: 140px; }
    }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="topbar-left">
      <div class="logo">Jam <span>Logger</span></div>
      <div class="lan-badge">📡 <b>http://${LAN_IP}:${LISTEN_PORT}</b></div>
    </div>
    <div class="topbar-actions">
      <button class="btn-regenerate-sources" id="btn-regenerate-sources" type="button" onclick="regenerarFuentes()" title="Renueva los enlaces de audio caducados">
        <span class="refresh-icon" aria-hidden="true">↻</span><span class="regenerate-label" id="regenerate-label">Regenerar fuentes</span>
      </button>
      <span class="regenerate-status" id="regenerate-status" role="status" aria-live="polite" hidden></span>
      <button class="btn-settings" id="btn-settings" title="Configuración" onclick="toggleSettings()">⚙</button>
    </div>
  </div>

  <div class="settings-panel" id="settings-panel">
    <h3>⚙ Configuración</h3>
    <div style="margin-bottom:8px;font-size:0.8rem;color:var(--text-dim,#aaa);font-weight:600">Diseño</div>
    <div class="theme-grid">
      <div class="theme-card active" data-theme-pick="spotify" onclick="setTheme('spotify')">
        <div class="theme-swatch sp"></div>
        Spotify
      </div>
      <div class="theme-card" data-theme-pick="apple" onclick="setTheme('apple')">
        <div class="theme-swatch ap"></div>
        Apple Music
      </div>
      <div class="theme-card" data-theme-pick="lite" onclick="setTheme('lite')">
        <div class="theme-swatch lt"></div>
        Lite
      </div>
    </div>
    <div class="setting-row">
      <div>
        <label>Crossfade (transición)</label>
        <small>Une las canciones como Spotify</small>
      </div>
      <div class="toggle" id="toggle-crossfade" onclick="toggleCrossfade()"></div>
    </div>
    <div class="setting-row setting-range-row">
      <div>
        <label>Duración del crossfade</label>
        <small id="cf-label">Transición gradual antes del final</small>
      </div>
      <div class="setting-range-control">
        <input type="range" id="cf-duration" min="1" max="12" value="4" aria-label="Duración del crossfade en segundos" oninput="updateCfLabel()">
        <output class="range-value" id="cf-value" for="cf-duration" aria-live="polite">4 s</output>
      </div>
    </div>
    <div class="setting-row">
      <div>
        <label>Reproducir siguiente al terminar</label>
        <small>Auto-play de la lista del álbum</small>
      </div>
      <div class="toggle on" id="toggle-autoplay" onclick="toggleAutoplay()"></div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section-title">Audio</div>
    <div class="setting-row">
      <div><label>Velocidad</label><small id="speed-label">1×</small></div>
      <input type="range" id="playback-speed" min="0.75" max="1.5" step="0.05" value="1" oninput="updatePlaybackSpeed()">
    </div>
    <div class="setting-row setting-timer-row">
      <div><label>Temporizador</label><small id="sleep-label">Detener la música tras un tiempo</small></div>
      <div class="timer-controls"><select id="sleep-minutes" aria-label="Duración del temporizador"><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select><button class="timer-button" id="sleep-button" type="button" onclick="toggleSleepTimer()">Iniciar</button></div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section-title">Interfaz y accesibilidad</div>
    <div class="setting-row"><div><label>Atajos de teclado</label><small>Espacio: play · flechas: buscar y volumen</small></div><div class="toggle" id="toggle-shortcuts" role="switch" tabindex="0" aria-checked="false" onclick="toggleShortcuts()"></div></div>
    <div class="setting-row"><div><label>Reproductor compacto</label><small>Reduce la barra inferior</small></div><div class="toggle" id="toggle-compact" role="switch" tabindex="0" aria-checked="false" onclick="toggleCompactPlayer()"></div></div>
    <div class="setting-row"><div><label>Reducir animaciones</label><small>Interfaz más tranquila</small></div><div class="toggle" id="toggle-motion" role="switch" tabindex="0" aria-checked="false" onclick="toggleReducedMotion()"></div></div>
  </div>

  <div class="main">
    <!-- HOME: grid de álbumes -->
    <div id="view-home">
      <h2 class="section-title">Tus álbumes</h2>
      <div id="contenedor-albumes">
        <div class="empty-state">
          <h2>Aún no hay música</h2>
          <p>Reproduce algo en Nuclear. La captura es automática.</p>
        </div>
      </div>
    </div>

    <!-- DETAIL: vista de álbum estilo Spotify -->
    <div id="view-detail">
      <button class="btn-back" onclick="cerrarAlbum()">← Volver a álbumes</button>
      <div class="album-hero" id="detail-hero"></div>
      <div class="detail-actions" id="detail-actions"></div>
      <div class="tracklist">
        <div class="tracklist-header">
          <div>#</div>
          <div>Título</div>
          <div style="text-align:right">Descarga</div>
        </div>

        <div id="detail-tracks"></div>
      </div>
    </div>
  </div>

  <!-- PLAYER -->
  <div class="player-bar">
    <div class="player-info">
      <img id="np-cover" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="">
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
      <span style="font-size:0.9rem;color:var(--text-dim)">🔈</span>
      <input type="range" id="vol-bar" value="100" max="100">
    </div>
    <audio id="main-player" style="display:none"></audio>
  </div>

  <div class="toast" id="toast"></div>

  <!-- Modal: álbum ya existe parcialmente -->
  <div class="modal-overlay" id="album-modal">
    <div class="modal-box">
      <h3>📀 Álbum detectado</h3>
      <p>
        <span class="modal-album-name" id="modal-album-name">—</span><br>
        Ya tienes <b id="modal-existentes">0</b> de <b id="modal-total">0</b> canciones.
        ¿Qué quieres hacer?
      </p>
      <div class="modal-actions">
        <button class="modal-btn primary" onclick="decidirAlbum('all')">
          Actualizar todas
          <small>Vuelve a buscar streams de todas las pistas</small>
        </button>
        <button class="modal-btn secondary" onclick="decidirAlbum('missing')">
          Solo las que faltan
          <small>Resuelve únicamente las canciones nuevas</small>
        </button>
        <button class="modal-btn ghost" onclick="decidirAlbum('skip')">
          No hacer nada
          <small>Ignorar este álbum y seguir escuchando</small>
        </button>
      </div>
    </div>
  </div>


  <div class="ctx-menu" id="ctx-menu">
    <div class="ctx-item" onclick="abrirCambiarFuente()">🔄 Cambiar fuente</div>
    <div class="ctx-item" onclick="reproducirDesdeCtx()">▶ Reproducir</div>
  </div>

  <div class="modal-overlay" id="source-modal">
    <div class="modal-box" style="max-width:480px">
      <h3>🔄 Cambiar fuente</h3>
      <p style="margin-bottom:12px">Canción: <span class="modal-album-name" id="src-song-name">—</span></p>
      <input class="modal-input" id="src-query" placeholder="Buscar en YouTube o pegar URL de YouTube..." onkeydown="if(event.key==='Enter')buscarFuentes()">
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="modal-btn primary" style="flex:1;text-align:center" onclick="buscarFuentes()">🔍 Buscar</button>
        <button class="modal-btn ghost" style="flex:1;text-align:center" onclick="cerrarSourceModal()">Cancelar</button>
      </div>
      <div class="src-results" id="src-results"></div>
    </div>
  </div>

  <script>

    const audio = document.getElementById('main-player');
    const playPauseBtn = document.getElementById('btn-play-pause');
    const seekBar = document.getElementById('seek-bar');
    const volBar = document.getElementById('vol-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');

    let cancionesAnteriores = '';
    let cancionesCargando = false;
    let gruposCache = {};   // { albumName: [tracks...] }
    let albumActual = null;

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.opacity = 1;
      setTimeout(() => t.style.opacity = 0, 2800);
    }

    function formatTime(sec) {
      if (isNaN(sec)) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' + s : s);
    }

    async function regenerarFuentes() {
      const button = document.getElementById('btn-regenerate-sources');
      const label = document.getElementById('regenerate-label');
      const status = document.getElementById('regenerate-status');
      if (!button || button.disabled) return;
      button.disabled = true;
      status.hidden = false;
      label.textContent = 'Preparando…';
      status.textContent = 'Conectando';
      try {
        const start = await fetch('/api/regenerate-sources', { method: 'POST' });
        const initial = await start.json();
        if (!start.ok) throw new Error(initial.error || 'No se pudo iniciar');
        if (initial.total === 0) {
          label.textContent = 'Regenerar fuentes';
          status.textContent = 'No hay canciones';
          return;
        }
        let state = { running: true, total: initial.total, processed: 0, updated: 0, failed: 0 };
        while (state.running) {
          const response = await fetch('/api/regenerate-progress', { cache: 'no-store' });
          if (!response.ok) throw new Error('No se pudo leer el progreso');
          state = await response.json();
          const pct = state.total ? Math.round(state.processed * 100 / state.total) : 100;
          label.textContent = 'Renovando ' + state.processed + '/' + state.total;
          status.textContent = pct + '% · ' + (state.current || 'Procesando');
          if (state.running) await new Promise(resolve => setTimeout(resolve, 650));
        }
        label.textContent = 'Regenerar fuentes';
        status.textContent = state.updated + ' actualizadas · ' + state.failed + ' con error';
        cancionesAnteriores = '';
        await cargarCanciones();
        showToast('Fuentes renovadas: ' + state.updated + ' · errores: ' + state.failed);
      } catch (error) {
        label.textContent = 'Regenerar fuentes';
        status.textContent = error.message || 'Error al renovar';
        showToast('No se pudieron regenerar las fuentes');
      } finally {
        button.disabled = false;
      }
    }

    // ===== Ajustes (localStorage) =====
    let crossfadeOn = localStorage.getItem('cf_on') === '1';
    let autoplayOn = localStorage.getItem('ap_on') !== '0';
    let cfSeconds = Number(localStorage.getItem('cf_sec') || 4);
    let playbackSpeed = Number(localStorage.getItem('playback_speed') || 1);
    let shortcutsOn = localStorage.getItem('shortcuts_on') === '1';
    let compactPlayerOn = localStorage.getItem('compact_player') === '1';
    let reduceMotionOn = localStorage.getItem('reduce_motion') === '1';
    let sleepTimerId = null;
    let crossfadeStarted = false;
    let playlistActual = []; // pistas del álbum abierto
    let playlistIndex = -1;
    let ctxTrack = null; // pista del menú contextual

    // Audio secundario para crossfade
    const audioB = new Audio();
    audioB.preload = 'auto';

    function applyToggleUI() {
      document.getElementById('toggle-crossfade').classList.toggle('on', crossfadeOn);
      document.getElementById('toggle-autoplay').classList.toggle('on', autoplayOn);
      document.getElementById('cf-duration').value = cfSeconds;
      document.getElementById('cf-value').textContent = cfSeconds + ' s';
      document.getElementById('toggle-shortcuts').classList.toggle('on', shortcutsOn);
      document.getElementById('toggle-shortcuts').setAttribute('aria-checked', String(shortcutsOn));
      document.getElementById('toggle-compact').classList.toggle('on', compactPlayerOn);
      document.getElementById('toggle-compact').setAttribute('aria-checked', String(compactPlayerOn));
      document.getElementById('toggle-motion').classList.toggle('on', reduceMotionOn);
      document.getElementById('toggle-motion').setAttribute('aria-checked', String(reduceMotionOn));
      document.getElementById('playback-speed').value = playbackSpeed;
      document.getElementById('speed-label').textContent = playbackSpeed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '×';
      document.getElementById('sleep-label').textContent = sleepTimerId ? 'El temporizador está activo' : 'Detener la música tras un tiempo';
      document.getElementById('sleep-button').textContent = sleepTimerId ? 'Cancelar' : 'Iniciar';
      document.body.classList.toggle('compact-player', compactPlayerOn);
      document.body.classList.toggle('reduce-motion', reduceMotionOn);
    }
    function setTheme(theme) {
      const palettes = {
        spotify: ['#121212','#181818','#181818','#282828','#1db954','#1ed760','#ffffff','#b3b3b3','#6a6a6a'],
        apple: ['#100b10','#1a141a','#1a141a','#30232d','#fa315d','#ff5a78','#ffffff','#c5bac2','#847681'],
        lite: ['#f4f5f7','#ffffff','#ffffff','#e8ebef','#24764b','#329765','#17191c','#525961','#737b84']
      };
      if (!palettes[theme]) theme = 'spotify';
      const names = ['--bg','--bg-elevated','--surface','--surface-hover','--primary','--primary-hover','--text','--text-dim','--text-muted'];
      names.forEach((name, i) => document.documentElement.style.setProperty(name, palettes[theme][i]));
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('jam_theme', theme);
      document.querySelectorAll('.theme-card').forEach(card => card.classList.toggle('active', card.dataset.themePick === theme));
    }
    function toggleSettings() {
      const panel = document.getElementById('settings-panel');
      panel.classList.toggle('show');
      document.getElementById('btn-settings').setAttribute('aria-expanded', String(panel.classList.contains('show')));
      applyToggleUI();
    }
    function toggleCrossfade() {
      crossfadeOn = !crossfadeOn;
      localStorage.setItem('cf_on', crossfadeOn ? '1' : '0');
      applyToggleUI();
    }
    function toggleAutoplay() {
      autoplayOn = !autoplayOn;
      localStorage.setItem('ap_on', autoplayOn ? '1' : '0');
      applyToggleUI();
    }
    function updateCfLabel() {
      cfSeconds = Number(document.getElementById('cf-duration').value);
      localStorage.setItem('cf_sec', String(cfSeconds));
      document.getElementById('cf-value').textContent = cfSeconds + ' s';
    }
    function updatePlaybackSpeed() {
      playbackSpeed = Number(document.getElementById('playback-speed').value);
      localStorage.setItem('playback_speed', String(playbackSpeed));
      audio.playbackRate = playbackSpeed;
      audioB.playbackRate = playbackSpeed;
      document.getElementById('speed-label').textContent = playbackSpeed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '×';
    }
    function toggleSleepTimer() {
      const button = document.getElementById('sleep-button');
      if (sleepTimerId) {
        clearTimeout(sleepTimerId); sleepTimerId = null;
        showToast('Temporizador cancelado');
      } else {
        const minutes = Number(document.getElementById('sleep-minutes').value) || 15;
        sleepTimerId = setTimeout(() => {
          audio.pause(); audioB.pause(); sleepTimerId = null; applyToggleUI();
          showToast('Temporizador: música detenida');
        }, minutes * 60 * 1000);
        showToast('La música se detendrá en ' + minutes + ' min');
      }
      button.textContent = sleepTimerId ? 'Cancelar' : 'Iniciar';
      document.getElementById('sleep-label').textContent = sleepTimerId ? 'El temporizador está activo' : 'Detener la música tras un tiempo';
    }
    function toggleShortcuts() { shortcutsOn = !shortcutsOn; localStorage.setItem('shortcuts_on', shortcutsOn ? '1' : '0'); applyToggleUI(); }
    function toggleCompactPlayer() { compactPlayerOn = !compactPlayerOn; localStorage.setItem('compact_player', compactPlayerOn ? '1' : '0'); applyToggleUI(); }
    function toggleReducedMotion() { reduceMotionOn = !reduceMotionOn; localStorage.setItem('reduce_motion', reduceMotionOn ? '1' : '0'); applyToggleUI(); }
    document.addEventListener('keydown', (event) => {
      if (!shortcutsOn || event.ctrlKey || event.altKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.code === 'Space' && event.target.closest('button,a,[role="switch"]')) return;
      if (event.code === 'Space') { event.preventDefault(); playPauseBtn.click(); }
      else if (event.code === 'ArrowLeft' && audio.duration) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
      else if (event.code === 'ArrowRight' && audio.duration) { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
      else if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault(); volBar.value = String(Math.max(0, Math.min(100, Number(volBar.value) + (event.code === 'ArrowUp' ? 5 : -5))));
        audio.volume = Number(volBar.value) / 100; localStorage.setItem('jam_volume', volBar.value);
      }
    });
    document.querySelectorAll('.toggle[role="switch"]').forEach(toggle => toggle.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle.click(); }
    }));
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('settings-panel');
      const btn = document.getElementById('btn-settings');
      if (panel.classList.contains('show') && !panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('show');
      }
      const ctx = document.getElementById('ctx-menu');
      if (ctx.classList.contains('show') && !ctx.contains(e.target)) ctx.classList.remove('show');
    });

    function setNowPlaying(title, artist, cover) {
      document.getElementById('np-title').innerText = title;
      document.getElementById('np-artist').innerText = artist;
      document.getElementById('np-cover').src = cover || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
      playPauseBtn.innerText = '⏸';
    }

    function playAudio(url, title, artist, cover, fromIndex) {
      if (!url) { showToast('⚠️ Sin stream disponible'); return; }
      crossfadeStarted = false;
      try { audioB.pause(); audioB.removeAttribute('src'); } catch(_){}
      audio.volume = volBar.value / 100;
      audio.playbackRate = playbackSpeed;
      audio.src = url;
      audio.play().catch(() => showToast('⚠️ Error reproduciendo'));
      setNowPlaying(title, artist, cover);
      if (typeof fromIndex === 'number') playlistIndex = fromIndex;
      // marcar fila playing
      document.querySelectorAll('.track-row.playing').forEach(el => el.classList.remove('playing'));
      const row = document.querySelector('.track-row[data-idx="' + playlistIndex + '"]');
      if (row) row.classList.add('playing');
    }

    function mp3Url(c) {
      if (!c) return '';
      // mp3Rel = "Album/Cancion.mp3" (nuevo) o "Cancion.mp3" (legacy)
      const rel = c.mp3Rel || (c.archivo ? c.archivo.replace(/\.json$/i, '.mp3') : '');
      if (!rel) return '';
      return '/canciones/' + rel.split('/').map(encodeURIComponent).join('/');
    }
    function getPlayLink(c) {
      if (!c) return '';
      if (c.hasMp3) return mp3Url(c);
      return c.stream_url || '';
    }

    function playAtIndex(i) {
      if (!playlistActual.length || i < 0 || i >= playlistActual.length) return;
      const c = playlistActual[i];
      const link = getPlayLink(c);
      const cover = c.imagen || '';
      playAudio(link, c.cancion, c.artista || 'Desconocido', cover, i);
    }

    function playNext() {
      if (!autoplayOn) return;
      if (playlistIndex < 0 || !playlistActual.length) return;
      const next = playlistIndex + 1;
      if (next < playlistActual.length) playAtIndex(next);
    }

    /** Crossfade suave hacia la siguiente canción */
    function startCrossfade() {
      if (crossfadeStarted || !crossfadeOn || !autoplayOn) return;
      if (playlistIndex < 0 || playlistIndex >= playlistActual.length - 1) return;
      const nextTrack = playlistActual[playlistIndex + 1];
      const nextUrl = getPlayLink(nextTrack);
      if (!nextUrl) return;
      crossfadeStarted = true;

      const dur = Math.max(1, cfSeconds);
      audioB.volume = 0;
      audioB.playbackRate = playbackSpeed;
      audioB.src = nextUrl;
      const p = audioB.play();
      if (p && p.catch) p.catch(() => {});

      const steps = 30;
      const interval = (dur * 1000) / steps;
      let step = 0;
      const baseVol = volBar.value / 100;
      const timer = setInterval(() => {
        step++;
        const t = step / steps;
        audio.volume = baseVol * (1 - t);
        audioB.volume = baseVol * t;
        if (step >= steps) {
          clearInterval(timer);
          // swap: pasar audioB a audio principal
          const title = nextTrack.cancion;
          const artist = nextTrack.artista || 'Desconocido';
          const cover = nextTrack.imagen || '';
          audio.pause();
          audio.src = audioB.src;
          audio.currentTime = audioB.currentTime;
          audio.volume = baseVol;
          audio.play().catch(() => {});
          audioB.pause();
          audioB.removeAttribute('src');
          playlistIndex = playlistIndex + 1;
          setNowPlaying(title, artist, cover);
          crossfadeStarted = false;
          document.querySelectorAll('.track-row.playing').forEach(el => el.classList.remove('playing'));
          const row = document.querySelector('.track-row[data-idx="' + playlistIndex + '"]');
          if (row) row.classList.add('playing');
        }
      }, interval);
    }

    playPauseBtn.onclick = () => {
      if (audio.paused && audio.src) { audio.play(); playPauseBtn.innerText = '⏸'; }
      else if (!audio.paused) { audio.pause(); playPauseBtn.innerText = '▶'; }
    };
    audio.ontimeupdate = () => {
      if (audio.duration) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
        timeCurrent.innerText = formatTime(audio.currentTime);
        timeTotal.innerText = formatTime(audio.duration);
        // Iniciar crossfade cerca del final
        if (crossfadeOn && autoplayOn && !crossfadeStarted && audio.duration - audio.currentTime <= cfSeconds + 0.3) {
          startCrossfade();
        }
      }
    };
    seekBar.oninput = () => { if (audio.duration) audio.currentTime = (seekBar.value / 100) * audio.duration; };
    volBar.oninput = () => { audio.volume = volBar.value / 100; localStorage.setItem('jam_volume', volBar.value); };
    audio.onended = () => {
      if (crossfadeStarted) return; // el crossfade ya maneja el cambio
      playPauseBtn.innerText = '▶';
      seekBar.value = 0;
      timeCurrent.innerText = '0:00';
      playNext();
    };

    // ===== Menú contextual (clic derecho) =====
    function onTrackContext(e, trackObj) {
      e.preventDefault();
      e.stopPropagation();
      ctxTrack = trackObj;
      const menu = document.getElementById('ctx-menu');
      menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
      menu.classList.add('show');
    }
    function reproducirDesdeCtx() {
      document.getElementById('ctx-menu').classList.remove('show');
      if (!ctxTrack) return;
      const link = getPlayLink(ctxTrack.c);
      playAudio(link, ctxTrack.c.cancion, ctxTrack.c.artista || 'Desconocido', ctxTrack.c.imagen || '', ctxTrack.idx);
    }
    function abrirCambiarFuente() {
      document.getElementById('ctx-menu').classList.remove('show');
      if (!ctxTrack) return;
      document.getElementById('src-song-name').textContent = ctxTrack.c.cancion;
      document.getElementById('src-query').value = (ctxTrack.c.artista || '') + ' ' + (ctxTrack.c.cancion || '');
      document.getElementById('src-results').innerHTML = '';
      document.getElementById('source-modal').classList.add('show');
    }
    function cerrarSourceModal() {
      document.getElementById('source-modal').classList.remove('show');
    }
    function fmtDur(s) {
      s = Number(s) || 0;
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }
    async function buscarFuentes() {
      const q = document.getElementById('src-query').value.trim();
      if (!q) return;
      const box = document.getElementById('src-results');
      box.innerHTML = '<p style="color:#aaa;text-align:center">Buscando...</p>';

      // Si es URL de YouTube directa
      var ytId = null;
      var markers = ['v=', 'youtu.be/', '/shorts/'];
      for (var mi = 0; mi < markers.length; mi++) {
        var pos = q.indexOf(markers[mi]);
        if (pos >= 0) {
          var cand = q.slice(pos + markers[mi].length, pos + markers[mi].length + 11);
          if (/^[a-zA-Z0-9_-]{11}$/.test(cand)) { ytId = cand; break; }
        }
      }
      if (ytId) {
        await aplicarFuente({ id: ytId, title: 'URL manual', channel: '' });
        return;
      }

      try {
        const res = await fetch('/api/search-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q })
        });
        const data = await res.json();
        if (!data.results || !data.results.length) {
          box.innerHTML = '<p style="color:#aaa;text-align:center">Sin resultados</p>';
          return;
        }
        box.innerHTML = data.results.map(function(r) {
          var payload = JSON.stringify({ id: r.id, title: r.title, channel: r.channel });
          return '<div class="src-item" data-payload="' + payload.replace(/"/g, '&quot;') + '" onclick="aplicarFuente(JSON.parse(this.getAttribute(\\'data-payload\\')))">'
            + '<img src="' + (r.thumb || '') + '" alt="">'
            + '<div class="src-info">'
            + '<div class="src-title">' + (r.title || '').replace(/</g, '&lt;') + '</div>'
            + '<div class="src-meta">' + (r.channel || '') + ' · ' + fmtDur(r.duration) + '</div>'
            + '</div></div>';
        }).join('');
      } catch (e) {
        box.innerHTML = '<p style="color:#e74c3c;text-align:center">Error de búsqueda</p>';
      }
    }
    async function aplicarFuente(item) {
      if (!ctxTrack || !ctxTrack.c || !ctxTrack.c.archivo) return;
      showToast('⏳ Aplicando fuente...');
      try {
        const res = await fetch('/api/change-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            archivo: ctxTrack.c.archivo,
            videoId: item.id,
            matchTitle: item.title
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✅ Fuente actualizada');
          cerrarSourceModal();
          cancionesAnteriores = '';
          await cargarCanciones();
          // si estamos en ese álbum, refrescar detalle
          if (albumActual) abrirAlbum(albumActual);
        } else {
          showToast('❌ ' + (data.error || 'Error'));
        }
      } catch (_) {
        showToast('❌ Error de red');
      }
    }


    let albumDownloadAbort = false;

    async function cancelarDescargaUI(archivo) {
      try {
        await fetch('/api/download-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivo })
        });
        showToast('Descarga cancelada');
      } catch (_) {
        showToast('No se pudo cancelar');
      }
      const cancelBtn = document.querySelector('.btn-cancel-dl[data-cancel-archivo="' + archivo + '"]');
      if (cancelBtn) cancelBtn.classList.remove('visible');
      const dlBtn = document.querySelector('.download-progress-control[data-archivo="' + archivo + '"]');
      if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.classList.remove('is-downloading', 'is-complete');
        dlBtn.setAttribute('aria-label', 'Descargar MP3');
        const icon = dlBtn.querySelector('.download-progress-icon');
        if (icon) { icon.style.display = ''; icon.textContent = '↓'; }
        const ring = dlBtn.querySelector('.download-progress-ring');
        if (ring) { ring.style.setProperty('--download-progress', '0%'); ring.setAttribute('aria-valuenow', '0'); }
        const percent = dlBtn.querySelector('.download-progress-value');
        if (percent) percent.textContent = '0%';
      }
    }

    async function cancelarAlbumDescarga() {
      albumDownloadAbort = true;
      try {
        await fetch('/api/download-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true })
        });
      } catch (_) {}
      showToast('Descargas del álbum canceladas');
    }

    async function descargarAlbumActual() {
      if (!albumActual || !gruposCache[albumActual]) return;
      if (albumDownloadAbort === false && document.querySelector('.btn-download-all.is-downloading')) return;
      const pistas = gruposCache[albumActual];
      const pendientes = pistas.filter(c => !c.hasMp3 && c.stream_url);
      const sinFuente = pistas.filter(c => !c.stream_url && !c.hasMp3);
      if (sinFuente.length) showToast(sinFuente.length + ' pistas sin fuente disponible');
      if (!pendientes.length) {
        if (pistas.every(c => c.hasMp3)) showToast('Todo el álbum ya está descargado');
        return;
      }
      albumDownloadAbort = false;
      const albumButton = document.querySelector('.btn-download-all');
      const albumRing = albumButton && albumButton.querySelector('.download-progress-ring');
      const albumPercent = albumButton && albumButton.querySelector('.download-progress-value');
      const albumCancel = document.getElementById('btn-cancel-album-dl');
      if (albumButton) { albumButton.disabled = true; albumButton.classList.add('is-downloading'); }
      if (albumCancel) albumCancel.classList.add('visible');
      showToast('Descargando ' + pendientes.length + ' canciones...');
      let completadas = 0;
      let canceladas = 0;
      for (let i = 0; i < pendientes.length; i++) {
        if (albumDownloadAbort) {
          canceladas += pendientes.length - i;
          break;
        }
        const c = pendientes[i];
        const rowButton = Array.from(document.querySelectorAll('.download-progress-control[data-archivo]')).find(button => button.dataset.archivo === c.archivo);
        const ok = await iniciarFFmpeg(c.archivo, rowButton, false, true);
        if (ok) completadas++;
        else if (albumDownloadAbort) canceladas++;
        const pct = Math.round(((i + 1) / pendientes.length) * 100);
        if (albumRing) { albumRing.style.setProperty('--download-progress', pct + '%'); albumRing.setAttribute('aria-valuenow', String(pct)); }
        if (albumPercent) albumPercent.textContent = pct + '%';
      }
      if (albumButton) { albumButton.disabled = false; albumButton.classList.remove('is-downloading'); }
      if (albumCancel) albumCancel.classList.remove('visible');
      if (albumRing) { albumRing.style.setProperty('--download-progress', '0%'); albumRing.setAttribute('aria-valuenow', '0'); }
      if (albumPercent) albumPercent.textContent = '0%';
      albumDownloadAbort = false;
      cancionesAnteriores = '';
      await cargarCanciones();
      if (albumActual) abrirAlbum(albumActual);
      if (canceladas) showToast('Cancelado · ' + completadas + ' descargadas de ' + pendientes.length);
      else showToast(completadas + ' de ' + pendientes.length + ' descargas listas');
    }
    // ---------- Navegación ----------
    function abrirAlbum(albumName) {
      const pistas = gruposCache[albumName];
      if (!pistas || !pistas.length) return;
      albumActual = albumName;

      const primera = pistas[0];
      const cover = primera.imagen || '';
      const artista = primera.artista || 'Desconocido';

      // Hero
      document.getElementById('detail-hero').innerHTML = \`
        <img class="hero-cover" src="\${cover}" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='" alt="">
        <div class="hero-info">
          <div class="hero-type">Álbum</div>
          <h1 class="hero-title">\${albumName}</h1>
          <div class="hero-meta">
            <span class="artist-name">\${artista}</span>
            <span class="dot"></span>
            <span>\${pistas.length} canción\${pistas.length !== 1 ? 'es' : ''}</span>
          </div>
        </div>
      \`;

      // Play all + descarga (estilo Spotify)
      const firstPlayable = pistas.find(c => c.stream_url || c.hasMp3);
      let actionsHtml = '';
      if (firstPlayable) {
        actionsHtml += \`<button class="btn-play-all" title="Reproducir" onclick="playFirstOfAlbum()">▶</button>\`;
      }
      actionsHtml += \`<button class="btn-download-all download-progress-control" title="Descargar álbum" aria-label="Descargar álbum" onclick="descargarAlbumActual()"><span class="download-progress-ring" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="download-progress-icon" aria-hidden="true">↓</span><span class="download-progress-value">0%</span></span></button>\`;
      actionsHtml += \`<button class="btn-cancel-dl album-cancel" id="btn-cancel-album-dl" type="button" title="Cancelar descargas" aria-label="Cancelar descargas del álbum" onclick="cancelarAlbumDescarga()">✕</button>\`;
      document.getElementById('detail-actions').innerHTML = actionsHtml;

      // Playlist para autoplay / crossfade
      playlistActual = pistas.slice();
      playlistIndex = -1;

      // Tracks
      let rows = '';
      pistas.forEach((c, idx) => {
        const num = c.orden || (idx + 1);
        const enlaceMp3 = mp3Url(c);
        const playLink = c.hasMp3 ? enlaceMp3 : (c.stream_url || '');
        const safeTitle = (c.cancion || '').replace(/'/g, "\\\\'");
        const safeArtist = (c.artista || 'Desconocido').replace(/'/g, "\\\\'");
        const safeCover = (c.imagen || cover).replace(/'/g, "\\\\'");
        const isMissing = !c.stream_url && !c.hasMp3;

        let actionHtml = '';
        if (isMissing) {
          actionHtml = \`<button class="btn-icon fix" onclick="event.stopPropagation(); ctxTrack={c: playlistActual[\${idx}], idx: \${idx}}; abrirCambiarFuente();">Cambiar fuente</button>\`;
        } else if (c.hasMp3) {
          actionHtml = \`<a class="btn-icon ready" href="\${enlaceMp3}" download="\${c.cancion}.mp3" onclick="event.stopPropagation()">⬇</a>\`;
        } else {
          actionHtml = \`<button class="btn-icon download-progress-control" data-archivo="\${c.archivo}" title="Descargar MP3" aria-label="Descargar \${c.cancion}" onclick="event.stopPropagation(); iniciarFFmpeg('\${c.archivo}', this)"><span class="download-progress-ring" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="download-progress-icon" aria-hidden="true">↓</span><span class="download-progress-value">0%</span></span></button><button class="btn-cancel-dl" data-cancel-archivo="\${c.archivo}" type="button" title="Cancelar descarga" aria-label="Cancelar descarga" onclick="event.stopPropagation(); cancelarDescargaUI('\${c.archivo}')">✕</button>\`;
        }

        const missingClass = isMissing ? ' missing' : '';
        const playHandler = isMissing
          ? \`event.stopPropagation(); ctxTrack={c: playlistActual[\${idx}], idx: \${idx}}; abrirCambiarFuente();\`
          : \`event.stopPropagation(); playAudio('\${playLink}', '\${safeTitle}', '\${safeArtist}', '\${safeCover}', \${idx})\`;

        rows += \`
          <div class="track-row\${missingClass}" data-idx="\${idx}" ondblclick="\${isMissing ? 'ctxTrack={c: playlistActual[' + idx + '], idx: ' + idx + '}; abrirCambiarFuente();' : 'playAudio(\\'' + playLink + '\\', \\'' + safeTitle + '\\', \\'' + safeArtist + '\\', \\'' + safeCover + '\\', ' + idx + ')'}" oncontextmenu="onTrackContext(event, {c: playlistActual[\${idx}], idx: \${idx}})">
            <div class="track-num-wrap">
              <span class="track-num">\${num}</span>
              <button class="track-play-btn" onclick="\${playHandler}">\${isMissing ? '⚠' : '▶'}</button>
            </div>
            <div class="track-main">
              <div class="track-title">\${c.cancion}</div>
              <div class="track-artist">\${c.artista || 'Desconocido'}</div>
            </div>
            <div class="track-actions">\${actionHtml}</div>
          </div>
        \`;
      });
      document.getElementById('detail-tracks').innerHTML = rows;

      document.getElementById('view-home').classList.add('hidden');
      document.getElementById('view-detail').classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function cerrarAlbum() {
      albumActual = null;
      document.getElementById('view-detail').classList.remove('active');
      document.getElementById('view-home').classList.remove('hidden');
    }

    function playFirstOfAlbum() {
      if (!albumActual || !gruposCache[albumActual]) return;
      const pistas = gruposCache[albumActual];
      const c = pistas.find(t => t.stream_url || t.hasMp3);
      if (!c) return;
      const playLink = getPlayLink(c);
      playAudio(playLink, c.cancion, c.artista || 'Desconocido', c.imagen || '');
    }

    // ---------- Carga de datos ----------
    async function cargarCanciones() {
      if (cancionesCargando) return;
      cancionesCargando = true;
      try {
        const res = await fetch('/api/songs', { cache: 'no-store' });
        if (!res.ok) throw new Error('No se pudo cargar la biblioteca');
        const canciones = await res.json();

        const estadoActual = JSON.stringify(canciones);
        if (estadoActual === cancionesAnteriores) return;
        cancionesAnteriores = estadoActual;

        const contenedor = document.getElementById('contenedor-albumes');
        if (!canciones.length) {
          contenedor.innerHTML = '<div class="empty-state"><h2>Aún no hay música</h2><p>Reproduce algo en Nuclear. La captura es automática.</p></div>';
          gruposCache = {};
          return;
        }

        // Agrupar
        const grupos = {};
        canciones.forEach(c => {
          const name = c.album || 'Desconocido';
          if (!grupos[name]) grupos[name] = [];
          grupos[name].push(c);
        });
        // Ordenar pistas de cada álbum
        for (const k in grupos) {
          grupos[k].sort((a, b) => (Number(a.orden) || 9999) - (Number(b.orden) || 9999));
        }
        gruposCache = grupos;

        // Si estamos dentro de un álbum, refrescar la lista
        if (albumActual && grupos[albumActual]) {
          abrirAlbum(albumActual);
        }

        // Render grid
        let html = '<div class="albums-grid">';
        for (const album in grupos) {
          const pistas = grupos[album];
          const primera = pistas[0];
          const cover = primera.imagen || '';
          const artista = primera.artista || 'Desconocido';
          const safeAlbum = album.replace(/'/g, "\\\\'");

          html += \`
            <div class="album-card" onclick="abrirAlbum('\${safeAlbum}')">
              <div class="cover-wrap">
                <img src="\${cover}" alt="" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='">
                <button class="play-overlay" onclick="event.stopPropagation(); abrirAlbum('\${safeAlbum}'); setTimeout(playFirstOfAlbum, 50)">▶</button>
              </div>
              <div class="card-title">\${album}</div>
              <div class="card-artist">\${artista}</div>
              <div class="card-meta">\${pistas.length === 1 ? 'Single · 1 canción' : (pistas.length + ' canciones')}</div>
            </div>
          \`;
        }
        html += '</div>';
        contenedor.innerHTML = html;
      } catch (e) {
        console.error(e);
      } finally {
        cancionesCargando = false;
      }
    }

    async function iniciarFFmpeg(archivo, btn, refresh = true, quiet = false) {
      const original = btn ? btn.innerHTML : '';
      const ring = btn && btn.querySelector('.download-progress-ring');
      const percent = btn && btn.querySelector('.download-progress-value');
      const cancelBtn = document.querySelector('.btn-cancel-dl[data-cancel-archivo="' + archivo + '"]');
      if (btn) { btn.disabled = true; btn.classList.add('is-downloading'); btn.classList.remove('is-complete'); }
      if (cancelBtn) cancelBtn.classList.add('visible');
      const intervalo = setInterval(async () => {
        try {
          const res = await fetch('/api/progress?archivo=' + encodeURIComponent(archivo));
          const data = await res.json();
          if (data.estado === 'Cancelado') return;
          if (data.estado !== 'Inactivo' && btn) {
            const pct = Math.max(0, Math.min(100, Math.round(Number(data.porcentaje) || 0)));
            if (ring) { ring.style.setProperty('--download-progress', pct + '%'); ring.setAttribute('aria-valuenow', String(pct)); }
            if (percent) percent.textContent = pct + '%';
            btn.setAttribute('aria-label', 'Descargando ' + pct + '%');
          }
        } catch (_) {}
      }, 600);
      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivo })
        });
        const data = await res.json();
        if (data.success) {
          if (btn) {
            if (ring) { ring.style.setProperty('--download-progress', '100%'); ring.setAttribute('aria-valuenow', '100'); }
            btn.classList.remove('is-downloading'); btn.classList.add('is-complete');
            btn.setAttribute('aria-label', 'Descarga completada');
            const icon = btn.querySelector('.download-progress-icon');
            if (icon) icon.textContent = '✓';
            if (percent) percent.textContent = '100%';
          }
          if (cancelBtn) cancelBtn.classList.remove('visible');
          if (!quiet) showToast('MP3 listo');
          if (refresh) { cancionesAnteriores = ''; await cargarCanciones(); }
          return true;
        } else {
          const cancelled = !!(data.cancelled || data.error === 'Cancelado');
          if (!quiet && !cancelled) showToast(data.error || 'Error al descargar');
          if (cancelled && !quiet) showToast('Descarga cancelada');
          if (btn) { btn.innerHTML = original; btn.classList.remove('is-downloading','is-complete'); btn.disabled = false; btn.setAttribute('aria-label', 'Descargar MP3'); }
          if (cancelBtn) cancelBtn.classList.remove('visible');
          return false;
        }
      } catch (_) {
        if (!quiet) showToast('Error de red');
        if (btn) { btn.innerHTML = original; btn.classList.remove('is-downloading','is-complete'); btn.disabled = false; btn.setAttribute('aria-label', 'Descargar MP3'); }
        if (cancelBtn) cancelBtn.classList.remove('visible');
        return false;
      } finally { clearInterval(intervalo); }
    }
    // ---------- Modal de álbum pendiente ----------
    let modalMostradoPara = null;
    let albumPendienteConsultando = false;

    async function chequearAlbumPendiente() {
      if (albumPendienteConsultando) return;
      albumPendienteConsultando = true;
      try {
        const res = await fetch('/api/album-pending', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const modal = document.getElementById('album-modal');

        if (data.name && data.name !== modalMostradoPara && !data.busy) {
          modalMostradoPara = data.name;
          document.getElementById('modal-album-name').textContent = data.name;
          document.getElementById('modal-existentes').textContent = data.existentes;
          document.getElementById('modal-total').textContent = data.total;
          modal.classList.add('show');
        } else if (!data.name) {
          modal.classList.remove('show');
          modalMostradoPara = null;
        }
      } catch (_) {
      } finally {
        albumPendienteConsultando = false;
      }
    }

    async function decidirAlbum(mode) {
      const modal = document.getElementById('album-modal');
      modal.classList.remove('show');
      const labels = { all: 'Actualizando todas...', missing: 'Resolviendo faltantes...', skip: 'Omitido' };
      showToast(labels[mode] || 'Procesando...');

      try {
        const res = await fetch('/api/album-resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (data.ok) {
          if (mode === 'skip') showToast('⏭ Álbum omitido');
          else showToast('✅ Álbum procesado');
          cancionesAnteriores = '';
          cargarCanciones();
        } else {
          showToast('❌ ' + (data.error || 'Error'));
        }
      } catch (_) {
        showToast('❌ Error de red');
      }
      modalMostradoPara = null;
    }

    volBar.value = localStorage.getItem('jam_volume') || '100';
    audio.volume = Number(volBar.value) / 100;
    audio.playbackRate = playbackSpeed;
    audioB.playbackRate = playbackSpeed;
    setTheme(localStorage.getItem('jam_theme') || 'spotify');
    applyToggleUI();
    cargarCanciones();
    chequearAlbumPendiente();
    setInterval(() => { if (!document.hidden) cargarCanciones(); }, 10000);
    setInterval(() => { if (!document.hidden) chequearAlbumPendiente(); }, 10000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        cargarCanciones();
        chequearAlbumPendiente();
      }
    });
  </script>

  <script src="/public/app.js?v=3" defer></script>
</body>
</html>
`;
// ---------- SERVIDOR ÚNICO (proxy + UI + APIs) en puerto 4121 ----------
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${LISTEN_PORT}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  // --- Endpoints de intercepción del plugin ---
  if (pathname === '/__intercept/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getLogsSince(urlObj.searchParams.get('since') || '0')));
    return;
  }
  if (pathname === '/__intercept/clear' && req.method === 'POST') {
    clearLogs();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- UI y APIs propias ---
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(HTML_UI);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/public/')) {
    try {
      const raw = decodeURIComponent(pathname.slice('/public/'.length)).replace(/\\/g, '/');
      const parts = raw.split('/').filter((p) => p && p !== '.' && p !== '..');
      const root = path.resolve(__dirname, 'public');
      const filePath = path.resolve(root, ...parts);
      // Windows-safe: comprobar que queda dentro de public/
      const relCheck = path.relative(root, filePath);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found: ' + parts.join('/'));
      }
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/canciones/')) {
    const fileName = pathname.replace('/canciones/', '');
    // Permite subcarpetas de álbum: "Album/Cancion.mp3"
    const safePath = path.normalize(path.join(DIR_DESCARGAS, fileName));
    const rootNorm = path.normalize(DIR_DESCARGAS + path.sep);
    
    if (!safePath.startsWith(rootNorm) && safePath !== path.normalize(DIR_DESCARGAS)) {
      res.writeHead(403); return res.end();
    }
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      res.writeHead(404); return res.end();
    }
    
    const stat = fs.statSync(safePath);
    res.writeHead(200, { 
      'Content-Length': stat.size, 
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/songs') {
    try {
      if (!global.__songsCache) global.__songsCache = { key: '', payload: '[]' };
      let key = '';
      try {
        const files = fs.readdirSync(DIR_JSON).filter((f) => f.endsWith('.json'));
        let maxM = 0;
        for (const f of files) {
          try { maxM = Math.max(maxM, fs.statSync(path.join(DIR_JSON, f)).mtimeMs); } catch (_) {}
        }
        let dlKey = 0;
        try {
          // Recorre carpetas de álbum + raíz (legacy)
          const walkMp3 = (dir) => {
            for (const f of fs.readdirSync(dir)) {
              const full = path.join(dir, f);
              try {
                const st = fs.statSync(full);
                if (st.isDirectory()) walkMp3(full);
                else if (f.endsWith('.mp3')) dlKey = Math.max(dlKey, st.mtimeMs);
              } catch (_) {}
            }
          };
          walkMp3(DIR_DESCARGAS);
        } catch (_) {}
        key = files.length + ':' + maxM + ':' + dlKey;
      } catch (_) { key = String(Date.now()); }

      if (global.__songsCache.key === key && global.__songsCache.payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(global.__songsCache.payload);
        return;
      }

      const archivos = fs.readdirSync(DIR_JSON).filter((f) => f.endsWith('.json'));
      const canciones = archivos.map((archivo) => {
        try {
          const rutaCompleta = path.join(DIR_JSON, archivo);
          const datos = JSON.parse(fs.readFileSync(rutaCompleta, 'utf8'));
          const mp3Info = resolverMp3Existente(datos, archivo);
          return { archivo, hasMp3: mp3Info.exists, mp3Rel: mp3Info.rel, ...datos };
        } catch (_) { return null; }
      }).filter(Boolean);

      canciones.sort((a, b) => {
        const alb = (a.album || '').localeCompare(b.album || '');
        if (alb !== 0) return alb;
        const oa = Number(a.orden) || 9999;
        const ob = Number(b.orden) || 9999;
        if (oa !== ob) return oa - ob;
        return (a.cancion || '').localeCompare(b.cancion || '');
      });

      const payload = JSON.stringify(canciones);
      global.__songsCache = { key, payload };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(payload);
    } catch(e) { 
      res.writeHead(500); 
      res.end('[]'); 
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/progress') {
    const archivo = urlObj.searchParams.get('archivo');
    const raw = estadoDescargas[archivo];
    // Solo campos serializables (evitar req/ffmpeg → circular JSON)
    const estado = raw
      ? { porcentaje: Number(raw.porcentaje) || 0, estado: raw.estado || 'Inactivo', cancel: !!raw.cancel }
      : { porcentaje: 0, estado: 'Inactivo' };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(estado));
    return;
  }


  if (req.method === 'GET' && pathname === '/api/downloads-active') {
    const active = {};
    for (const [k, v] of Object.entries(estadoDescargas || {})) {
      if (!v) continue;
      if (v.estado && v.estado !== 'Inactivo' && v.estado !== '¡Completado!' && v.estado !== 'Error' && v.estado !== 'Cancelado') {
        active[k] = { porcentaje: Number(v.porcentaje) || 0, estado: v.estado, cancel: !!v.cancel };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ active }));
    return;
  }

  // Estado de álbum pendiente de decisión del usuario
  if (req.method === 'GET' && pathname === '/api/regenerate-progress') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(regeneracionFuentes));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/regenerate-sources') {
    if (regeneracionFuentes.running || resolviendoAlbum) {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Ya hay una resolución en curso' }));
      return;
    }
    let files = [];
    try {
      files = fs.readdirSync(DIR_JSON).filter(name => name.toLowerCase().endsWith('.json'));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'No se pudo leer la biblioteca' }));
      return;
    }
    regeneracionFuentes = { running: true, total: files.length, processed: 0, updated: 0, failed: 0, current: '' };
    res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, total: files.length }));
    if (files.length) setImmediate(() => ejecutarRegeneracionFuentes(files).catch(error => {
      console.error('Error al regenerar las fuentes:', error);
      regeneracionFuentes.current = '';
      regeneracionFuentes.running = false;
    }));
    else regeneracionFuentes.running = false;
    return;
  }

  if (req.method === 'GET' && pathname === '/api/album-pending') {
    const p = albumPendienteUI
      ? { name: albumPendienteUI.name, existentes: albumPendienteUI.existentes, total: albumPendienteUI.total, faltantes: albumPendienteUI.faltantes, busy: resolviendoAlbum }
      : { name: null, busy: resolviendoAlbum };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(p));
    return;
  }

  // Decisión del usuario: actualizar todas / solo faltantes / omitir
  if (req.method === 'POST' && pathname === '/api/album-resolve') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const mode = payload.mode; // 'all' | 'missing' | 'skip'
        if (!['all', 'missing', 'skip'].includes(mode)) throw new Error('mode inválido');
        if (!albumPendienteUI) throw new Error('No hay álbum pendiente');

        const { name, items } = albumPendienteUI;
        const result = await resolverAlbumCompleto(items, name, mode);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/download-cancel') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        // archivo concreto o "all" para cancelar todas
        if (payload.all) {
          let n = 0;
          for (const id of Object.keys(estadoDescargas)) {
            if (cancelarDescarga(id)) n++;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, cancelled: n }));
          return;
        }
        if (!payload.archivo) throw new Error('archivo requerido');
        const ok = cancelarDescarga(payload.archivo);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok, cancelled: ok }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/download') {

    let body = ''; 
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.archivo || !payload.archivo.endsWith('.json')) throw new Error('Archivo inválido');
        const rutaJson = path.join(DIR_JSON, payload.archivo);
        if (!fs.existsSync(rutaJson)) throw new Error('El archivo JSON no existe');
        // Si ya había una descarga de este archivo, no reiniciar cancel flag a ciegas
        const resultado = await procesarDescarga(rutaJson, payload.archivo);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); 
        res.end(JSON.stringify(resultado));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); 
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }


  // Buscar fuentes alternativas en YouTube (sin filtros estrictos)
  if (req.method === 'POST' && pathname === '/api/search-sources') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const q = String(payload.query || '').trim();
        if (!q) throw new Error('query vacía');
        const { stdout } = await execFileAsync(
          YTDLP_BIN,
          ['--dump-json', '--flat-playlist', '--no-warnings', '--no-check-certificates', `ytsearch8:${q}`],
          { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 90000 }
        );
        const results = stdout.split('\n').filter(Boolean).map((line) => {
          try {
            const j = JSON.parse(line);
            return {
              id: j.id,
              title: j.title,
              channel: j.channel || j.uploader || '',
              duration: j.duration || 0,
              url: `https://www.youtube.com/watch?v=${j.id}`,
              thumb: (j.thumbnails && j.thumbnails[0] && j.thumbnails[0].url) || `https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`
            };
          } catch { return null; }
        }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ results }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message, results: [] }));
      }
    });
    return;
  }

  // Cambiar la fuente (stream) de una canción concreta
  if (req.method === 'POST' && pathname === '/api/change-source') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.archivo || !payload.archivo.endsWith('.json')) throw new Error('archivo inválido');
        const rutaJson = path.join(DIR_JSON, payload.archivo);
        if (!fs.existsSync(rutaJson)) throw new Error('JSON no existe');

        let videoId = payload.videoId || '';
        let streamUrl = payload.stream_url || '';

        if (payload.youtubeUrl && !videoId) {
          const yu = String(payload.youtubeUrl);
          for (const mk of ['v=', 'youtu.be/', '/shorts/']) {
            const p = yu.indexOf(mk);
            if (p >= 0) {
              const cand = yu.slice(p + mk.length, p + mk.length + 11);
              if (/^[a-zA-Z0-9_-]{11}$/.test(cand)) { videoId = cand; break; }
            }
          }
        }

        if (videoId && !streamUrl) {
          const info = await ytdlpGetStream(videoId);
          streamUrl = info.stream_url;
        }
        if (!streamUrl) throw new Error('No se pudo obtener stream');

        const datos = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
        const ordenPrev = datos.orden; // preservar orden siempre
        datos.stream_url = streamUrl;
        if (videoId) {
          datos.videoId = videoId;
          datos.youtube = `https://www.youtube.com/watch?v=${videoId}`;
        }
        if (payload.matchTitle) datos.matchTitle = payload.matchTitle;
        datos.from = 'manual';
        delete datos.missing;
        delete datos.error;
        if (ordenPrev != null) datos.orden = ordenPrev;
        // Borrar MP3 previo (carpeta de álbum o legacy plano) para forzar re-descarga
        const mp3Info = resolverMp3Existente(datos, payload.archivo);
        if (mp3Info.exists) try { fs.unlinkSync(mp3Info.abs); } catch (_) {}

        fs.writeFileSync(rutaJson, JSON.stringify(datos, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, stream_url: streamUrl, videoId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // --- Proxy hacia Nuclear (4120) para todo lo demás ---
  const chunks = []; 
  let reqSize = 0;
  req.on('data', (c) => { 
    reqSize += c.length; 
    if (reqSize > MAX_MEMORY_LIMIT) { req.destroy(); return; } 
    chunks.push(c); 
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    delete headers['transfer-encoding']; 
    delete headers['content-length']; 

    // Log de la petición
    pushLog({
      dir: 'request',
      method: req.method,
      url: req.url,
      summary: `${req.method} ${pathname}`
    });

    const upstream = http.request({ 
      host: TARGET_HOST, 
      port: TARGET_PORT, 
      method: req.method, 
      path: req.url, 
      headers 
    }, (upRes) => {
      // Log de la respuesta
      pushLog({
        dir: 'response',
        method: req.method,
        status: upRes.statusCode,
        url: req.url,
        summary: `${upRes.statusCode} ${pathname}`
      });

      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.on('data', (chunk) => { res.write(chunk); });
      upRes.on('end', () => { res.end(); });
    });
    upstream.on('error', (err) => { 
      pushLog({ dir: 'error', summary: err.message, url: req.url });
      if (!res.headersSent) res.writeHead(502); 
      res.end('Bad gateway'); 
    });
    upstream.end(body);
  });
});

// ---------- ARRANQUE ----------
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.green}🚀 Jam Logger (Proxy + UI + Álbum Resolver)${C.reset}`);
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.cyan}📡 Puerto único: http://127.0.0.1:${LISTEN_PORT}${C.reset}`);
  console.log(`${C.cyan}📡 Proxy hacia Nuclear: ${TARGET_HOST}:${TARGET_PORT}${C.reset}`);
  console.log(`${C.yellow}🖥️  Interfaz web: http://127.0.0.1:${LISTEN_PORT}${C.reset}`);
  console.log(`${C.yellow}🌐 Interfaz LAN:  http://${LAN_IP}:${LISTEN_PORT}${C.reset}`);
  console.log(`${C.dim}========================================${C.reset}`);
  console.log(`${C.dim}• Captura automática de canciones (vigilante cada 5s)${C.reset}`);
  console.log(`${C.dim}• Resolución de ÁLBUM completo con yt-dlp SOLO cuando se detectan ≥2 pistas del mismo álbum${C.reset}`);
  console.log(`${C.dim}• No hace falta abrir el navegador para capturar${C.reset}`);
  console.log(`${C.dim}========================================${C.reset}\n`);
  iniciarVigilante();
});

process.on('SIGINT', () => {
  console.log('\nCerrando jam-logger...');
  process.exit(0);
});
