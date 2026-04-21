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
    deeds:       field('Deeds'),
  };
}

// ── GET /api/parcel/:id — full assessor data for one parcel ──
app.get('/api/parcel/:id', async (req, res) => {
  const id = req.params.id.trim();
  try {
    const [infoRes, taxRes] = await Promise.all([
      fetch(`${ASSESSOR_BASE}/Search/GetInfo?parcelNumber=${id}&inAISMode=false`),
      fetch(`${ASSESSOR_BASE}/Search/GetParcelTaxes?parcelid=${id}`)
    ]);
    if (!infoRes.ok) { res.status(404).json({ error: 'Parcel not found' }); return; }

    const html    = await infoRes.text();
    const taxData = await taxRes.json().catch(() => ({}));
    const info    = parseInfo(html, id);

    if (!info.owner) { res.status(404).json({ error: 'No data found for this parcel' }); return; }

    info.parishTax  = taxData.ParishTaxes ?? 0;
    info.cityTax    = taxData.CityTaxes   ?? 0;
    info.homestead  = taxData.Homestead   ?? 0;

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

app.listen(PORT, () => console.log(`St. Landry IQ running on port ${PORT}`));
