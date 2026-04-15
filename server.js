import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = 'https://cloud.solar-manager.ch';

// ── File-based API cache (24 h TTL, on-the-fly invalidation) ───────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, 'api-cache');
const CACHE_TTL  = 24 * 60 * 60 * 1000; // 24 h in ms

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(...parts) {
  return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

function readCache(key) {
  try {
    const { ts, data } = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    if (Date.now() - ts < CACHE_TTL) return data;
  } catch {}
  return null;
}

function writeCache(key, data) {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ ts: Date.now(), data }));
  } catch (err) {
    console.error('[cache] write error:', err);
  }
}

app.use(express.json());
app.use(express.static('public'));

// Proxy: GET /api/stream?smId=...  — real-time, never cached
app.get('/api/stream', async (req, res) => {
  const smId = req.query.smId;
  const auth = req.headers['authorization'];

  if (!smId) return res.status(400).json({ error: 'smId query parameter required' });
  if (!auth) return res.status(401).json({ error: 'Authorization header required' });

  try {
    const upstream = await fetch(`${API_BASE}/v1/stream/gateway/${smId}`, {
      headers: { Authorization: auth },
    });
    const body = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body?.message || 'API error', details: body });
    }
    res.json(body);
  } catch (err) {
    console.error('Upstream fetch error:', err);
    res.status(502).json({ error: 'Failed to reach SolarManager API' });
  }
});

// Proxy: GET /api/statistics?smId=...&from=ISO&to=ISO&accuracy=low|medium|high
// Cached per (smId, from, to, accuracy) for 24 h.
app.get('/api/statistics', async (req, res) => {
  const { smId, from, to, accuracy = 'medium' } = req.query;
  const auth = req.headers['authorization'];

  if (!smId || !from || !to) return res.status(400).json({ error: 'smId, from, and to are required' });
  if (!auth) return res.status(401).json({ error: 'Authorization header required' });

  const key = cacheKey('stats', smId, from, to, accuracy);
  const cached = readCache(key);
  if (cached) { console.log('[statistics] cache hit', key); return res.json(cached); }

  const url = `${API_BASE}/v1/statistics/gateways/${smId}?accuracy=${accuracy}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  console.log('[statistics] GET', url);

  try {
    const upstream = await fetch(url, { headers: { Authorization: auth } });
    const text = await upstream.text();
    console.log('[statistics] status:', upstream.status, 'body:', text.slice(0, 300));

    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body?.message || 'API error', details: body });
    }

    writeCache(key, body);
    res.json(body);
  } catch (err) {
    console.error('Upstream fetch error:', err);
    res.status(502).json({ error: 'Failed to reach SolarManager API' });
  }
});

// Proxy: GET /api/tariff?smId=...
// Cached per smId for 24 h.
app.get('/api/tariff', async (req, res) => {
  const { smId } = req.query;
  const auth = req.headers['authorization'];

  if (!smId) return res.status(400).json({ error: 'smId required' });
  if (!auth) return res.status(401).json({ error: 'Authorization header required' });

  const key = cacheKey('tariff', smId);
  const cached = readCache(key);
  if (cached) { console.log('[tariff] cache hit', key); return res.json(cached); }

  try {
    const upstream = await fetch(`${API_BASE}/v1/tariff/gateways/${smId}`, {
      headers: { Authorization: auth },
    });
    const body = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body?.message || 'API error', details: body });
    }
    writeCache(key, body);
    res.json(body);
  } catch (err) {
    console.error('Tariff fetch error:', err);
    res.status(502).json({ error: 'Failed to reach SolarManager API' });
  }
});

app.listen(PORT, () => {
  console.log(`SolarManager UI running at http://localhost:${PORT}`);
});
