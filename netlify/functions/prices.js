const https = require('https');

exports.handler = async (event) => {
  const ticker = event.queryStringParameters?.ticker;
  if (!ticker) {
    return { statusCode: 400, body: JSON.stringify({ error: 'ticker requerido' }) };
  }

  try {
    const closes = await fetchYahoo(ticker);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900',   // cache 15 min en Netlify CDN
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ ticker, closes })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchYahoo(ticker) {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 220 * 86400;
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${start}&period2=${end}&events=history`;

  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no_data');

  const closes = result.indicators.quote[0].close;
  const timestamps = result.timestamp;

  return closes
    .map((c, i) => ({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: c }))
    .filter(c => c.close != null)
    .slice(-220);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; trading-signals/1.0)',
        'Accept': 'application/json'
      }
    };
    https.get(url, opts, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}
