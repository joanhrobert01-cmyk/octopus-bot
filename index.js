const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL e SUPABASE_KEY são obrigatórios!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const activeBots = new Map();

// ─── SERVIDOR HTTP (obrigatório no Render) ────────────────
function startHealthServer() {
  const PORT = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        bots_ativos: activeBots.size,
        uptime: Math.floor(process.uptime()) + "s"
      }));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Octopus Bot Manager rodando! Bots ativos: " + activeBots.size);
    }
  });

  server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
  });
}

// ─── HANDLERS DO BOT ──────────────────────────────────────
function setupBotHandlers(bot, botRecord) {
  bot.command("start", async (ctx) => {
    try {
      await upsertLead(ctx.from, botRecord);
      const firstName = ctx.from.first_name || "amigo";

      const keyboard = new InlineKeyboard()
        .text("📦 Ver Planos", `planos_${botRecord.id}`)
        .row()
        .text("💬 Suporte", `suporte_${botRecord.id}`);

      await ctx.reply(
        `👋 Olá, *${firstName}*! Bem-vindo!\n\nAqui você encontra nossos planos e ofertas exclusivas.\n\nEscolha uma opção abaixo:`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
    } catch (err) {
      console.error(`[Bot ${botRecord.name}] Erro no /start:`, err.message);
    }
  });

  bot.callbackQuery(new RegExp(`^planos_${botRecord.id}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📦 *Nossos Planos*\n\n_Configure seus planos no painel do Octopus Bot._`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(new RegExp(`^suporte_${botRecord.id}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(`💬 *Suporte*\n\nEntre em contato com nossa equipe.`, {
      parse_mode: "Markdown",
    });
  });

  bot.catch((err) => {
    console.error(`[Bot ${botRecord.name}] Erro:`, err.message);
  });
}

// ─── SALVAR LEAD ──────────────────────────────────────────
async function upsertLead(telegramUser, botRecord) {
  try {
    const { data: existing } = await supabase
      .from("customers")
      .select("id")
      .eq("telegram_id", String(telegramUser.id))
      .eq("bot_id", botRecord.id)
      .single();

    if (existing) return existing;

    const fullName = [telegramUser.first_name, telegramUser.last_name]
      .filter(Boolean)
      .join(" ");

    const { data, error } = await supabase
      .from("customers")
      .insert({
        bot_id: botRecord.id,
        user_id: botRecord.user_id,
        telegram_id: String(telegramUser.id),
        name: fullName,
        username: telegramUser.username || null,
        lead_status: "new",
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`✅ [Bot ${botRecord.name}] Novo lead: ${fullName}`);
    return data;
  } catch (err) {
    console.error(`[Bot ${botRecord.name}] Erro ao salvar lead:`, err.message);
    return null;
  }
}

// ─── INICIAR UM BOT ───────────────────────────────────────
async function startBot(botRecord) {
  if (activeBots.has(botRecord.id)) {
    console.log(`[Bot ${botRecord.name}] Já está rodando.`);
    return;
  }

  if (!botRecord.telegram_token) {
    console.warn(`[Bot ${botRecord.name}] Sem token, pulando.`);
    return;
  }

  try {
    const bot = new Bot(botRecord.telegram_token);
    setupBotHandlers(bot, botRecord);

    bot.start().catch((err) => {
      console.error(`[Bot ${botRecord.name}] Erro ao iniciar:`, err.message);
      activeBots.delete(botRecord.id);
    });

    activeBots.set(botRecord.id, bot);
    console.log(`🤖 [Bot ${botRecord.name}] Iniciado!`);
  } catch (err) {
    console.error(`[Bot ${botRecord.name}] Falha:`, err.message);
  }
}

// ─── PARAR UM BOT ─────────────────────────────────────────
async function stopBot(botId, botName) {
  const bot = activeBots.get(botId);
  if (!bot) return;
  try {
    await bot.stop();
    activeBots.delete(botId);
    console.log(`🛑 [Bot ${botName}] Parado.`);
  } catch (err) {
    console.error(`Erro ao parar bot ${botName}:`, err.message);
  }
}

// ─── CARREGAR TODOS OS BOTS ───────────────────────────────
async function loadAllBots() {
  console.log("🔄 Carregando bots ativos do Supabase...");

  const { data: bots, error } = await supabase
    .from("bots")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Erro ao carregar bots:", error.message);
    return;
  }

  if (!bots || bots.length === 0) {
    console.log("Nenhum bot ativo. Aguardando novos cadastros...");
    return;
  }

  console.log(`📋 ${bots.length} bot(s) encontrado(s). Iniciando...`);
  for (const botRecord of bots) {
    await startBot(botRecord);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── REALTIME — DETECTA NOVOS BOTS ───────────────────────
function watchForNewBots() {
  console.log("👁️  Monitorando novos bots em tempo real...");

  supabase
    .channel("bots_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bots" },
      async (payload) => {
        const { eventType, new: newRecord, old: oldRecord } = payload;

        if (eventType === "INSERT" && newRecord.is_active) {
          console.log(`🆕 Novo bot: ${newRecord.name}`);
          await startBot(newRecord);
        }

        if (eventType === "UPDATE") {
          if (newRecord.is_active && !oldRecord.is_active) {
            console.log(`✅ Bot ativado: ${newRecord.name}`);
            await startBot(newRecord);
          } else if (!newRecord.is_active && oldRecord.is_active) {
            console.log(`⛔ Bot desativado: ${newRecord.name}`);
            await stopBot(newRecord.id, newRecord.name);
          }
        }

        if (eventType === "DELETE") {
          await stopBot(oldRecord.id, oldRecord.name);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Realtime conectado!");
      }
    });
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log("🐙 Octopus Bot Manager iniciando...");

  // Inicia servidor HTTP PRIMEIRO (Render precisa ver a porta)
  startHealthServer();

  // Depois carrega os bots
  await loadAllBots();
  watchForNewBots();

  console.log("✅ Sistema pronto! Bots ativos:", activeBots.size);
}

process.on("SIGTERM", async () => {
  for (const [, bot] of activeBots) await bot.stop();
  process.exit(0);
});

main().catch(console.error);
