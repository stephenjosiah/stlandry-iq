const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const ASSESSOR_BASE = 'https://stlandrymapping.azurewebsites.net';
const ARC_PARCELS   = 'https://services1.arcgis.com/fe3XWHMASK948q2c/arcgis/rest/services/StLandryParcels/FeatureServer/0/query';
const ARC_ADJ1      = 'https://services1.arcgis.com/fe3XWHMASK948q2c/arcgis/rest/services/StlandryEuniceAdjudicated/FeatureServer/0/query';
const ARC_ADJ2      = 'https://services1.arcgis.com/fe3XWHMASK948q2c/arcgis/rest/services/StLandryParishCityAdj/FeatureServer/0/query';

app.use(express.static(path.join(__dirname, 'public')));

// ── Parse GetInfo HTML into a clean object ──
function parseInfo(html, parcelId) {
  const field = (label) => {
    const re = new RegExp(label + '[\\s\\S]*?<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>', 'i');
    const m  = html.match(re);
    if (!m) return '';
    return m[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  };
  return {
    parcel:      parcelId,
    owner:       field('Primary Owner'),
    physAddr:    field('Physical Addr'),
    mailingAddr: field('Mailing Addr'),
    block:       field('Block'),
    lot:         field('Lot'),
    subdivision: field('Subdivision'),
    assessedVal: field('Assessed Value'),
    legal:       field('Legal'),
  };
}

// ── GET /api/parcel/:id — full assessor data for one parcel ──
app.get('/api/parcel/:id', async (req, res) => {
  const id = req.params.id.trim();
  try {
    const [infoRes, taxRes, deedRes] = await Promise.all([
      fetch(`${ASSESSOR_BASE}/Search/GetInfo?parcelNumber=${id}&inAISMode=false`),
      fetch(`${ASSESSOR_BASE}/Search/GetParcelTaxes?parcelid=${id}`),
      fetch(`${ASSESSOR_BASE}/Search/GetDeeds?parcelNumber=${id}`)
    ]);
    if (!infoRes.ok) { res.status(404).json({ error: 'Parcel not found' }); return; }

    const html     = await infoRes.text();
    const taxData  = await taxRes.json().catch(() => ({}));
    const deedHtml = await deedRes.text();
    const info     = parseInfo(html, id);

    if (!info.owner) { res.status(404).json({ error: 'No data found for this parcel' }); return; }

    info.parishTax  = taxData.ParishTaxes ?? 0;
    info.cityTax    = taxData.CityTaxes   ?? 0;
    info.homestead  = taxData.Homestead   ?? 0;
    info.deeds      = parseDeeds(deedHtml);

    // Cross-check adjudicated status
    const adjUrl = `${ARC_ADJ1}?where=${encodeURIComponent(`PARCEL='${id}' OR ParcelNumb='${id}'`)}&returnCountOnly=true&f=json`;
    const adjUrl2= `${ARC_ADJ2}?where=${encodeURIComponent(`PARCEL='${id}' OR ParcelNumb='${id}'`)}&returnCountOnly=true&f=json`;
    const [a1, a2] = await Promise.all([
      fetch(adjUrl).then(r => r.json()).catch(() => ({ count: 0 })),
      fetch(adjUrl2).then(r => r.json()).catch(() => ({ count: 0 }))
    ]);
    info._isAdj = (a1.count > 0 || a2.count > 0);

    res.json(info);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/browse — top parcels by criteria, hydrated with assessor data ──
app.get('/api/browse', async (req, res) => {
  const filter  = req.query.filter || 'large';
  const limit   = Math.min(parseInt(req.query.limit) || 30, 50);

  const filters = {
    large:       'CALC_ACRES >= 20',
    huge:        'CALC_ACRES >= 50',
    discrepancy: 'ACRES_DIFF <= -5',
    flagged:     "NEEDS_REV = 'Y'",
    all:         '1=1',
  };
  const where = filters[filter] || filters.all;

  try {
    // 1. Fetch parcel IDs + acreage from ArcGIS
    const arcUrl = `${ARC_PARCELS}?${new URLSearchParams({
      where,
      outFields: 'PARCEL,CALC_ACRES,DEED_ACRES,ACRES_DIFF,COMMENT,NEEDS_REV,BUS_NAME',
      returnGeometry: false,
      resultRecordCount: limit,
      orderByFields: 'CALC_ACRES DESC',
      f: 'json'
    })}`;
    const arcRes  = await fetch(arcUrl);
    const arcData = await arcRes.json();
    const features = (arcData.features || []).filter(f => f.attributes.PARCEL);

    // 2. Hydrate each with assessor data (parallel, capped)
    const results = await Promise.all(features.map(async (f) => {
      const a      = f.attributes;
      const parcel = a.PARCEL.trim();
      try {
        const infoRes = await fetch(`${ASSESSOR_BASE}/Search/GetInfo?parcelNumber=${parcel}&inAISMode=false`);
        const html    = await infoRes.text();
        const taxRes  = await fetch(`${ASSESSOR_BASE}/Search/GetParcelTaxes?parcelid=${parcel}`);
        const taxData = await taxRes.json().catch(() => ({}));
        const info    = parseInfo(html, parcel);
        info.calcAcres  = a.CALC_ACRES;
        info.deedAcres  = a.DEED_ACRES;
        info.acresDiff  = a.ACRES_DIFF;
        info.comment    = a.COMMENT;
        info.needsRev   = a.NEEDS_REV;
        info.busName    = a.BUS_NAME;
        info.parishTax  = taxData.ParishTaxes ?? 0;
        info.cityTax    = taxData.CityTaxes   ?? 0;
        info.homestead  = taxData.Homestead   ?? 0;
        info._isAdj     = false;
        return info;
      } catch(e) {
        return { parcel, calcAcres: a.CALC_ACRES, error: e.message };
      }
    }));

    // 3. Cross-check all against adjudicated layers in one query
    const parcelList = features.map(f => `'${f.attributes.PARCEL.trim()}'`).join(',');
    if (parcelList) {
      const [adj1, adj2] = await Promise.all([
        fetch(`${ARC_ADJ1}?${new URLSearchParams({ where: `PARCEL IN (${parcelList})`, outFields: 'PARCEL', returnGeometry: false, f: 'json' })}`).then(r => r.json()).catch(() => ({ features: [] })),
        fetch(`${ARC_ADJ2}?${new URLSearchParams({ where: `PARCEL IN (${parcelList})`, outFields: 'PARCEL', returnGeometry: false, f: 'json' })}`).then(r => r.json()).catch(() => ({ features: [] }))
      ]);
      const adjSet = new Set([
        ...(adj1.features || []).map(f => f.attributes.PARCEL?.trim()),
        ...(adj2.features || []).map(f => f.attributes.PARCEL?.trim()),
      ]);
      results.forEach(r => { if (adjSet.has(r.parcel)) r._isAdj = true; });
    }

    res.json(results.filter(r => r.owner));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Parse deed history HTML ──
function parseDeeds(html) {
  const deeds = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
      m[1].replace(/<[^>]*>/g, '').trim()
    );
    if (cells.length >= 3 && cells[0].match(/^\d+/)) {
      deeds.push({
        deedNum:  cells[0],
        date:     cells[1],
        type:     cells[2].replace(/\s+/g, ' ').trim(),
        price:    parseFloat(cells[3]) || 0
      });
    }
  }
  return deeds;
}

// ── Shared hydrator: fetch assessor data for a parcel ID ──
async function hydrateParcel(id, arcAttrs = {}) {
  const [infoRes, taxRes, deedRes] = await Promise.all([
    fetch(`${ASSESSOR_BASE}/Search/GetInfo?parcelNumber=${id}&inAISMode=false`),
    fetch(`${ASSESSOR_BASE}/Search/GetParcelTaxes?parcelid=${id}`),
    fetch(`${ASSESSOR_BASE}/Search/GetDeeds?parcelNumber=${id}`)
  ]);
  const html     = await infoRes.text();
  const taxData  = await taxRes.json().catch(() => ({}));
  const deedHtml = await deedRes.text();
  const info     = parseInfo(html, id);

  info.calcAcres  = arcAttrs.CALC_ACRES ?? arcAttrs.calcAcres ?? null;
  info.deedAcres  = arcAttrs.DEED_ACRES ?? null;
  info.acresDiff  = arcAttrs.ACRES_DIFF ?? null;
  info.comment    = arcAttrs.COMMENT    ?? null;
  info.needsRev   = arcAttrs.NEEDS_REV  ?? null;
  info.busName    = arcAttrs.BUS_NAME   ?? null;
  info.parishTax  = taxData.ParishTaxes ?? 0;
  info.cityTax    = taxData.CityTaxes   ?? 0;
  info.homestead  = taxData.Homestead   ?? 0;
  info.deeds      = parseDeeds(deedHtml);

  if (!info.owner)       info.owner       = arcAttrs.Owner_Name || arcAttrs.BUS_NAME || '';
  if (!info.mailingAddr) info.mailingAddr  = arcAttrs.Owner_Addr || '';
  return info;
}

// Sweet-spot ranges for realistic investment targets
const SWEET_MIN_ACRES    = 2;
const SWEET_MAX_ACRES    = 150;
const SWEET_MIN_ASSESSED = 3000;
const SWEET_MAX_ASSESSED = 300000;

// Large-tract tier: corporate/institutional sellers, 150–600 acres
const LARGE_MAX_ACRES = 600;
const CORPORATE_RE = /\b(inc|llc|corp|co\b|company|realty|trust|ltd|lp|partners|holdings|properties|land|timber|investments?|ventures?|farms?)\b/i;

function inSweetSpot(p) {
  const acres    = parseFloat(p.calcAcres) || 0;
  const assessed = parseFloat((p.assessedVal || '').toString().replace(/,/g, '')) || 0;
  if (acres > 0 && (acres < SWEET_MIN_ACRES || acres > SWEET_MAX_ACRES)) return false;
  if (assessed > 0 && (assessed < SWEET_MIN_ASSESSED || assessed > SWEET_MAX_ASSESSED)) return false;
  return true;
}

// ── Score a hydrated parcel (server-side mirror of client scoring) ──
function scoreParcel(p) {
  const signals = []; let score = 0;
  const add = (label, type, pts) => { signals.push({ label, type }); score += pts; };

  // Hard disqualifiers — outside the investable range
  const acres    = parseFloat(p.calcAcres) || 0;
  const assessed = parseFloat((p.assessedVal || '').toString().replace(/,/g, '')) || 0;
  if (acres > 0 && acres < SWEET_MIN_ACRES)    return { score: 0, signals: [{ label: 'Too Small', type: 'blue' }] };
  if (acres > LARGE_MAX_ACRES)                 return { score: 0, signals: [{ label: 'Too Large', type: 'blue' }] };
  if (assessed > 0 && assessed < SWEET_MIN_ASSESSED) return { score: 0, signals: [{ label: 'Low Value', type: 'blue' }] };
  if (assessed > SWEET_MAX_ASSESSED && acres <= SWEET_MAX_ACRES) return { score: 0, signals: [{ label: 'Out of Range', type: 'blue' }] };

  if (p._isAdj)
    add('Adjudicated', 'hot', 35);

  const name = (p.owner || '').toLowerCase();
  const legal = (p.legal || '').toLowerCase();
  if (/heir|estate|succession|probate|et al|et ux/.test(name) || /probate|succession|partition/.test(legal))
    add('Heirs / Estate', 'hot', 20);

  const mail = (p.mailingAddr || '').toLowerCase();
  const laKw = ['lafayette','opelousas','eunice','baton rouge','new orleans','shreveport','lake charles',
                 'ville platte','mamou','port barre','sunset','church point','lawtell','melville',
                 'jennings','crowley','breaux bridge','st martinville','new iberia'];
  const inLA = laKw.some(k => mail.includes(k)) || / la[\s\n,]/.test(mail);
  if (mail && !inLA)
    add('Out-of-State Owner', 'warm', 15);

  if (p.homestead === 0 || p.homestead === '0')
    add('No Homestead', 'warm', 8);

  if (assessed > 0 && parseFloat(p.parishTax) / assessed > 0.05)
    add('High Tax Burden', 'warm', 10);

  if (p.needsRev === 'Y')
    add('Flagged for Review', 'warm', 8);

  if (acres > SWEET_MAX_ACRES) add('Large Tract',  'good', 12);
  else if (acres >= 50)        add('50+ Acres',    'good', 15);
  else if (acres >= 20)        add('20+ Acres',    'good', 8);
  else if (acres >= 2)         add('2–20 Acres',   'good', 4);

  if (CORPORATE_RE.test(p.owner || ''))
    add('Corporate Owner', 'warm', 15);

  if ((parseFloat(p.acresDiff) || 0) <= -5)
    add('Acreage Discrepancy', 'warm', 5);

  // Deed history signals
  const deeds = Array.isArray(p.deeds) ? p.deeds : [];
  if (deeds.length > 0) {
    const types = deeds.map(d => (d.type || '').toUpperCase());
    const succCount = types.filter(t => t.includes('JUDGT OF POSS') || t.includes('SUCCESSION')).length;
    if (succCount > 0)  add('Succession / Probate Deed', 'hot', 20);
    if (succCount >= 2) add('Multi-Gen Succession',      'hot', 10);
    if (types.some(t => t.includes('TAX SALE')))
      add('Tax Sale History',   'hot',  15);
    if (types.some(t => t.includes('REDEMPTION')))
      add('Tax Redemption',     'warm',  8);
    if (deeds.every(d => (d.price || 0) === 0))
      add('Never Sold on Market', 'warm', 10);
  }

  return { score: Math.min(score, 100), signals };
}

// ── GET /api/opportunities ──
app.get('/api/opportunities', async (req, res) => {
  try {
    const seen    = new Set();
    const results = [];

    // 1. Adjudicated parcels — pre-filter to sweet-spot acreage at the query level
    const adjWhere = `CALC_ACRES >= ${SWEET_MIN_ACRES} AND CALC_ACRES <= ${SWEET_MAX_ACRES}`;
    const [a1r, a2r] = await Promise.all([
      fetch(`${ARC_ADJ1}?where=${encodeURIComponent(adjWhere)}&outFields=*&returnGeometry=false&resultRecordCount=1000&f=json`),
      fetch(`${ARC_ADJ2}?where=${encodeURIComponent(adjWhere)}&outFields=*&returnGeometry=false&resultRecordCount=1000&f=json`)
    ]);
    const [adj1, adj2] = await Promise.all([a1r.json(), a2r.json()]);
    const adjFeatures  = [
      ...(adj1.features || []).map(f => ({ ...f.attributes, _isAdj: true })),
      ...(adj2.features || []).map(f => ({ ...f.attributes, _isAdj: true }))
    ];

    for (const a of adjFeatures) {
      const id = (a.PARCEL || a.ParcelNumb || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const info    = await hydrateParcel(id, a);
        info._isAdj   = true;
        const { score, signals } = scoreParcel(info);
        info._score   = score;
        info._signals = signals;
        results.push(info);
      } catch(e) {
        results.push({ parcel: id, owner: a.Owner_Name || a.BUS_NAME, _isAdj: true, _score: 35, _signals: [{ label: 'Adjudicated', type: 'hot' }] });
      }
    }

    // 2. Large tracts (150–600 ac) — surface corporate/institutional sellers
    const largeRes  = await fetch(`${ARC_PARCELS}?${new URLSearchParams({
      where:             `CALC_ACRES > ${SWEET_MAX_ACRES} AND CALC_ACRES <= ${LARGE_MAX_ACRES}`,
      outFields:         'PARCEL,CALC_ACRES,DEED_ACRES,ACRES_DIFF,COMMENT,NEEDS_REV,BUS_NAME',
      returnGeometry:    false,
      resultRecordCount: 20,
      f:                 'json'
    })}`);
    const largeData = await largeRes.json();

    for (const f of (largeData.features || [])) {
      const id = (f.attributes.PARCEL || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const info = await hydrateParcel(id, f.attributes);
        info._isAdj = false;
        const { score, signals } = scoreParcel(info);
        if (score >= 25) {
          info._score   = score;
          info._signals = signals;
          results.push(info);
        }
      } catch(e) { /* skip */ }
    }

    // 3. Full-parish: sweet-spot acreage with flags/discrepancy
    const arcWhere = `CALC_ACRES >= ${SWEET_MIN_ACRES} AND CALC_ACRES <= ${SWEET_MAX_ACRES} AND (NEEDS_REV = 'Y' OR ACRES_DIFF <= -5)`;
    const arcRes   = await fetch(`${ARC_PARCELS}?${new URLSearchParams({
      where:             arcWhere,
      outFields:         'PARCEL,CALC_ACRES,DEED_ACRES,ACRES_DIFF,COMMENT,NEEDS_REV,BUS_NAME',
      returnGeometry:    false,
      resultRecordCount: 40,
      f:                 'json'
    })}`);
    const arcData = await arcRes.json();

    for (const f of (arcData.features || [])) {
      const id = (f.attributes.PARCEL || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const info             = await hydrateParcel(id, f.attributes);
        info._isAdj            = false;
        const { score, signals } = scoreParcel(info);
        if (score >= 20) {
          info._score   = score;
          info._signals = signals;
          results.push(info);
        }
      } catch(e) { /* skip */ }
    }

    results.sort((a, b) => b._score - a._score);
    res.json(results);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`St. Landry IQ running on port ${PORT}`));
