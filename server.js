/**
 * Inspiria CRM — HubSpot Live Data Server
 * Run: HUBSPOT_TOKEN=pat-xxx node server.js
 * Or set the token via the dashboard Settings panel.
 */

const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT      = process.env.PORT || 3000;
const CACHE_MS  = 2 * 60 * 1000; // cache HubSpot responses for 2 minutes

let HS_TOKEN  = process.env.HUBSPOT_TOKEN || '';
let dataCache = null;
let cacheTs   = 0;

// ── HubSpot fetch helper ───────────────────────────────────────────────────────
async function hs(endpoint, opts = {}) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${endpoint}: ${body}`);
  return JSON.parse(body);
}

// Count objects matching a filter (returns integer)
async function countSearch(objectType, filters) {
  const data = await hs(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters }], limit: 1, properties: [] }),
  });
  return data.total || 0;
}

// ── Build live data snapshot ───────────────────────────────────────────────────
async function buildLiveData() {
  // 1. Total contacts
  const contactsResp = await hs('/crm/v3/objects/contacts?limit=1');
  const totalContacts = contactsResp.total || 0;

  // 2. Deal pipeline stages (fetch dynamically so stage IDs are portal-specific)
  const pipelineResp = await hs('/crm/v3/pipelines/deals');
  const pipeline = pipelineResp.results?.[0];
  const stages   = pipeline?.stages || [];

  // Count deals per stage
  const stageCounts = {};
  await Promise.all(stages.map(async s => {
    stageCounts[s.id] = await countSearch('deals', [
      { propertyName: 'dealstage', operator: 'EQ', value: s.id },
    ]);
  }));

  // Map stage labels → canonical keys (case-insensitive)
  const deals = { appointmentScheduled:0, formSold:0, admissionDone:0, closedWon:0, closedLost:0 };
  const dealStages = [];
  for (const s of stages) {
    const lbl = s.label;
    const cnt = stageCounts[s.id] || 0;
    dealStages.push({ label: lbl, count: cnt });
    if (/appointment/i.test(lbl))        deals.appointmentScheduled = cnt;
    else if (/form.?sold|sold/i.test(lbl)) deals.formSold           = cnt;
    else if (/admission.?done|done/i.test(lbl)) deals.admissionDone = cnt;
    else if (/closed.?won|^won/i.test(lbl))     deals.closedWon     = cnt;
    else if (/closed.?lost|^lost/i.test(lbl))   deals.closedLost    = cnt;
  }

  // 3. Owners with contact counts and weekly touches
  const ownersResp = await hs('/crm/v3/owners?limit=100');
  const weekAgo    = String(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const ownerRows  = await Promise.all(
    (ownersResp.results || []).map(async o => {
      const name = (`${o.firstName || ''} ${o.lastName || ''}`).trim() || o.email;
      const [total, touched] = await Promise.all([
        countSearch('contacts', [{ propertyName:'hubspot_owner_id', operator:'EQ', value:String(o.id) }]),
        countSearch('contacts', [
          { propertyName:'hubspot_owner_id',  operator:'EQ',  value:String(o.id) },
          { propertyName:'notes_last_updated', operator:'GTE', value:weekAgo      },
        ]),
      ]);
      return { name, email: o.email, total, touched };
    })
  );
  ownerRows.sort((a, b) => b.total - a.total);

  // 4. Re-engagement: contacts older than 120 days untouched
  const d120 = String(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const d30  = String(Date.now() -  30 * 24 * 60 * 60 * 1000);
  const [dormant, reTouched] = await Promise.all([
    countSearch('contacts', [{ propertyName:'notes_last_updated', operator:'LT', value:d120 }]),
    countSearch('contacts', [
      { propertyName:'notes_last_updated', operator:'GTE', value:d30  },
      { propertyName:'createdate',         operator:'LT',  value:d120 },
    ]),
  ]);

  return {
    contacts: totalContacts,
    deals,
    dealStages,
    owners: ownerRows,
    reEngagement: { total: dormant + reTouched, reTouched, dormant },
    fetchedAt: new Date().toISOString(),
  };
}

async function getLiveData() {
  if (dataCache && Date.now() - cacheTs < CACHE_MS) return { ...dataCache, fromCache: true };
  const fresh = await buildLiveData();
  dataCache = fresh;
  cacheTs   = Date.now();
  return fresh;
}

// ── API routes ─────────────────────────────────────────────────────────────────
app.get('/api/live-data', async (req, res) => {
  if (!HS_TOKEN) return res.status(400).json({ success:false, error:'No HubSpot token. Open Settings and save your Private App token.' });
  try {
    const data = await getLiveData();
    res.json({ success:true, data });
  } catch(err) {
    console.error('HubSpot error:', err.message);
    res.status(500).json({ success:false, error: err.message });
  }
});

// Force-refresh (clears cache)
app.get('/api/refresh', async (req, res) => {
  dataCache = null; cacheTs = 0;
  if (!HS_TOKEN) return res.status(400).json({ success:false, error:'No token.' });
  try {
    const data = await getLiveData();
    res.json({ success:true, data });
  } catch(err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

// Save HubSpot token from UI
app.post('/api/set-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error:'token required' });
  HS_TOKEN  = token;
  dataCache = null; // invalidate cache when token changes
  cacheTs   = 0;
  console.log('HubSpot token updated via UI.');
  res.json({ success:true });
});

app.listen(PORT, () => {
  console.log(`\n  Inspiria CRM server → http://localhost:${PORT}`);
  if (!HS_TOKEN) console.log('  ⚠  No HUBSPOT_TOKEN set. Open Settings in the dashboard to add one.');
  else           console.log('  ✓  HubSpot token loaded from environment.');
  console.log('');
});
