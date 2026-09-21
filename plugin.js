const CATEGORY = 'MCP Logs';
const WIDGET_ID = 'mcp-logs';
const MAX_LOCAL = 300; // entradas que se conservan en el panel
const MAX_LINE = 300; // largo máximo de cada línea copiada al visor de logs

// ---- React (opcional) ----
let React = null;
try {
  React = require('react');
} catch (_) {
  React = null;
}

// ---- Estado compartido entre el poller y el widget ----
const store = { entries: [], error: '', listeners: new Set() };
function notify() {
  store.listeners.forEach((l) => l());
}

let apiRef = null;
let running = false;
let timer = null;
let lastSeq = 0;
let lastErrorShown = '';

async function getBase() {
  const raw = await apiRef.Settings.get('proxyUrl');
  return String(raw || 'http://127.0.0.1:4120').replace(/\/+$/, '');
}

function arrowFor(dir) {
  if (dir === 'request') return '→';
  if (dir === 'sse') return '⇢';
  if (dir === 'error') return '✖';
  return '←';
}

function lineFor(e) {
  const parts = [`#${e.id}`, arrowFor(e.dir)];
  if (e.method) parts.push(e.method);
  if (e.status) parts.push(String(e.status));
  
  // Mejorar la visualización del resumen para logs más útiles
  const summaryText = e.summary || e.url || '';
  parts.push(summaryText);
  
  const line = parts.join(' ');
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line;
}

async function poll() {
  let base;
  try {
    base = await getBase();
    const res = await apiRef.Http.fetch(`${base}/__intercept/logs?since=${lastSeq}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (store.error) {
      store.error = '';
      lastErrorShown = '';
      apiRef.Logger.info(`Conectado con el proxy en ${base}`);
      notify();
    }

    if (typeof data.last === 'number' && data.last < lastSeq) {
      // El proxy se reinició: empezamos de cero en la próxima consulta.
      lastSeq = 0;
      return;
    }

    const fresh = Array.isArray(data.entries) ? data.entries : [];
    if (fresh.length) {
      lastSeq = data.last;
      store.entries = store.entries.concat(fresh).slice(-MAX_LOCAL);
      const mirror = await apiRef.Settings.get('mirror');
      if (mirror !== false) {
        fresh.forEach((e) => {
          if (e.dir === 'error') apiRef.Logger.error(lineFor(e));
          else apiRef.Logger.info(lineFor(e));
        });
      }
      notify();
    }
  } catch (err) {
    const msg = `No se pudo consultar el proxy${base ? ' en ' + base : ''}: ${err && err.message ? err.message : err}`;
    store.error = msg;
    if (msg !== lastErrorShown) {
      lastErrorShown = msg;
      apiRef.Logger.warn(msg);
    }
    notify();
  }
}

function start() {
  running = true;
  const tick = async () => {
    if (!running) return;
    await poll();
    if (!running) return;
    let ms = Number(await apiRef.Settings.get('pollMs'));
    if (!Number.isFinite(ms) || ms < 250) ms = 1000;
    timer = setTimeout(tick, ms);
  };
  tick();
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function clearAll() {
  store.entries = [];
  notify();
  try {
    const base = await getBase();
    await apiRef.Http.fetch(`${base}/__intercept/clear`, { method: 'POST', body: '' });
  } catch (_) {
    // si el proxy no responde, igualmente se limpia el panel local
  }
}

// ---- Widget (panel en vivo) ----
function prettyBody(body) {
  if (!body) return '(vacío)';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch (_) {
    return body;
  }
}

function LogsWidget() {
  const h = React.createElement;
  const [, force] = React.useState(0);
  const [filter, setFilter] = React.useState('');
  const boxRef = React.useRef(null);

  React.useEffect(() => {
    const listener = () => force((n) => n + 1);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);

  React.useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const colors = { request: '#4fc3f7', response: '#81c784', sse: '#ffd54f', error: '#e57373' };
  const needle = filter.trim().toLowerCase();
  
  // Búsqueda más robusta
  const visible = needle
    ? store.entries.filter((e) => {
        const searchText = `${e.method||''} ${e.status||''} ${e.summary || ''} ${e.url || ''} ${e.body || ''}`.toLowerCase();
        return searchText.includes(needle);
      })
    : store.entries;

  const rows = visible.map((e) =>
    h(
      'details',
      { key: e.seq, style: { marginBottom: 4, backgroundColor: 'rgba(255,255,255,0.05)', padding: '4px 8px', borderRadius: '4px' } },
      h(
        'summary',
        { style: { cursor: 'pointer', color: colors[e.dir] || 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontWeight: '500' } },
        `${e.t.slice(11, 23)}  ${lineFor(e)}`
      ),
      h(
        'pre',
        { style: { margin: '8px 0 8px 16px', opacity: 0.9, whiteSpace: 'pre-wrap', wordBreak: 'break-all', backgroundColor: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '4px', borderLeft: `3px solid ${colors[e.dir] || '#888'}` } },
        prettyBody(e.body)
      )
    )
  );

  const controlStyle = {
    font: 'inherit',
    fontSize: 13,
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(0,0,0,0.2)',
    color: '#fff',
    outline: 'none'
  };

  return h(
    'div',
    { style: { width: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' } },
    h(
      'div',
      { style: { display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' } },
      h('input', {
        value: filter,
        placeholder: '🔍 Filtrar peticiones por texto, código de estado, url...',
        onChange: (ev) => setFilter(ev.target.value),
        style: { ...controlStyle, flex: 1, transition: 'all 0.2s' },
        onFocus: (e) => e.target.style.borderColor = '#4fc3f7',
        onBlur: (e) => e.target.style.borderColor = 'rgba(255,255,255,0.2)'
      }),
      h('button', { 
        onClick: clearAll, 
        style: { ...controlStyle, cursor: 'pointer', background: 'rgba(229, 115, 115, 0.1)', borderColor: 'rgba(229, 115, 115, 0.4)', color: '#e57373' },
        onMouseOver: (e) => e.target.style.background = 'rgba(229, 115, 115, 0.2)',
        onMouseOut: (e) => e.target.style.background = 'rgba(229, 115, 115, 0.1)'
      }, '🗑️ Limpiar')
    ),
    store.error ? h('div', { style: { color: '#e57373', fontSize: 13, marginBottom: 10, padding: '8px', background: 'rgba(229, 115, 115, 0.1)', borderRadius: '4px' } }, `⚠️ ${store.error}`) : null,
    h(
      'div',
      {
        ref: boxRef,
        style: {
          height: 400,
          overflow: 'auto',
          padding: 10,
          borderRadius: 8,
          background: 'rgba(15, 15, 15, 0.8)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          border: '1px solid rgba(255,255,255,0.1)'
        },
      },
      rows.length ? rows : h('div', { style: { opacity: 0.5, textAlign: 'center', marginTop: '20px', fontSize: '14px' } }, '⏳ Esperando peticiones JSON(200)...')
    )
  );
}

// ---- Ciclo de vida del plugin ----
module.exports = {
  async onLoad(api) {
    api.Logger.info('Plugin MCP Logs cargado');
  },

  async onEnable(api) {
    apiRef = api;

    const definitions = [
      {
        id: 'proxyUrl',
        title: 'URL del proxy mcp-intercept',
        description: 'Dirección donde corre el servidor de intercepción.',
        category: CATEGORY,
        kind: 'string',
        default: 'http://127.0.0.1:4120',
        format: 'url',
        widget: { type: 'text', placeholder: 'http://127.0.0.1:4120' },
      },
      {
        id: 'pollMs',
        title: 'Intervalo de consulta',
        description: 'Cada cuánto se piden las entradas nuevas al proxy.',
        category: CATEGORY,
        kind: 'number',
        default: 1000,
        min: 250,
        max: 10000,
        step: 250,
        unit: 'ms',
        widget: { type: 'number-input', min: 250, max: 10000, step: 250, unit: 'ms' },
      },
      {
        id: 'mirror',
        title: 'Copiar al visor de logs',
        description: 'Escribe cada petición en Preferencias → Logs.',
        category: CATEGORY,
        kind: 'boolean',
        default: true,
        widget: { type: 'toggle' },
      },
    ];

    if (React) {
      api.Settings.registerWidget(WIDGET_ID, LogsWidget);
      definitions.push({
        id: 'panel',
        title: 'Peticiones MCP en vivo',
        description: 'Filtra y revisa los JSON capturados. Clic en una línea para expandir.',
        category: CATEGORY,
        kind: 'custom',
        widgetId: WIDGET_ID,
      });
    } else {
      api.Logger.warn('React no está disponible: el panel en vivo se desactiva.');
    }

    await api.Settings.register(definitions);
    lastSeq = 0;
    store.entries = [];
    start();
    api.Logger.info('Plugin activado correctamente');
  },

  async onDisable(api) {
    stop();
    if (React) api.Settings.unregisterWidget(WIDGET_ID);
    api.Logger.info('Plugin desactivado');
  },

  async onUnload() {
    stop();
  },
};
