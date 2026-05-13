#!/usr/bin/env node
'use strict';
require('dotenv').config();

const { ApifyClient } = require('apify-client');
const fs = require('fs');
const path = require('path');

// ─── SETUP ────────────────────────────────────────────────────────────────
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error('\n❌  APIFY_TOKEN manquant dans .env\n'); process.exit(1); }

const apify = new ApifyClient({ token: TOKEN });

const CFG = {
  maxPrice:    parseInt(process.env.MAX_PRICE  || '3000000'),
  maxItems:    parseInt(process.env.MAX_ITEMS_PER_SOURCE || '50'),
  city:        process.env.CITY || 'Casablanca',
  outputDir:   path.join(__dirname, 'rapports'),
};

// ─── BENCHMARKS LOYER (DH/m²/mois) ──────────────────────────────────────
const RATES = {
  'gauthier':      95,
  'racine':        92,
  'anfa':          88,
  'bourgogne':     85,
  'maarif':        75,
  'val fleuri':    70,
  'belvédère':     68,
  'belvedere':     68,
  'nassim':        65,
  'bachkou':       65,
  'ain chock':     60,
  'hay hassani':   60,
  'florida':       58,
  'sidi maarouf':  55,
  'souriyate':     55,
  'ain sebaa':     50,
  'errahma':       48,
  'sidi moumen':   45,
  'moulay rachid': 44,
  'hay mohammadi': 40,
};
const DEFAULT_RATE = 55;

// ─── HELPERS ──────────────────────────────────────────────────────────────
function getRate(location = '') {
  const loc = location.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [k, v] of Object.entries(RATES)) {
    const kn = k.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (loc.includes(kn)) return v;
  }
  return DEFAULT_RATE;
}

function estimateLoyer(location, surface) {
  if (!surface || surface <= 0) return null;
  return Math.round(surface * getRate(location));
}

function calcYield(price, monthlyRent) {
  if (!price || !monthlyRent || price <= 0) return null;
  return +((monthlyRent * 12 / price) * 100).toFixed(2);
}

function parsePrice(val) {
  if (typeof val === 'number' && val > 1000) return val;
  const s = String(val || '').replace(/[^\d]/g, '');
  const n = parseInt(s) || 0;
  return n;
}

// Facebook stores prices in a weird sub-unit (~×10.95 of MAD)
// We parse the priceFormatted string instead
function parseFbPrice(item) {
  const fmt = item.priceFormatted || '';
  // "MAD1,040,000" or "1,040,000 MAD" or "MAD1"
  const m = fmt.replace(/MAD|mad|\s/g, '').replace(/,/g, '');
  const n = parseInt(m) || 0;
  // Reject bogus prices (MAD1, MAD0, MAD64 etc.)
  return n > 50000 ? n : 0;
}

function extractSurface(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{2,3})\s*m[²2e]/i);
  return m ? parseInt(m[1]) : null;
}

function extractQuartier(location = '') {
  for (const k of Object.keys(RATES)) {
    const kn = k.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const ln = location.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (ln.includes(kn)) return k.charAt(0).toUpperCase() + k.slice(1);
  }
  return location.split(',')[0].trim() || 'Casablanca';
}

function isMaRealEstate(title = '') {
  const t = title.toLowerCase();
  const isProperty = t.includes('appart') || t.includes('villa') || t.includes('duplex')
                   || t.includes('studio') || t.includes('maison') || t.includes('étage');
  const notCar = !t.includes('voiture') && !t.includes('véhicule') && !t.includes('renault')
               && !t.includes('toyota') && !t.includes('kia') && !t.includes('ford')
               && !t.includes('nissan') && !t.includes('mercedes') && !t.includes('laptop')
               && !t.includes('samsung') && !t.includes('iphone') && !t.includes('moto');
  return isProperty && notCar;
}

function normalize(listing) {
  const loyer = listing.loyer || estimateLoyer(listing.quartier, listing.surface);
  const brut   = calcYield(listing.prix, loyer);
  return {
    ...listing,
    loyer,
    loyerSource: listing.loyer ? 'site' : 'estimé',
    rentBrut: brut,
    rentNet:  brut ? +(brut * 0.75).toFixed(2) : null,
    prixM2:   (listing.prix && listing.surface) ? Math.round(listing.prix / listing.surface) : null,
  };
}

// ─── AVITO ────────────────────────────────────────────────────────────────
async function scrapeAvito() {
  console.log('  → Avito...');
  try {
    const run = await apify.actor('easyapi/avito-search-results-scraper').call({
      search:   `appartement vente ${CFG.city}`,
      maxItems:  CFG.maxItems,
    }, { memory: 4096 });

    const { items } = await apify.dataset(run.defaultDatasetId).listItems({ limit: 150 });

    return items
      .filter(i => {
        const p = parsePrice(i.price || i.prix || '');
        return p >= 200000 && p <= CFG.maxPrice;
      })
      .map(i => ({
        source:   'Avito',
        titre:    i.title   || i.titre || '',
        quartier: extractQuartier(i.location || i.city || i.localisation || ''),
        surface:  extractSurface(i.title || i.description || ''),
        prix:     parsePrice(i.price || i.prix || ''),
        loyer:    null,
        date:     i.date || i.publishedAt || i.created_at || null,
        url:      i.url || i.link || '',
      }));
  } catch (e) {
    console.error(`  ✗ Avito: ${e.message}`);
    return [];
  }
}

// ─── FACEBOOK MARKETPLACE ─────────────────────────────────────────────────
async function scrapeFacebook() {
  console.log('  → Facebook Marketplace...');

  const quartiers = [
    'Maarif', 'Ain+Chock', 'Hay+Hassani', 'Sidi+Maarouf',
    'Belvédère', 'Ain+Sebaa', 'Errahma',
  ];

  const allRuns = quartiers.map(q =>
    apify.actor('crowdpull/facebook-marketplace-scraper').call({
      marketplaceUrls: [
        `https://www.facebook.com/marketplace/casablanca/search/?query=appartement+${q}+vente`,
      ],
      maxListings: 20,
    }, { memory: 2048 })
    .then(run => apify.dataset(run.defaultDatasetId).listItems({ limit: 60 }))
    .then(({ items }) =>
      items
        .filter(i => {
          const p = parseFbPrice(i);
          return p >= 200000 && p <= CFG.maxPrice && isMaRealEstate(i.title || '');
        })
        .map(i => ({
          source:   'Facebook',
          titre:    i.title || '',
          quartier: extractQuartier((i.location || '') + ' ' + decodeURIComponent(q).replace(/\+/g, ' ')),
          surface:  extractSurface(i.title || ''),
          prix:     parseFbPrice(i),
          loyer:    null,
          date:     i.createdAt || null,
          url:      i.listingUrl || '',
        }))
    )
    .catch(e => { console.error(`  ✗ Facebook ${q}: ${e.message}`); return []; })
  );

  const results = await Promise.all(allRuns);
  return results.flat();
}

// ─── MUBAWAB ──────────────────────────────────────────────────────────────
async function scrapeMubawab() {
  console.log('  → Mubawab...');
  try {
    const run = await apify.actor('scraper_guru/mubawab-housing-scraper').call({
      city:     'casablanca',
      maxItems:  CFG.maxItems,
    }, { memory: 4096 });

    const { items } = await apify.dataset(run.defaultDatasetId).listItems({ limit: 150 });

    return items
      .filter(i => {
        const p = parsePrice(i.price || '');
        return p >= 200000 && p <= CFG.maxPrice;
      })
      .map(i => ({
        source:   'Mubawab',
        titre:    i.title || '',
        quartier: extractQuartier(i.district || i.neighborhood || i.location || ''),
        surface:  i.surface || i.area || extractSurface(i.title || i.description || ''),
        prix:     parsePrice(i.price || ''),
        loyer:    null,
        date:     null,
        url:      i.url || '',
      }));
  } catch (e) {
    console.error(`  ✗ Mubawab: ${e.message}`);
    return [];
  }
}

// ─── YAKEEY (via RAG browser) ─────────────────────────────────────────────
async function scrapeYakeey() {
  console.log('  → Yakeey...');
  try {
    const run = await apify.actor('apify/rag-web-browser').call({
      query: `appartement vente Casablanca site:yakeey.com`,
      startUrls: [{
        url: `https://yakeey.com/fr-ma/achat?maxPrice=${CFG.maxPrice}&city=casablanca&type=appartement`,
      }],
      maxCrawlPages: 2,
    }, { memory: 4096 });

    const { items } = await apify.dataset(run.defaultDatasetId).listItems({ limit: 50 });
    const listings = [];

    for (const item of items) {
      const text = item.text || item.markdown || '';
      // Parse price+surface pairs from Yakeey markdown text
      const blocks = text.split(/\n{2,}/);
      for (const block of blocks) {
        const priceMatch   = block.match(/(\d[\d\s]{3,8})\s*(?:DH|MAD|dh)/i);
        const surfaceMatch = block.match(/(\d{2,3})\s*m[²2e]/i);
        const loyerMatch   = block.match(/(\d[\d\s]{2,6})\s*DH\/mois/i);

        if (!priceMatch) continue;
        const prix = parsePrice(priceMatch[1]);
        if (prix < 200000 || prix > CFG.maxPrice) continue;

        const surface = surfaceMatch ? parseInt(surfaceMatch[1]) : null;
        const loyer   = loyerMatch   ? parsePrice(loyerMatch[1]) : null;

        // Extract title (first non-empty line in block)
        const titre = block.split('\n').find(l => l.trim().length > 5)?.trim() || '';

        listings.push({
          source:   'Yakeey',
          titre,
          quartier: extractQuartier(block + ' ' + titre),
          surface,
          prix,
          loyer,
          date:     null,
          url:      item.url || 'https://yakeey.com',
        });
      }
    }
    return listings;
  } catch (e) {
    console.error(`  ✗ Yakeey: ${e.message}`);
    return [];
  }
}

// ─── DEDUP ────────────────────────────────────────────────────────────────
function dedup(listings) {
  const seen = new Set();
  return listings.filter(l => {
    const key = `${l.source}|${l.prix}|${l.quartier}|${l.surface}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── REPORT ───────────────────────────────────────────────────────────────
function generateCSV(listings) {
  const header = [
    'Source','Quartier','Surface (m²)','Prix (MAD)','Prix/m²',
    'Loyer/mois (DH)','Loyer source','Rent. brute %','Rent. nette %',
    'Date','URL',
  ];
  const rows = listings.map(l => [
    l.source,
    l.quartier || '',
    l.surface  || '',
    l.prix     || '',
    l.prixM2   || '',
    l.loyer    || '',
    l.loyerSource || '',
    l.rentBrut != null ? l.rentBrut : '',
    l.rentNet  != null ? l.rentNet  : '',
    l.date ? new Date(l.date).toLocaleDateString('fr-FR') : '',
    l.url || '',
  ]);
  return [header, ...rows]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function printConsoleReport(listings) {
  const cols = {
    'Src':    6,  'Quartier': 16, 'Surf': 6,
    'Prix':   12, 'P/m²': 6,
    'Loyer':  8,  'Brut%': 6,  'Net%': 5,
    'Date':   10,
  };
  const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
  const line = Object.values(cols).map(n => '─'.repeat(n)).join('┼');

  console.log('\n' + Object.entries(cols).map(([k,v]) => pad(k,v)).join('│'));
  console.log(line);
  for (const l of listings) {
    const row = [
      pad(l.source, 6),
      pad(l.quartier, 16),
      pad(l.surface ? l.surface+'m²' : '', 6),
      pad(l.prix ? (l.prix/1000).toFixed(0)+'k' : '', 12),
      pad(l.prixM2 || '', 6),
      pad(l.loyer ? (l.loyer/1000).toFixed(1)+'k' : '', 8),
      pad(l.rentBrut != null ? l.rentBrut+'%' : '', 6),
      pad(l.rentNet  != null ? l.rentNet+'%'  : '', 5),
      pad(l.date ? new Date(l.date).toLocaleDateString('fr-FR') : '', 10),
    ];
    console.log(row.join('│'));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🏠  Agent Immobilier Casablanca                    ║
║   Budget max : ${CFG.maxPrice.toLocaleString('fr-FR').padEnd(10)} MAD                     ║
║   Sources    : Avito · Facebook · Mubawab · Yakeey   ║
╚══════════════════════════════════════════════════════╝
`);

  if (!fs.existsSync(CFG.outputDir)) fs.mkdirSync(CFG.outputDir, { recursive: true });

  // Scrape all sources in parallel
  console.log('🔍  Scraping en cours...\n');
  const [r1, r2, r3, r4] = await Promise.allSettled([
    scrapeAvito(),
    scrapeFacebook(),
    scrapeMubawab(),
    scrapeYakeey(),
  ]);

  const raw = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
    ...(r4.status === 'fulfilled' ? r4.value : []),
  ];

  console.log(`\n📊  Brut collecté : ${raw.length} annonces`);

  // Normalize → calcul rentabilité → dédup → tri
  const listings = dedup(raw.map(normalize)).filter(l => l.prix > 0);

  listings.sort((a, b) => {
    // D'abord par rentabilité brute desc
    const yDiff = (b.rentBrut || 0) - (a.rentBrut || 0);
    if (Math.abs(yDiff) > 0.1) return yDiff;
    // Puis par date desc
    if (a.date && b.date) return new Date(b.date) - new Date(a.date);
    return 0;
  });

  console.log(`✅  Après filtrage/dédup : ${listings.length} annonces uniques\n`);

  // Affichage console
  printConsoleReport(listings);

  // Export CSV
  const dateStr = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(CFG.outputDir, `casablanca_immo_${dateStr}.csv`);
  fs.writeFileSync(csvPath, generateCSV(listings), 'utf8');

  // Top 5
  const top5 = listings.filter(l => l.rentBrut).slice(0, 5);
  if (top5.length) {
    console.log('\n\n🏆  TOP 5 OPPORTUNITÉS PAR RENTABILITÉ\n');
    top5.forEach((l, i) => {
      console.log(
        `  ${i+1}. [${l.source}] ${l.quartier}${l.surface ? ' ' + l.surface + 'm²' : ''}` +
        ` — ${l.prix.toLocaleString('fr-FR')} MAD` +
        ` — Brut: ${l.rentBrut}% | Net: ${l.rentNet}%` +
        (l.url ? `\n     ${l.url}` : '')
      );
    });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\n📁  Rapport exporté : ${csvPath}`);
  console.log(`⏱  Durée totale : ${elapsed}s\n`);
}

// ─── EXPORT (pour bot.js) ─────────────────────────────────────────────────
async function runScraper() {
  const [r1, r2, r3, r4] = await Promise.allSettled([
    scrapeAvito(),
    scrapeFacebook(),
    scrapeMubawab(),
    scrapeYakeey(),
  ]);
  const raw = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
    ...(r4.status === 'fulfilled' ? r4.value : []),
  ];
  const listings = dedup(raw.map(normalize)).filter(l => l.prix > 0);
  listings.sort((a, b) => {
    const d = (b.rentBrut || 0) - (a.rentBrut || 0);
    if (Math.abs(d) > 0.1) return d;
    if (a.date && b.date) return new Date(b.date) - new Date(a.date);
    return 0;
  });
  return listings;
}

module.exports = { runScraper, generateCSV, CFG };

// ─── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(e => {
    console.error('\n❌  Erreur fatale :', e.message);
    process.exit(1);
  });
}
