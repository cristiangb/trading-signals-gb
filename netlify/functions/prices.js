const https = require('https');

exports.handler = async (event) => {
  const ticker = event.queryStringParameters?.ticker;
  if (!ticker) {
    return { statusCode: 400, body: JSON.stringify({ error: 'ticker requerido' }) };
  }

  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key no configurada en Netlify' }) };
  }

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${apiKey}`;

  try {
    const data = await fetchJson(url);

    if (data['Note'] || data['Information']) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'rate_limit', message: data['Note'] || data['Information'] })
      };
    }

    const series = data['Time Series (Daily)'];
    if (!series) {
      return { statusCode: 404, body: JSON.stringify({ error: 'no_data', ticker }) };
    }

    // Devolver solo los últimos 220 días de closes ajustados (liviano)
    const closes = Object.entries(series)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-220)
      .map(([date, v]) => ({
        date,
        close: parseFloat(v['5. adjusted close']),
        volume: parseInt(v['6. volume'])
      }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
      body: JSON.stringify({ ticker, closes })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}
