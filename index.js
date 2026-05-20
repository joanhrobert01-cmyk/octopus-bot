const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// ─── CONFIG ───────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL e SUPABASE_KEY são obrigatórios!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Mapa de bots ativos: botId -> instância do Bot
const activeBots = new Map();

// ─── HANDLERS DO BOT ──────────────────────────────────────
function setupBotHandlers(bot, botRecord) {
  // /start
  bot.command("start", async (ctx) => {
    try {
      await upsertLead(ctx.from, botRecord);

      const firstName = ctx.from.first_name || "amigo";

      const keyboard = new InlineKeyboard()
        .text("📦 Ver Planos", `planos_${botRecord.id}`)
        .row()
        .text("💬 Suporte", `suporte_${botRecord.id}`);

      await ctx.reply(
        `👋 Olá, *${firstName}*! Bem-vindo!\n\n` +
          `Aqui você encontra nossos planos e ofertas exclusivas.\n\n` +
          `Escolha uma opção abaixo:`,
        {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }
      );
    } catch (err) {
      console.error(`[Bot ${botRecord.name}] Erro no /start:`, err.message);
    }
  });

  // Ver planos
  bot.callbackQuery(new RegExp(`^planos_${botRecord.id}$`), async (ctx) => {
    await ctx.answerCallbackQuery();

    // Busca planos configurados no fluxo do bot
    const planos = await getPlanos(botRecord);

    if (planos.length === 0) {
      await ctx.reply(
        `📦 *Nossos Planos*\n\n` +
          `_Nenhum plano configurado ainda._\n\n` +
          `Configure seus planos no painel do Octopus Bot.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    planos.forEach((plano) => {
      keyboard
        .text(
          `${plano.name} — R$ ${Number(plano.price).toFixed(2)}`,
          `comprar_${botRecord.id}_${plano.id}`
        )
        .row();
    });

    const texto = planos
      .map(
        (p, i) =>
          `*${i + 1}. ${p.name}*\n💰 R$ ${Number(p.price).toFixed(2)}\n`
      )
      .join("\n");

    await ctx.reply(`📦 *Nossos Planos*\n\n${texto}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  });

  // Suporte
  bot.callbackQuery(new RegExp(`^suporte_${botRecord.id}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `💬 *Suporte*\n\nEntre em contato com nossa equipe para ajuda.`,
      { parse_mode: "Markdown" }
    );
  });

  // Comprar plano
  bot.callbackQuery(
    new RegExp(`^comprar_${botRecord.id}_(.+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `⏳ *Gerando PIX...*\n\n` +
          `_Integração com pagamentos em breve!_`,
        { parse_mode: "Markdown" }
      );
    }
  );

  // Erro geral do bot
  bot.catch((err) => {
    console.error(`[Bot ${botRecord.name}] Erro:`, err.message);
  });
}

// ─── BUSCAR PLANOS DO FLUXO ───────────────────────────────
async function getPlanos(botRecord) {
  try {
    // Busca fluxo vinculado ao bot
    const { data: flowBot } = await supabase
      .from("flow_bots")
      .select("flow_id")
      .eq("bot_id", botRecord.id)
      .limit(1)
      .single();

    if (!flowBot) return [];

    // Busca planos do fluxo
    const { data: planos } = await supabase
      .from("flow_plans")
      .select("*")
      .eq("flow_id", flowBot.flow_id)
      .eq("is_active", true);

    return planos || [];
  } catch {
    return [];
  }
}

// ─── SALVAR LEAD ──────────────────────────────────────────
async function upsertLead(telegramUser, botRecord) {
  try {
    // Verifica se lead já existe
    const { data: existing } = await supabase
      .from("customers")
      .select("id, lead_status")
      .eq("telegram_id", String(telegramUser.id))
      .eq("bot_id", botRecord.id)
      .single();

    if (existing) {
      // Atualiza contador de starts
      await supabase
        .from("customers")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      return existing;
    }

    // Cria novo lead
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
  // Evita duplicata
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

    // Inicia em background (não bloqueia)
    bot.start().catch((err) => {
      console.error(`[Bot ${botRecord.name}] Erro ao iniciar:`, err.message);
      activeBots.delete(botRecord.id);
    });

    activeBots.set(botRecord.id, bot);
    console.log(`🤖 [Bot ${botRecord.name}] Iniciado com sucesso!`);
  } catch (err) {
    console.error(`[Bot ${botRecord.name}] Falha ao criar instância:`, err.message);
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

// ─── CARREGAR TODOS OS BOTS ATIVOS ────────────────────────
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
    console.log("Nenhum bot ativo encontrado. Aguardando novos cadastros...");
    return;
  }

  console.log(`📋 ${bots.length} bot(s) encontrado(s). Iniciando...`);

  for (const botRecord of bots) {
    await startBot(botRecord);
    // Pequeno delay para não sobrecarregar a API do Telegram
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
          console.log(`🆕 Novo bot cadastrado: ${newRecord.name}`);
          await startBot(newRecord);
        }

        if (eventType === "UPDATE") {
          if (newRecord.is_active && !oldRecord.is_active) {
            // Bot foi ativado
            console.log(`✅ Bot reativado: ${newRecord.name}`);
            await startBot(newRecord);
          } else if (!newRecord.is_active && oldRecord.is_active) {
            // Bot foi desativado
            console.log(`⛔ Bot desativado: ${newRecord.name}`);
            await stopBot(newRecord.id, newRecord.name);
          }
        }

        if (eventType === "DELETE") {
          console.log(`🗑️  Bot removido: ${oldRecord.name}`);
          await stopBot(oldRecord.id, oldRecord.name);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Realtime conectado — detectando novos bots!");
      }
    });
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────
async function main() {
  console.log("🐙 Octopus Bot Manager iniciando...");
  console.log(`📡 Supabase: ${SUPABASE_URL}`);

  await loadAllBots();
  watchForNewBots();

  console.log("✅ Sistema pronto! Bots rodando:", activeBots.size);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Encerrando todos os bots...");
  for (const [id, bot] of activeBots) {
    await bot.stop();
  }
  process.exit(0);
});

main().catch(console.error);
