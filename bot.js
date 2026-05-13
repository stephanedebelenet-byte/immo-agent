'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { CronJob }          = require('cron');
const fs                   = require('fs');
const path                 = require('path');
const http                 = require('http');
const { runScraper, generateCSV, CFG } = require('./agent');

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
  const lines = [
    `*${i}. [${l.source}] ${l.quartier}*`,
    `💰 ${fmtPrice(l.prix)}${l.surface ? ` · ${l.surface} m²` : ''}${l.prixM2 ? ` · *${l.prixM2.toLocaleString('fr-FR')} DH/m²*` : ''}`,
    `📊 Brut: *${l.rentBrut ?? '-'}%* · Net: *${l.rentNet ?? '-'}%*`,
    l.loyer ? `🏡 Loyer ~${l.loyer.toLocaleString('fr-FR')} DH/mois _(${l.loyerSource})_` : null,
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
                 `Budget max : ${CFG.maxPrice.toLocaleString('fr-FR')} MAD\n\n`;

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
    '🔍 Scan lancé sur *Avito · Facebook · Mubawab · Yakeey*\n⏱ Durée estimée : 5-10 min\nJe t\'envoie les résultats dès que c\'est prêt.',
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
    `Je scrape Avito, Facebook Marketplace, Mubawab et Yakeey pour trouver les meilleures opportunités d'investissement locatif.\n\n` +
    `*Commandes :*\n` +
    `/scan — Lancer un scan complet\n` +
    `/top10 — Top 10 du dernier scan\n` +
    `/top20 — Top 20 du dernier scan\n` +
    `/csv — Recevoir le CSV complet\n` +
    `/status — Statut et dernier scan\n` +
    `/help — Aide\n\n` +
    `📅 Scan automatique tous les jours à 08h00`
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

// Gestion texte libre
bot.on('text', ctx => {
  ctx.reply('Commandes disponibles : /scan /top10 /csv /status /help');
});

// ─── CRON — SCAN AUTO QUOTIDIEN ───────────────────────────────────────────
if (ALLOWED_ID) {
  const job = new CronJob('0 8 * * *', async () => {
    console.log('[CRON] Scan automatique 08h00');
    try {
      const listings = await runScraper();
      lastResults  = listings;
      lastScanDate = new Date();
      await bot.telegram.sendMessage(ALLOWED_ID,
        `☀️ *Scan matinal terminé* — ${listings.length} annonces\nBudget max : ${CFG.maxPrice.toLocaleString('fr-FR')} MAD`,
        { parse_mode: 'Markdown' }
      );
      // Top 5 en résumé matinal
      if (listings.length) {
        const top5 = listings.slice(0, 5);
        let msg = `🏆 *Top 5 du jour :*\n\n`;
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
      console.error('[CRON] Error:', e.message);
      await bot.telegram.sendMessage(ALLOWED_ID, `❌ Scan auto échoué : ${e.message}`).catch(() => {});
    }
  }, null, true, 'Africa/Casablanca');

  console.log('⏰  Cron scan quotidien actif (08h00 heure Casablanca)');
}

// ─── LAUNCH — mode webhook (évite conflit 409 entre instances) ────────────
async function launch(attempt = 1) {
  try {
    // 1. Enregistre le webhook sur Telegram
    await bot.telegram.setWebhook(WEBHOOK_URL, {
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    console.log('✅  Webhook enregistré :', WEBHOOK_URL);

    // 2. Lance le serveur HTTP local pour recevoir les updates
    await bot.launch({
      webhook: {
        domain: 'https://' + WEBHOOK_HOST,
        path:   WEBHOOK_PATH,
        port:   PORT,
      },
      allowedUpdates: ['message'],
      dropPendingUpdates: true,
    });
    console.log('🤖  Bot démarré (webhook) sur port', PORT);
  } catch (e) {
    const retryAfter = e.response?.parameters?.retry_after;
    if (retryAfter && attempt <= 5) {
      const delay = (retryAfter + 1) * 1000;
      console.log(`⏳  Rate limit Telegram — retry dans ${retryAfter + 1}s (tentative ${attempt}/5)`);
      setTimeout(() => launch(attempt + 1), delay);
    } else {
      console.error('Erreur launch fatale:', e.message);
      process.exit(1);
    }
  }
}

launch();

// Graceful stop
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
