#!/usr/bin/env node
'use strict';
require('dotenv').config();

const { ApifyClient } = require('apify-client');
const axios           = require('axios');
const cheerio         = require('cheerio');
const fs = require('fs');
const path = require('path');

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

// ─── AVITO (scraping direct — gratuit) ───────────────────────────────────
async function scrapeAvito() {
  console.log('  → Avito (direct)...');
  const listings = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const url = `https://www.avito.ma/fr/maroc/appartements--%C3%A0_vendre?o=${page}&location=Casablanca&price_max=${CFG.maxPrice}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('article, [data-testid="ad-card"], .sc-1nre5ec-1').each((_, el) => {
        const title  = $(el).find('h3, [data-testid="ad-title"], .sc-1nre5ec-10').first().text().trim();
        const priceT = $(el).find('[data-testid="price"], .sc-1x0vz2r-0, .price').first().text().trim();
        const locT   = $(el).find('[data-testid="location"], .sc-1nre5ec-12').first().text().trim();
        const dateT  = $(el).find('time, [data-testid="date"]').first().attr('datetime') || null;
        const href   = $(el).find('a').first().attr('href') || '';

        const prix = parsePrice(priceT);
        if (!prix || prix < 200000 || prix > CFG.maxPrice) return;
        if (!isMaRealEstate(title)) return;

        listings.push({
          source:   'Avito',
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(title),
          prix,
          loyer:    null,
          date:     dateT,
          url:      href.startsWith('http') ? href : 'https://www.avito.ma' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (e) {
    console.error(`  ✗ Avito: ${e.message}`);
  }
  return listings;
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

// ─── MUBAWAB (scraping direct — gratuit) ─────────────────────────────────
async function scrapeMubawab() {
  console.log('  → Mubawab (direct)...');
  const listings = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const url = `https://www.mubawab.ma/fr/sc/immobilier-a-vendre:p:${page}?city=casablanca&priceMax=${CFG.maxPrice}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('li.listingBox, .sc-card-listing').each((_, el) => {
        const title  = $(el).find('h2, h3, .listingTit').first().text().trim();
        const priceT = $(el).find('.price, .listingPrice, [class*="price"]').first().text().trim();
        const locT   = $(el).find('.listingDetails, [class*="location"], [class*="city"]').first().text().trim();
        const href   = $(el).find('a').first().attr('href') || '';
        const surfT  = $(el).find('[class*="size"], [class*="surface"]').first().text().trim();

        const prix = parsePrice(priceT);
        if (!prix || prix < 200000 || prix > CFG.maxPrice) return;

        listings.push({
          source:   'Mubawab',
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(surfT || title),
          prix,
          loyer:    null,
          date:     null,
          url:      href.startsWith('http') ? href : 'https://www.mubawab.ma' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (e) {
    console.error(`  ✗ Mubawab: ${e.message}`);
  }
  return listings;
}

// ─── YAKEEY (scraping direct — gratuit) ──────────────────────────────────
async function scrapeYakeey() {
  console.log('  → Yakeey (direct)...');
  const listings = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const url = `https://yakeey.com/fr-ma/achat?maxPrice=${CFG.maxPrice}&city=casablanca&type=appartement&page=${page}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      // Yakeey listing cards
      $('[class*="PropertyCard"], [class*="listing-card"], [class*="property-item"], article').each((_, el) => {
        const title  = $(el).find('[class*="title"], h2, h3').first().text().trim();
        const priceT = $(el).find('[class*="price"], [class*="Price"]').first().text().trim();
        const locT   = $(el).find('[class*="location"], [class*="city"], [class*="zone"]').first().text().trim();
        const surfT  = $(el).find('[class*="surface"], [class*="area"], [class*="size"]').first().text().trim();
        const loyerT = $(el).find('[class*="rent"], [class*="loyer"]').first().text().trim();
        const href   = $(el).find('a').first().attr('href') || '';

        const prix = parsePrice(priceT);
        if (!prix || prix < 200000 || prix > CFG.maxPrice) return;

        listings.push({
          source:   'Yakeey',
          titre:    title,
          quartier: extractQuartier(locT || title),
          surface:  extractSurface(surfT || title),
          prix,
          loyer:    loyerT ? parsePrice(loyerT) : null,
          date:     null,
          url:      href.startsWith('http') ? href : 'https://yakeey.com' + href,
        });
      });

      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (e) {
    console.error(`  ✗ Yakeey: ${e.message}`);
  }
  return listings;
}

// ─── CALIBRATION LOYERS via Yakeey Location ───────────────────────────────
// Scrape les annonces de location Yakeey → calcule le vrai DH/m²/mois par quartier
async function calibrateRatesFromYakeey() {
  console.log('  → Calibration loyers (Yakeey location)...');

  // bucket: { quartier → [DH/m²] }
  const buckets = {};

  const pushSample = (quartier, loyer, surface) => {
    if (!quartier || !loyer || !surface || surface < 20 || surface > 400) return;
    const rate = loyer / surface;
    if (rate < 20 || rate > 200) return; // filtre aberrations
    const q = quartier.toLowerCase();
    buckets[q] = buckets[q] || [];
    buckets[q].push(rate);
  };

  try {
    for (let page = 1; page <= 4; page++) {
      const url = `https://yakeey.com/fr-ma/location?city=casablanca&type=appartement&page=${page}`;
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

        // Yakeey location : prix en DH/mois (fourchette 1 000–50 000)
        if (loyer >= 1000 && loyer <= 50000) {
          pushSample(quartier, loyer, surface);
        }
      });

      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error(`  ✗ Calibration Yakeey: ${e.message}`);
    return; // garde les taux statiques
  }

  // Calcule la médiane pour chaque quartier et met à jour RATES
  let updated = 0;
  for (const [quartier, samples] of Object.entries(buckets)) {
    if (samples.length < 2) continue; // besoin d'au moins 2 points
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const rounded = Math.round(median);

    // Trouve la clé dans RATES (correspondance partielle)
    const key = Object.keys(RATES).find(k =>
      quartier.includes(k.normalize('NFD').replace(/[̀-ͯ]/g, '')) ||
      k.normalize('NFD').replace(/[̀-ͯ]/g, '').includes(quartier)
    );

    if (key) {
      const old = RATES[key];
      RATES[key] = rounded;
      if (old !== rounded) {
        console.log(`    ↻ ${key}: ${old} → ${rounded} DH/m²/mois (${samples.length} annonces)`);
        updated++;
      }
    } else if (rounded > 0) {
      // Nouveau quartier non connu : on l'ajoute
      RATES[quartier] = rounded;
      console.log(`    + ${quartier}: ${rounded} DH/m²/mois (${samples.length} annonces) [nouveau]`);
      updated++;
    }
  }

  if (updated === 0) {
    console.log('    Taux déjà à jour ou données insuffisantes');
  } else {
    console.log(`    ${updated} quartier(s) recalibrés depuis Yakeey`);
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

  // Étape 0 : calibration des taux locatifs depuis Yakeey
  console.log('📐  Calibration des loyers marché (Yakeey)...\n');
  await calibrateRatesFromYakeey();

  // Scrape all sources in parallel
  console.log('\n🔍  Scraping annonces en cours...\n');
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
  await calibrateRatesFromYakeey();
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
