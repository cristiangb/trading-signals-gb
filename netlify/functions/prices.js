const https  = require('https');
const { getStore } = require('@netlify/blobs');

// ── Token helpers con Netlify Blobs ───────────────────────────────────────────
function getBalanzStore() {
  return getStore({
    name:   'balanz',
    siteID: process.env.NETLIFY_SITE_ID,
    token:  process.env.NETLIFY_TOKEN,
  });
}

async function getStoredToken() {
  try {
    const store = getBalanzStore();
    const raw   = await store.get('session');
    if (!raw) return null;
    const { token, expiry } = JSON.parse(raw);
    if (Date.now() > expiry) return null;
    return token;
  } catch(e) { console.warn('getStoredToken error:', e.message); return null; }
}

async function storeToken(token, cookie) {
  try {
    const store  = getBalanzStore();
    const expiry = Date.now() + 50 * 60 * 1000;
    await store.set('session', JSON.stringify({ token, cookie, expiry }));
  } catch(e) { console.warn('storeToken error:', e.message); }
}

async function getStoredSession() {
  try {
    const store = getBalanzStore();
    const raw   = await store.get('session');
    if (!raw) return null;
    const { token, cookie, expiry } = JSON.parse(raw);
    if (Date.now() > expiry) return null;
    return { token, cookie };
  } catch(e) { console.warn('getStoredToken error:', e.message); return null; }
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
      const session = await getBalanzToken();
      const saldo   = await fetchBalanzSaldo(session);
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
      const session = await getBalanzToken();
      const cot   = await fetchBalanzCot(session, sym);
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
  // 1. Intentar sesión guardada
  const stored = await getStoredSession();
  if (stored) return stored;

  const user   = process.env.BALANZ_USER;
  const pass   = process.env.BALANZ_PASS;
  const cookie = process.env.BALANZ_SESSION_COOKIE || '';
  if (!user || !pass) throw new Error('BALANZ_USER / BALANZ_PASS no configurados');

  console.log('Cookie de env:', cookie.slice(0, 30));

  // 2. Init → nonce
  const initRes = await postJson(BALANZ, '/api/v1/auth/init?avoidAuthRedirect=true',
    { user, source: 'WebV2', idAplicacion: 1 }, cookie
  );
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
  }, cookie);

  if (loginRes.idError === -3) {
    throw new Error('Demasiadas sesiones activas en Balanz. Cerrá sesión en la web y esperá 15 min.');
  }

  const token = loginRes.AccessToken;
  if (!token) {
    console.error('LOGIN RESPONSE:', JSON.stringify(loginRes).slice(0, 300));
    throw new Error('Login fallido: ' + (loginRes.Descripcion || 'sin AccessToken'));
  }

  const session = { token, cookie };
  await storeToken(token, cookie);
  console.log('Nuevo token guardado. Cookie:', cookie.slice(0, 40));
  return session;
}

// ── Balanz endpoints ──────────────────────────────────────────────────────────
async function clearStoredToken() {
  try {
    const store = getBalanzStore();
    await store.delete('session');
    console.log('Token Blobs eliminado');
  } catch(e) { console.warn('clearStoredToken error:', e.message); }
}

async function fetchBalanzSaldo(session) {
  const { token, cookie } = session;
  const hoy  = new Date().toISOString().slice(0,10).replace(/-/g,'');
  let data = await getJson(BALANZ,
    `/api/v1/estadodecuenta/${ID_CUENTA}?Fecha=${hoy}&ta=1&idMoneda=1&avoidAuthRedirect=true`,
    token, cookie
  );

  // Sesión expirada — limpiar token y reintentar una vez
  if (data.CodigoError === -1001 || data.Descripcion?.includes('Expirada')) {
    console.log('Sesión expirada — renovando token...');
    await clearStoredToken();
    const newSession = await getBalanzToken();
    const hoy2 = new Date().toISOString().slice(0,10).replace(/-/g,'');
    data = await getJson(BALANZ,
      `/api/v1/estadodecuenta/${ID_CUENTA}?Fecha=${hoy2}&ta=1&idMoneda=1&avoidAuthRedirect=true`,
      newSession.token, newSession.cookie
    );
    console.log('SALDO RETRY:', JSON.stringify(data).slice(0, 400));
  }


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

async function fetchBalanzCot(session, sym) {
  const { token, cookie } = session;
  return getJson(BALANZ,
    `/api/v1/cotizacioninstrumento?plazo=1&idCuenta=${ID_CUENTA}&ticker=${encodeURIComponent(sym)}&avoidAuthRedirect=true`,
    token, cookie
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
function postJson(host, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin':         'https://clientes.balanz.com',
      'Referer':        'https://clientes.balanz.com/',
      'Accept':         'application/json',
      'lang':           'es',
    };
    if (cookie) headers['Cookie'] = cookie;
    const req = https.request({ hostname: host, path, method: 'POST', headers }, res => {
      let raw = '';
      const setCookie = res.headers['set-cookie'] || [];
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          json.__cookies = setCookie;
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(host, path, token, cookie) {
  console.log('GET', path, 'token:', token?.slice(0,8) + '...');
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': token,   // sin Bearer
      'Content-Type':  'application/json',
      'User-Agent':    'Mozilla/5.0',
      'Origin':        'https://clientes.balanz.com',
      'Accept':        'application/json',
    };
    if (cookie) headers['Cookie'] = cookie;
    https.get({ hostname: host, path, headers }, res => {
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
