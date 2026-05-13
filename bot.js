'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { CronJob }          = require('cron');
const fs                   = require('fs');
const path                 = require('path');
const http                 = require('http');
const { runScraper, runQuickScan, generateCSV, CFG, TYPE_CONFIG } = require('./agent');

// Webhook config
const PORT         = parseInt(process.env.PORT || '3000');
const WEBHOOK_HOST = 'immo-agent-production-5dfb.up.railway.app';
const WEBHOOK_PATH = '/tg/' + (process.env.TELEGRAM_BOT_TOKEN || '').slice(-10);
const WEBHOOK_URL  = 'https://' + WEBHOOK_HOST + WEBHOOK_PATH;

// ─── SETUP ────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = process.env.TELEGRAM_CHAT_ID; // ton chat ID perso (sécurité)

if (!BOT_TOKEN) { console.error('❌  TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// État global
let lastResults   = null;
let lastScanDate  = null;
let isRunning     = false;

// ─── MIDDLEWARE SÉCURITÉ ──────────────────────────────────────────────────
bot.use((ctx, next) => {
  const userId = String(ctx.from?.id || '');
  if (ALLOWED_ID && userId !== ALLOWED_ID) {
    return ctx.reply('❌ Accès non autorisé.');
  }
  return next();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────
function fmtPrice(n) {
  return n ? n.toLocaleString('fr-FR') + ' MAD' : '-';
}

function fmtListingMessage(l, i) {
  const typeEmoji = TYPE_CONFIG?.[l.type]?.emoji || '';
  const typeLabel = TYPE_CONFIG?.[l.type]?.label || l.type || '';
  const header    = `*${i}. ${typeEmoji} [${l.source}·${typeLabel}] ${l.quartier}*`;
  const prixLine  = `💰 ${fmtPrice(l.prix)}${l.surface ? ` · ${l.surface} m²` : ''}${l.prixM2 ? ` · *${l.prixM2.toLocaleString('fr-FR')} DH/m²*` : ''}`;

  let rentLine;
  if (l.type === 'terrain') {
    if (l.vsMarche != null) {
      const sign  = l.vsMarche > 0 ? '+' : '';
      const label = l.vsMarche <= -10 ? '🟢 Sous le marché' : l.vsMarche >= 10 ? '🔴 Au-dessus du marché' : '🟡 Prix marché';
      rentLine = `📊 ${label} : *${sign}${l.vsMarche}%* vs benchmark Casablanca`;
    } else {
      rentLine = `📊 Terrain — prix/m² à comparer`;
    }
  } else {
    rentLine = `📊 Brut: *${l.rentBrut ?? '-'}%* · Net: *${l.rentNet ?? '-'}%*`;
  }

  const lines = [
    header,
    prixLine,
    rentLine,
    l.loyer ? `🔑 Loyer ~${l.loyer.toLocaleString('fr-FR')} DH/mois _(${l.loyerSource})_` : null,
    l.date  ? `📅 ${new Date(l.date).toLocaleDateString('fr-FR')}` : null,
    l.url   ? `🔗 [Voir l'annonce](${l.url})` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

async function sendResults(ctx, listings, limit = 10) {
  if (!listings?.length) return ctx.reply('Aucune annonce trouvée.');

  const top = listings.slice(0, limit);
  const date = lastScanDate ? lastScanDate.toLocaleDateString('fr-FR') : '-';
  const header = `🏆 *Top ${top.length} opportunités* — ${date}\n` +
                 `Budget max : ${CFG.maxPrice.toLocaleString('fr-FR')} MAD\n` +
                 `🏠 Appart · 🏢 Bureau · 🌿 Terrain · 🏘️ Maison · 🏪 Magasin\n\n`;

  // Découpe en chunks (limite Telegram 4096 chars)
  const chunks = [header];
  for (let i = 0; i < top.length; i++) {
    chunks.push(fmtListingMessage(top[i], i + 1) + '\n');
  }

  // Regroupe en messages de max 3900 chars
  let buffer = '';
  for (const chunk of chunks) {
    if ((buffer + chunk).length > 3900) {
      await ctx.replyWithMarkdown(buffer, { disable_web_page_preview: true });
      buffer = chunk;
    } else {
      buffer += chunk;
    }
  }
  if (buffer) await ctx.replyWithMarkdown(buffer, { disable_web_page_preview: true });
}

async function sendCSV(ctx, listings) {
  const csv = generateCSV(listings);
  const dateStr = new Date().toISOString().slice(0, 10);
  const tmpPath = path.join('/tmp', `casablanca_immo_${dateStr}.csv`);
  fs.writeFileSync(tmpPath, csv, 'utf8');
  await ctx.replyWithDocument({ source: tmpPath, filename: `casablanca_immo_${dateStr}.csv` });
}

async function doScan(ctx) {
  if (isRunning) {
    return ctx.reply('⏳ Scan déjà en cours, patiente...');
  }
  isRunning = true;
  const msg = await ctx.reply(
    '🔍 Scan lancé — *Avito · Facebook · Mubawab · Yakeey*\n' +
    '🏠 Appart · 🏢 Bureau · 🌿 Terrain · 🏘️ Maison · 🏪 Magasin\n' +
    '⏱ Durée estimée : 8-15 min\nJe t\'envoie les résultats dès que c\'est prêt.',
    { parse_mode: 'Markdown' }
  );

  try {
    const listings = await runScraper();
    lastResults  = listings;
    lastScanDate = new Date();
    isRunning    = false;

    await ctx.reply(`✅ Scan terminé — ${listings.length} annonces trouvées`);
    await sendResults(ctx, listings, 10);
    if (listings.length) await sendCSV(ctx, listings);
  } catch (e) {
    isRunning = false;
    console.error('Scan error:', e);
    await ctx.reply(`❌ Erreur pendant le scan : ${e.message}`);
  }
}

// ─── COMMANDES ────────────────────────────────────────────────────────────
bot.command('start', ctx => {
  ctx.replyWithMarkdown(
    `🏠 *Agent Immobilier Casablanca*\n\n` +
    `Je scrape Avito, Facebook, Mubawab et Yakeey pour tous types de biens :\n` +
    `🏠 Appartements · 🏢 Bureaux · 🌿 Terrains · 🏘️ Maisons · 🏪 Magasins\n\n` +
    `Rentabilité calculée par type · Terrains comparés au marché Yakeey\n\n` +
    `*Commandes :*\n` +
    `/scan — Lancer un scan complet\n` +
    `/top10 — Top 10 du dernier scan\n` +
    `/top20 — Top 20 du dernier scan\n` +
    `/csv — Recevoir le CSV complet\n` +
    `/status — Statut et dernier scan\n` +
    `/schedule — Voir le planning des scans auto\n` +
    `/budget 2500000 — Changer le budget max\n` +
    `/help — Aide\n\n` +
    `📅 6 scans automatiques/jour aux heures de pic`
  );
});

bot.command('help', ctx => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/start' } }));

bot.command('scan', ctx => doScan(ctx));

bot.command('top10', async ctx => {
  if (!lastResults) return ctx.reply('Aucun scan effectué. Lance /scan d\'abord.');
  await sendResults(ctx, lastResults, 10);
});

bot.command('top20', async ctx => {
  if (!lastResults) return ctx.reply('Aucun scan effectué. Lance /scan d\'abord.');
  await sendResults(ctx, lastResults, 20);
});

bot.command('csv', async ctx => {
  if (!lastResults?.length) return ctx.reply('Aucune donnée. Lance /scan d\'abord.');
  await sendCSV(ctx, lastResults);
});

bot.command('status', ctx => {
  const lines = [
    `🤖 *Status Agent Immobilier*`,
    ``,
    `Budget max : ${CFG.maxPrice.toLocaleString('fr-FR')} MAD`,
    `Scan en cours : ${isRunning ? '⏳ oui' : '✅ non'}`,
    `Dernier scan : ${lastScanDate ? lastScanDate.toLocaleString('fr-FR') : 'jamais'}`,
    `Annonces en mémoire : ${lastResults?.length ?? 0}`,
    ``,
    `Prochain scan auto : demain 08h00`,
  ];
  ctx.replyWithMarkdown(lines.join('\n'));
});

bot.command('budget', ctx => {
  const args = ctx.message.text.split(' ');
  const n = parseInt(args[1]);
  if (!n || n < 100000) return ctx.reply('Usage : /budget 2500000');
  CFG.maxPrice = n;
  ctx.reply(`✅ Budget mis à jour : ${n.toLocaleString('fr-FR')} MAD\nLance /scan pour relancer avec ce budget.`);
});

bot.command('schedule', ctx => {
  ctx.replyWithMarkdown(
    `⏰ *Planning des scans automatiques* (heure Casablanca)\n\n` +
    `*Scans COMPLETS* (Avito + Mubawab + Yakeey + Facebook) :\n` +
    `• 08h00 — tous les jours\n` +
    `• 09h00 — tous les lundis (post-weekend)\n` +
    `• 09h00 — 1er, 2 et 3 du mois (fins de bail)\n` +
    `• 19h00 — 27 au 30 du mois (anticipation)\n\n` +
    `*Scans RAPIDES* (Avito + Mubawab + Yakeey, gratuits) :\n` +
    `• 12h30 — tous les jours (pic midi)\n` +
    `• 18h30 — tous les jours (pic soir)\n\n` +
    `Lance /scan pour un scan immédiat.`
  );
});

// Gestion texte libre
bot.on('text', ctx => {
  ctx.reply('Commandes disponibles : /scan /top10 /top20 /csv /status /schedule /budget /help');
});

// ─── CRON — PLANNING INTELLIGENT ─────────────────────────────────────────
if (ALLOWED_ID) {

  // Scan COMPLET : Avito + Mubawab + Yakeey + Facebook (Apify)
  const runAutoFull = async (label) => {
    if (isRunning) return;
    isRunning = true;
    console.log(`[CRON] ${label}`);
    try {
      const listings = await runScraper();
      lastResults  = listings;
      lastScanDate = new Date();
      isRunning    = false;
      await bot.telegram.sendMessage(ALLOWED_ID,
        `☀️ *${label} terminé* — ${listings.length} annonces\nBudget max : ${CFG.maxPrice.toLocaleString('fr-FR')} MAD`,
        { parse_mode: 'Markdown' }
      );
      if (listings.length) {
        const top5 = listings.slice(0, 5);
        let msg = `🏆 *Top 5 :*\n\n`;
        top5.forEach((l, i) => {
          msg += `${i+1}. [${l.source}] ${l.quartier} — ${fmtPrice(l.prix)}`;
          if (l.rentBrut) msg += ` — *${l.rentBrut}%*`;
          if (l.url) msg += `\n🔗 ${l.url}`;
          msg += '\n\n';
        });
        await bot.telegram.sendMessage(ALLOWED_ID, msg, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      }
    } catch (e) {
      isRunning = false;
      console.error(`[CRON] ${label} error:`, e.message);
      await bot.telegram.sendMessage(ALLOWED_ID, `❌ ${label} échoué : ${e.message}`).catch(() => {});
    }
  };

  // Scan RAPIDE : Avito + Mubawab + Yakeey seulement (gratuit)
  const runAutoQuick = async (label) => {
    if (isRunning) return;
    isRunning = true;
    console.log(`[CRON] ${label}`);
    try {
      const listings = await runQuickScan();
      lastResults  = listings;
      lastScanDate = new Date();
      isRunning    = false;
      const top3 = listings.slice(0, 3);
      if (!top3.length) return;
      let msg = `⚡ *${label}* — ${listings.length} annonces\n\n`;
      top3.forEach((l, i) => {
        msg += `${i+1}. [${l.source}] ${l.quartier} — ${fmtPrice(l.prix)}`;
        if (l.rentBrut) msg += ` — *${l.rentBrut}%*`;
        if (l.url) msg += `\n🔗 ${l.url}`;
        msg += '\n\n';
      });
      await bot.telegram.sendMessage(ALLOWED_ID, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (e) {
      isRunning = false;
      console.error(`[CRON] ${label} error:`, e.message);
    }
  };

  // 08h00 quotidien  — scan complet (tous les jours)
  new CronJob('0 8 * * *',   () => runAutoFull('Scan complet matinal'),    null, true, 'Africa/Casablanca');
  // 09h00 lundi      — post-weekend, beaucoup de nouvelles annonces
  new CronJob('0 9 * * 1',   () => runAutoFull('Lundi matin (complet)'),   null, true, 'Africa/Casablanca');
  // 09h00 1-3        — début de mois, fins de bail
  new CronJob('0 9 1-3 * *', () => runAutoFull('Début de mois (complet)'), null, true, 'Africa/Casablanca');
  // 12h30 quotidien  — pic midi (rapide, gratuit)
  new CronJob('30 12 * * *', () => runAutoQuick('Pic midi (rapide)'),      null, true, 'Africa/Casablanca');
  // 18h30 quotidien  — pic soir (rapide, gratuit)
  new CronJob('30 18 * * *', () => runAutoQuick('Pic soir (rapide)'),      null, true, 'Africa/Casablanca');
  // 19h00 27-30      — fin de mois, anticipation nouvelles annonces
  new CronJob('0 19 27-30 * *', () => runAutoFull('Fin de mois (complet)'), null, true, 'Africa/Casablanca');

  console.log(`⏰  Planning actif (heure Casablanca) :
    08h00 quotidien  → Scan complet
    09h00 lundi      → Scan complet (post-weekend)
    09h00 1-3/mois   → Scan complet (début de mois)
    12h30 quotidien  → Scan rapide (pic midi)
    18h30 quotidien  → Scan rapide (pic soir)
    19h00 27-30/mois → Scan complet (fin de mois)`);
}

// ─── LAUNCH — mode webhook ────────────────────────────────────────────────
async function registerWebhook(attempt = 1) {
  try {
    const info = await bot.telegram.getWebhookInfo();
    if (info.url === WEBHOOK_URL) {
      console.log('✅  Webhook déjà configuré');
      return;
    }
    await bot.telegram.setWebhook(WEBHOOK_URL, {
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    console.log('✅  Webhook enregistré :', WEBHOOK_URL);
  } catch (e) {
    const retryAfter = e.response?.parameters?.retry_after;
    if (retryAfter && attempt <= 5) {
      console.log(`⏳  Rate limit — retry dans ${retryAfter + 2}s`);
      await new Promise(r => setTimeout(r, (retryAfter + 2) * 1000));
      return registerWebhook(attempt + 1);
    }
    throw e;
  }
}

async function startServer(attempt = 1) {
  try {
    await bot.launch({
      webhook: {
        domain: 'https://' + WEBHOOK_HOST,
        path:   WEBHOOK_PATH,
        port:   PORT,
      },
      allowedUpdates: ['message'],
      dropPendingUpdates: false,
    });
    console.log('🤖  Bot démarré (webhook) sur port', PORT);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && attempt <= 10) {
      console.log(`⏳  Port ${PORT} occupé — retry dans 3s (${attempt}/10)`);
      await new Promise(r => setTimeout(r, 3000));
      return startServer(attempt + 1);
    }
    throw e;
  }
}

async function launch() {
  try {
    await registerWebhook();
    await startServer();
  } catch (e) {
    console.error('Erreur launch fatale:', e.message);
    process.exit(1);
  }
}

launch();

// Graceful stop
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
