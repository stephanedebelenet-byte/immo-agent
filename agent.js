#!/usr/bin/env node
'use strict';
require('dotenv').config();

const { ApifyClient } = require('apify-client');
const axios           = require('axios');
const cheerio         = require('cheerio');
const fs              = require('fs');
const path            = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── SETUP ────────────────────────────────────────────────────────────────
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error('\n❌  APIFY_TOKEN manquant dans .env\n'); process.exit(1); }

const apify = new ApifyClient({ token: TOKEN });

const CFG = {
  maxPrice:  parseInt(process.env.MAX_PRICE  || '3000000'),
  maxItems:  parseInt(process.env.MAX_ITEMS_PER_SOURCE || '50'),
  city:      process.env.CITY || 'Casablanca',
  outputDir: path.join(__dirname, 'rapports'),
};

// ─── CONFIG PAR TYPE DE BIEN ──────────────────────────────────────────────
const TYPE_CONFIG = {
  appartement: {
    label:     'Appart.',
    emoji:     '🏠',
    avito:     'appartements',
    mubawab:   'immobilier-a-vendre',
    yakeey:    'appartement',
    yakeeyLoc: 'appartement',
  },
  bureau: {
    label:     'Bureau',
    emoji:     '🏢',
    avito:     'bureaux_et_plateaux',
    mubawab:   'bureaux-et-plateaux-a-vendre',
    yakeey:    'bureau',
    yakeeyLoc: 'bureau',
  },
  terrain: {
    label:     'Terrain',
    emoji:     '🌿',
    avito:     'terrains',
    mubawab:   'terrains-a-vendre',
    yakeey:    'terrain',
    yakeeyLoc: null,
  },
  maison: {
    label:     'Maison',
    emoji:     '🏘️',
    avito:     'maisons_et_villas',
    mubawab:   'maisons-et-villas-a-vendre',
    yakeey:    'villa',
    yakeeyLoc: 'villa',
  },
  magasin: {
    label:     'Magasin',
    emoji:     '🏪',
    avito:     'locaux_et_commerces',
    mubawab:   'locaux-et-commerces-a-vendre',
    yakeey:    'local-commercial',
    yakeeyLoc: 'local-commercial',
  },
};

const TYPES = Object.keys(TYPE_CONFIG);

// ─── TAUX LOCATIFS RÉSIDENTIEL (DH/m²/mois) ──────────────────────────────
// Appartements + Maisons
const RATES = {
  'gauthier':      95,  'racine':        92,  'anfa':          88,
  'bourgogne':     85,  'maarif':        75,  'val fleuri':    70,
  'belvédère':     68,  'belvedere':     68,  'nassim':        65,
  'bachkou':       65,  'ain chock':     60,  'hay hassani':   60,
  'florida':       58,  'sidi maarouf':  55,  'souriyate':     55,
  'ain sebaa':     50,  'errahma':       48,  'sidi moumen':   45,
  'moulay rachid': 44,  'hay mohammadi': 40,
};
const DEFAULT_RATE = 55;

// ─── TAUX LOCATIFS BUREAUX (DH/m²/mois) ──────────────────────────────────
const RATES_BUREAU = {
  'gauthier':      120, 'racine':        115, 'anfa':          110,
  'bourgogne':     100, 'maarif':         95, 'val fleuri':     85,
  'belvédère':      80, 'belvedere':      80, 'nassim':         80,
  'sidi maarouf':   75, 'ain chock':      65, 'hay hassani':    65,
  'florida':        60, 'ain sebaa':      55, 'errahma':        50,
  'sidi moumen':    45, 'moulay rachid':  40,
};
const DEFAULT_RATE_BUREAU = 70;

// ─── TAUX LOCATIFS MAGASINS (DH/m²/mois) ────────────────────────────────
const RATES_MAGASIN = {
  'gauthier':      180, 'racine':        175, 'anfa':          170,
  'maarif':        160, 'bourgogne':     155, 'val fleuri':    120,
  'belvédère':     110, 'belvedere':     110, 'nassim':        100,
  'ain chock':      80, 'hay hassani':    80, 'florida':        75,
  'sidi maarouf':   70, 'ain sebaa':      65, 'errahma':        60,
  'sidi moumen':    55, 'moulay rachid':  50, 'hay mohammadi':  45,
};
const DEFAULT_RATE_MAGASIN = 80;

// ─── BENCHMARK PRIX TERRAIN (DH/m²) ──────────────────────────────────────
// Référence marché pour comparer les annonces terrain
const TERRAIN_BENCHMARK = {
  'gauthier':     30000, 'racine':       28000, 'anfa':         25000,
  'bourgogne':    22000, 'maarif':       18000, 'val fleuri':   15000,
  'belvédère':    14000, 'belvedere':    14000, 'nassim':       13000,
  'bachkou':      12000, 'ain chock':    10000, 'hay hassani':   9000,
  'florida':       8500, 'sidi maarouf':  8000, 'souriyate':     7500,
  'ain sebaa':     7000, 'errahma':       6000, 'sidi moumen':   5500,
  'moulay rachid': 5000, 'hay mohammadi': 4500,
};
const DEFAULT_TERRAIN_BENCHMARK = 8000;

// ─── HELPERS ──────────────────────────────────────────────────────────────
function normStr(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function getRatesTable(type) {
  if (type === 'bureau')  return [RATES_BUREAU,  DEFAULT_RATE_BUREAU];
  if (type === 'magasin') return [RATES_MAGASIN, DEFAULT_RATE_MAGASIN];
  return [RATES, DEFAULT_RATE];
}

function getRate(location = '', type = 'appartement') {
  const [table, def] = getRatesTable(type);
  const loc = normStr(location);
  for (const [k, v] of Object.entries(table)) {
    if (loc.includes(normStr(k))) return v;
  }
  return def;
}

function getTerrainBenchmark(location = '') {
  const loc = normStr(location);
  for (const [k, v] of Object.entries(TERRAIN_BENCHMARK)) {
    if (loc.includes(normStr(k))) return v;
  }
  return DEFAULT_TERRAIN_BENCHMARK;
}

function estimateLoyer(location, surface, type = 'appartement') {
  if (!surface || surface <= 0) return null;
  return Math.round(surface * getRate(location, type));
}

function calcYield(price, monthlyRent) {
  if (!price || !monthlyRent || price <= 0) return null;
  return +((monthlyRent * 12 / price) * 100).toFixed(2);
}

function parsePrice(val) {
  if (typeof val === 'number' && val > 1000) return val;
  const s = String(val || '').replace(/[^\d]/g, '');
  return parseInt(s) || 0;
}

function parseFbPrice(item) {
  const fmt = item.priceFormatted || '';
  const m = fmt.replace(/MAD|mad|\s/g, '').replace(/,/g, '');
  const n = parseInt(m) || 0;
  return n > 50000 ? n : 0;
}

function extractSurface(text) {
  if (!text) return null;
  const ha = String(text).match(/(\d+(?:[.,]\d+)?)\s*ha\b/i);
  if (ha) return Math.round(parseFloat(ha[1].replace(',', '.')) * 10000);
  const m = String(text).match(/(\d{2,5})\s*m[²2e]/i);
  return m ? parseInt(m[1]) : null;
}

// Clés de quartiers uniques (toutes tables confondues)
const ALL_QUARTIER_KEYS = [...new Set([
  ...Object.keys(RATES),
  ...Object.keys(RATES_BUREAU),
  ...Object.keys(RATES_MAGASIN),
  ...Object.keys(TERRAIN_BENCHMARK),
])];

function extractQuartier(location = '') {
  const loc = normStr(location);
  for (const k of ALL_QUARTIER_KEYS) {
    if (loc.includes(normStr(k))) return k.charAt(0).toUpperCase() + k.slice(1);
  }
  return location.split(',')[0].trim() || 'Casablanca';
}

function normalize(listing) {
  if (listing.type === 'terrain') {
    const prixM2    = listing.surface ? Math.round(listing.prix / listing.surface) : null;
    const benchmark = getTerrainBenchmark(listing.quartier);
    const vsMarche  = (prixM2 && benchmark)
      ? Math.round((prixM2 - benchmark) / benchmark * 100)
      : null;
    return { ...listing, loyer: null, loyerSource: null, rentBrut: null, rentNet: null, prixM2, vsMarche };
  }
  const loyer = listing.loyer || estimateLoyer(listing.quartier, listing.surface, listing.type);
  const brut  = calcYield(listing.prix, loyer);
  return {
    ...listing,
    loyer,
    loyerSource: listing.loyer ? 'site' : 'estimé',
    rentBrut:   brut,
    rentNet:    brut ? +(brut * 0.75).toFixed(2) : null,
    prixM2:     (listing.prix && listing.surface) ? Math.round(listing.prix / listing.surface) : null,
    vsMarche:   null,
  };
}

function dedup(listings) {
  const seen = new Set();
  return listings.filter(l => {
    const key = `${l.source}|${l.type}|${l.prix}|${l.quartier}|${l.surface}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── CALIBRATION TAUX LOCATIFS (Yakeey location) ─────────────────────────
async function calibrateTable(yakeeyType, table) {
  const buckets = {};
  const push = (quartier, loyer, surface) => {
    if (!quartier || !loyer || !surface || surface < 10 || surface > 5000) return;
    const rate = loyer / surface;
    if (rate < 10 || rate > 600) return;
    const q = normStr(quartier);
    buckets[q] = buckets[q] || [];
    buckets[q].push(rate);
  };

  try {
    for (let page = 1; page <= 3; page++) {
      const url = `https://yakeey.com/fr-ma/location?city=casablanca&type=${yakeeyType}&page=${page}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('[class*="PropertyCard"], [class*="listing-card"], [class*="property-item"], article').each((_, el) => {
        const locT   = $(el).find('[class*="location"], [class*="city"], [class*="zone"]').first().text().trim();
        const priceT = $(el).find('[class*="price"], [class*="Price"]').first().text().trim();
        const surfT  = $(el).find('[class*="surface"], [class*="area"], [class*="size"]').first().text().trim();
        const titleT = $(el).find('[class*="title"], h2, h3').first().text().trim();

        const loyer   = parsePrice(priceT);
        const surface = extractSurface(surfT || titleT);
        const quartier = extractQuartier(locT || titleT);
        if (loyer >= 500 && loyer <= 200000) push(quartier, loyer, surface);
      });

      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error(`  ✗ Calibration ${yakeeyType}: ${e.message}`);
    return;
  }

  let updated = 0;
  for (const [quartier, samples] of Object.entries(buckets)) {
    if (samples.length < 2) continue;
    samples.sort((a, b) => a - b);
    const rounded = Math.round(samples[Math.floor(samples.length / 2)]);
    const key = Object.keys(table).find(k =>
      normStr(quartier).includes(normStr(k)) || normStr(k).includes(normStr(quartier))
    );
    if (key) {
      const old = table[key];
      table[key] = rounded;
      if (old !== rounded) {
        console.log(`    ↻ [${yakeeyType}] ${key}: ${old} → ${rounded} DH/m²/mois (${samples.length} pts)`);
        updated++;
      }
    } else if (rounded > 0) {
      table[quartier] = rounded;
      console.log(`    + [${yakeeyType}] ${quartier}: ${rounded} DH/m²/mois [nouveau]`);
      updated++;
    }
  }
  if (updated === 0) console.log(`    [${yakeeyType}] taux déjà à jour`);
}

async function calibrateRatesFromYakeey() {
  console.log('  → Calibration loyers marché (Yakeey)...');
  await calibrateTable('appartement',    RATES);
  await calibrateTable('bureau',         RATES_BUREAU);
  await calibrateTable('villa',          RATES);         // maisons → table résidentiel
  await calibrateTable('local-commercial', RATES_MAGASIN);
  console.log('  ✓ Calibration terminée');
}

// ─── AVITO (scraping direct — gratuit) ───────────────────────────────────
async function scrapeAvitoType(type) {
  const { avito: seg } = TYPE_CONFIG[type];
  const results = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const url = `https://www.avito.ma/fr/maroc/${seg}--%C3%A0_vendre?o=${page}&location=Casablanca&price_max=${CFG.maxPrice}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('article, [data-testid="ad-card"], .sc-1nre5ec-1').each((_, el) => {
        const title  = $(el).find('h3, [data-testid="ad-title"], .sc-1nre5ec-10').first().text().trim();
        const priceT = $(el).find('[data-testid="price"], .sc-1x0vz2r-0, .price').first().text().trim();
        const locT   = $(el).find('[data-testid="location"], .sc-1nre5ec-12').first().text().trim();
        const dateT  = $(el).find('time, [data-testid="date"]').first().attr('datetime') || null;
        const href   = $(el).find('a').first().attr('href') || '';

        const prix = parsePrice(priceT);
        if (!prix || prix < 50000 || prix > CFG.maxPrice) return;

        results.push({
          source:   'Avito',
          type,
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(title),
          prix,
          loyer:    null,
          date:     dateT,
          url:      href.startsWith('http') ? href : 'https://www.avito.ma' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ✗ Avito ${type} p${page}: ${e.message}`);
    }
  }
  return results;
}

async function scrapeAvito() {
  console.log('  → Avito (appart · bureau · terrain · maison · magasin)...');
  const all = [];
  for (const type of TYPES) {
    const res = await scrapeAvitoType(type);
    all.push(...res);
  }
  return all;
}

// ─── MUBAWAB (scraping direct — gratuit) ─────────────────────────────────
async function scrapeMubawabType(type) {
  const { mubawab: seg } = TYPE_CONFIG[type];
  const results = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const url = `https://www.mubawab.ma/fr/sc/${seg}:p:${page}?city=casablanca&priceMax=${CFG.maxPrice}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('li.listingBox, .sc-card-listing, [class*="listing-item"]').each((_, el) => {
        const title  = $(el).find('h2, h3, .listingTit').first().text().trim();
        const priceT = $(el).find('.price, .listingPrice, [class*="price"]').first().text().trim();
        const locT   = $(el).find('.listingDetails, [class*="location"], [class*="city"]').first().text().trim();
        const surfT  = $(el).find('[class*="size"], [class*="surface"]').first().text().trim();
        const href   = $(el).find('a').first().attr('href') || '';

        const prix = parsePrice(priceT);
        if (!prix || prix < 50000 || prix > CFG.maxPrice) return;

        results.push({
          source:   'Mubawab',
          type,
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(surfT || title),
          prix,
          loyer:    null,
          date:     null,
          url:      href.startsWith('http') ? href : 'https://www.mubawab.ma' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ✗ Mubawab ${type} p${page}: ${e.message}`);
    }
  }
  return results;
}

async function scrapeMubawab() {
  console.log('  → Mubawab (appart · bureau · terrain · maison · magasin)...');
  const all = [];
  for (const type of TYPES) {
    const res = await scrapeMubawabType(type);
    all.push(...res);
  }
  return all;
}

// ─── YAKEEY (scraping direct — gratuit) ──────────────────────────────────
async function scrapeYakeeyType(type) {
  const { yakeey: yType } = TYPE_CONFIG[type];
  const results = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const url = `https://yakeey.com/fr-ma/achat?maxPrice=${CFG.maxPrice}&city=casablanca&type=${yType}&page=${page}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('[class*="PropertyCard"], [class*="listing-card"], [class*="property-item"], article').each((_, el) => {
        const title  = $(el).find('[class*="title"], h2, h3').first().text().trim();
        const priceT = $(el).find('[class*="price"], [class*="Price"]').first().text().trim();
        const locT   = $(el).find('[class*="location"], [class*="city"], [class*="zone"]').first().text().trim();
        const surfT  = $(el).find('[class*="surface"], [class*="area"], [class*="size"]').first().text().trim();
        const loyerT = $(el).find('[class*="rent"], [class*="loyer"]').first().text().trim();
        const href   = $(el).find('a').first().attr('href') || '';

        const prix = parsePrice(priceT);
        if (!prix || prix < 50000 || prix > CFG.maxPrice) return;

        results.push({
          source:   'Yakeey',
          type,
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(surfT || title),
          prix,
          loyer:    loyerT ? parsePrice(loyerT) : null,
          date:     null,
          url:      href.startsWith('http') ? href : 'https://yakeey.com' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ✗ Yakeey ${type} p${page}: ${e.message}`);
    }
  }
  return results;
}

async function scrapeYakeey() {
  console.log('  → Yakeey (appart · bureau · terrain · maison · magasin)...');
  const all = [];
  for (const type of TYPES) {
    const res = await scrapeYakeeyType(type);
    all.push(...res);
  }
  return all;
}

// ─── FACEBOOK MARKETPLACE (Apify — appartements uniquement) ───────────────
// Limité aux appartements pour préserver les crédits Apify
async function scrapeFacebook() {
  console.log('  → Facebook Marketplace (appartements)...');

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
          return p >= 100000 && p <= CFG.maxPrice;
        })
        .map(i => ({
          source:   'Facebook',
          type:     'appartement',
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

// ─── REPORT ───────────────────────────────────────────────────────────────
function generateCSV(listings) {
  const header = [
    'Type','Source','Quartier','Surface (m²)','Prix (MAD)','Prix/m²',
    'Loyer/mois (DH)','Loyer source','Rent. brute %','Rent. nette %',
    'Vs marché terrain %','Date','URL',
  ];
  const rows = listings.map(l => [
    TYPE_CONFIG[l.type]?.label || l.type || '',
    l.source,
    l.quartier   || '',
    l.surface    || '',
    l.prix       || '',
    l.prixM2     || '',
    l.loyer      || '',
    l.loyerSource || '',
    l.rentBrut != null ? l.rentBrut : '',
    l.rentNet  != null ? l.rentNet  : '',
    l.vsMarche != null ? l.vsMarche : '',
    l.date ? new Date(l.date).toLocaleDateString('fr-FR') : '',
    l.url || '',
  ]);
  return [header, ...rows]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function printConsoleReport(listings) {
  const cols = {
    'Type': 8, 'Src': 6, 'Quartier': 16, 'Surf': 6,
    'Prix': 12, 'P/m²': 7, 'Loyer': 8, 'Brut%': 6, 'Net%': 5, 'Vs%': 5, 'Date': 10,
  };
  const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
  const line = Object.values(cols).map(n => '─'.repeat(n)).join('┼');

  console.log('\n' + Object.entries(cols).map(([k, v]) => pad(k, v)).join('│'));
  console.log(line);
  for (const l of listings) {
    const row = [
      pad(TYPE_CONFIG[l.type]?.label || l.type || '', 8),
      pad(l.source, 6),
      pad(l.quartier, 16),
      pad(l.surface ? l.surface + 'm²' : '', 6),
      pad(l.prix ? (l.prix / 1000).toFixed(0) + 'k' : '', 12),
      pad(l.prixM2 || '', 7),
      pad(l.loyer ? (l.loyer / 1000).toFixed(1) + 'k' : '', 8),
      pad(l.rentBrut != null ? l.rentBrut + '%' : '', 6),
      pad(l.rentNet  != null ? l.rentNet  + '%' : '', 5),
      pad(l.vsMarche != null ? l.vsMarche + '%' : '', 5),
      pad(l.date ? new Date(l.date).toLocaleDateString('fr-FR') : '', 10),
    ];
    console.log(row.join('│'));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🏠  Agent Immobilier Casablanca                            ║
║   Budget max : ${CFG.maxPrice.toLocaleString('fr-FR').padEnd(10)} MAD                           ║
║   Types      : Appart · Bureau · Terrain · Maison · Magasin ║
║   Sources    : Avito · Facebook · Mubawab · Yakeey           ║
╚══════════════════════════════════════════════════════════════╝
`);

  if (!fs.existsSync(CFG.outputDir)) fs.mkdirSync(CFG.outputDir, { recursive: true });

  console.log('📐  Calibration des taux locatifs marché (Yakeey)...\n');
  await calibrateRatesFromYakeey();

  console.log('\n🔍  Scraping toutes sources et tous types...\n');
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

  const listings = sortListings(raw);
  console.log(`✅  Après filtrage/dédup : ${listings.length} annonces uniques\n`);

  printConsoleReport(listings);

  const dateStr = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(CFG.outputDir, `casablanca_immo_${dateStr}.csv`);
  fs.writeFileSync(csvPath, generateCSV(listings), 'utf8');

  const top5 = listings.filter(l => l.rentBrut || l.vsMarche != null).slice(0, 5);
  if (top5.length) {
    console.log('\n\n🏆  TOP 5 OPPORTUNITÉS\n');
    top5.forEach((l, i) => {
      const typeEmoji = TYPE_CONFIG[l.type]?.emoji || '';
      let detail = '';
      if (l.type === 'terrain') {
        detail = l.vsMarche != null ? ` — ${l.vsMarche > 0 ? '+' : ''}${l.vsMarche}% vs marché` : '';
      } else {
        detail = l.rentBrut ? ` — Brut: ${l.rentBrut}% | Net: ${l.rentNet}%` : '';
      }
      console.log(
        `  ${i+1}. ${typeEmoji} [${l.source}] ${l.quartier}${l.surface ? ' ' + l.surface + 'm²' : ''}` +
        ` — ${l.prix.toLocaleString('fr-FR')} MAD${detail}` +
        (l.url ? `\n     ${l.url}` : '')
      );
    });
  }

  console.log(`\n\n📁  Rapport : ${csvPath}`);
  console.log(`⏱  Durée : ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
}

// ─── EXPORT (pour bot.js) ─────────────────────────────────────────────────
function sortListings(listings) {
  return dedup(listings.map(normalize))
    .filter(l => l.prix > 0)
    .sort((a, b) => {
      // Terrains : tri par vsMarche croissant (moins cher vs marché = meilleure opportunité)
      if (a.type === 'terrain' && b.type === 'terrain') {
        if (a.vsMarche != null && b.vsMarche != null) return a.vsMarche - b.vsMarche;
        return 0;
      }
      // Autres : tri par rentabilité brute décroissante
      const d = (b.rentBrut || 0) - (a.rentBrut || 0);
      if (Math.abs(d) > 0.1) return d;
      if (a.date && b.date) return new Date(b.date) - new Date(a.date);
      return 0;
    });
}

async function runScraper() {
  await calibrateRatesFromYakeey();
  const [r1, r2, r3, r4] = await Promise.allSettled([
    scrapeAvito(),
    scrapeFacebook(),
    scrapeMubawab(),
    scrapeYakeey(),
  ]);
  return sortListings([
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
    ...(r4.status === 'fulfilled' ? r4.value : []),
  ]);
}

async function runQuickScan() {
  await calibrateRatesFromYakeey();
  const [r1, r2, r3] = await Promise.allSettled([
    scrapeAvito(),
    scrapeMubawab(),
    scrapeYakeey(),
  ]);
  return sortListings([
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ]);
}

module.exports = { runScraper, runQuickScan, generateCSV, CFG, TYPE_CONFIG };

// ─── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(e => {
    console.error('\n❌  Erreur fatale :', e.message);
    process.exit(1);
  });
}
