const https  = require('https');
const { getStore } = require('@netlify/blobs');

// ── Token helpers con Netlify Blobs ───────────────────────────────────────────
async function getStoredToken() {
  try {
    const store = getStore('balanz');
    const raw   = await store.get('session');
    if (!raw) return null;
    const { token, expiry } = JSON.parse(raw);
    if (Date.now() > expiry) return null;
    return token;
  } catch { return null; }
}

async function storeToken(token) {
  try {
    const store  = getStore('balanz');
    const expiry = Date.now() + 50 * 60 * 1000; // 50 minutos
    await store.set('session', JSON.stringify({ token, expiry }));
  } catch(e) { console.warn('No se pudo guardar token en Blobs:', e.message); }
}

async function clearStoredToken() {
  try {
    const store = getStore('balanz');
    await store.delete('session');
  } catch {}
}

exports.handler = async (event) => {
  const { ticker, action } = event.queryStringParameters || {};

  // ── Ruta: historial de precios (Yahoo Finance, sin auth) ──────────────────
  if (action === 'history' || ticker) {
    if (!ticker) return { statusCode: 400, body: JSON.stringify({ error: 'ticker requerido' }) };
    try {
      const closes = await fetchYahoo(ticker);
      return ok({ ticker, closes });
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── Ruta: saldo / posición desde Balanz ───────────────────────────────────
  if (action === 'saldo') {
    try {
      const token   = await getBalanzToken();
      const saldo   = await fetchBalanzSaldo(token);
      return ok(saldo);
    } catch (err) {
      console.error('ERROR saldo:', err.message, err.stack);
      return { statusCode: 500, body: JSON.stringify({ error: err.message, stack: err.stack }) };
    }
  }

  // ── Ruta: cotización puntual de un ticker en Balanz ───────────────────────
  if (action === 'cot') {
    const { sym } = event.queryStringParameters || {};
    if (!sym) return { statusCode: 400, body: JSON.stringify({ error: 'sym requerido' }) };
    try {
      const token = await getBalanzToken();
      const cot   = await fetchBalanzCot(token, sym);
      return ok(cot);
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'action inválida' }) };
};

function ok(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data)
  };
}

// ── Balanz auth ───────────────────────────────────────────────────────────────
const BALANZ    = 'clientes.balanz.com';
const ID_CUENTA = '250232';

async function getBalanzToken() {
  // 1. Intentar token guardado
  const stored = await getStoredToken();
  if (stored) return stored;

  const user = process.env.BALANZ_USER;
  const pass = process.env.BALANZ_PASS;
  if (!user || !pass) throw new Error('BALANZ_USER / BALANZ_PASS no configurados');

  // 2. Init → nonce
  const initRes = await postJson(BALANZ, '/api/v1/auth/init?avoidAuthRedirect=true', {
    user, source: 'WebV2', idAplicacion: 1
  });
  const nonce = initRes.nonce;
  if (!nonce) throw new Error('No se recibió nonce');

  // 3. Login → AccessToken
  const loginRes = await postJson(BALANZ, '/api/v1/auth/login?avoidAuthRedirect=true', {
    user, pass, nonce,
    source:           'WebV2',
    sc:               1,
    Nombre:           'Windows 11 Chrome 148.0.0.0',
    SistemaOperativo: 'Windows',
    TipoDispositivo:  'Web',
    VersionAPP:       '2.33.0',
    VersionSO:        '11',
    idDispositivo:    '48080ff5-b70b-4abb-8ba4-237982fa73bf'
  });

  // Demasiadas sesiones — esperar y reintentar no es viable, informar claro
  if (loginRes.idError === -3) {
    throw new Error('Demasiadas sesiones activas en Balanz. Cerrá sesión en la web y esperá 15 min.');
  }

  const token = loginRes.AccessToken;
  if (!token) {
    console.error('LOGIN RESPONSE:', JSON.stringify(loginRes).slice(0, 300));
    throw new Error('Login fallido: ' + (loginRes.Descripcion || 'sin AccessToken'));
  }

  // 4. Guardar en Blobs para próximas invocaciones
  await storeToken(token);
  console.log('Nuevo token Balanz guardado en Blobs');
  return token;
}

// ── Balanz endpoints ──────────────────────────────────────────────────────────
async function fetchBalanzSaldo(token) {
  const hoy = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const data = await getJson(BALANZ,
    `/api/v1/estadodecuenta/${ID_CUENTA}?Fecha=${hoy}&ta=1&idMoneda=1&avoidAuthRedirect=true`,
    token
  );

  console.log('SALDO RAW liquidez:', JSON.stringify(data.liquidez));
  console.log('SALDO RAW tenenciaActual:', JSON.stringify(data.tenenciaActual));

  // Extraer liquidez inmediata en pesos y dólares
  const liquidez = data.liquidez || [];
  const pesos = liquidez.find(l => l.idMoneda === 1);
  const usd   = liquidez.find(l => l.idMoneda === 2);
  const total = data.tenenciaActual?.[0];

  return {
    pesos:    pesos?.DO    ?? pesos?.DInm  ?? 0,
    usd:      usd?.DO      ?? usd?.DInm    ?? 0,
    total:    total?.Total ?? 0,
    mep:      total?.CotizacionMEP ?? 0,
    ccl:      total?.CotizacionCCL ?? 0,
  };
}

async function fetchBalanzCot(token, sym) {
  return getJson(BALANZ,
    `/api/v1/cotizacioninstrumento?plazo=1&idCuenta=${ID_CUENTA}&ticker=${encodeURIComponent(sym)}&avoidAuthRedirect=true`,
    token
  );
}

// ── Yahoo Finance (historial para indicadores) ────────────────────────────────
async function fetchYahoo(ticker) {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 300 * 86400;
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${start}&period2=${end}&events=history`;

  const json   = await fetchJsonGet(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' });
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no_data');

  const closes     = result.indicators.quote[0].close;
  const timestamps = result.timestamp;
  return closes
    .map((c, i) => ({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: c }))
    .filter(c => c.close != null)
    .slice(-300);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function postJson(host, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'Mozilla/5.0',
        'Origin':         'https://clientes.balanz.com',
        'Referer':        'https://clientes.balanz.com/'
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(host, path, token) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: host, path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'Mozilla/5.0',
        'Origin':        'https://clientes.balanz.com'
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchJsonGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}
