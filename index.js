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

// ─── SERVIDOR HTTP (Render precisa de porta aberta) ───────
function startHealthServer() {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bots_ativos: activeBots.size,
      uptime: Math.floor(process.uptime()) + "s"
    }));
  });
  server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
  });
}

// ─── SUBSTITUIR VARIÁVEIS ─────────────────────────────────
// Substitui {nome}, {plano}, {valor}, etc. na mensagem
function replaceVars(text, vars = {}) {
  if (!text) return "";
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

// ─── FORMATAR DURAÇÃO ─────────────────────────────────────
function formatDuration(duration) {
  const map = {
    monthly: "Mensal",
    yearly: "Anual",
    lifetime: "Vitalício",
    weekly: "Semanal",
    daily: "Diário",
  };
  return map[duration] || duration;
}

// ─── BUSCAR FLUXO DO BOT ──────────────────────────────────
async function getFlowForBot(botRecord) {
  // Tenta primeiro pelo campo bot_id da tabela
  const { data: byColumn } = await supabase
    .from("flows")
    .select("*")
    .eq("bot_id", botRecord.id)
    .in("status", ["active", "draft", "published"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (byColumn) return byColumn;

  // Fallback: busca nos botIds dentro do config JSON
  const { data: allFlows } = await supabase
    .from("flows")
    .select("*")
    .eq("user_id", botRecord.user_id)
    .in("status", ["active", "draft", "published"]);

  if (!allFlows) return null;

  const match = allFlows.find((f) => {
    const botIds = f.config?.botIds || [];
    return botIds.includes(botRecord.id);
  });

  return match || null;
}

// ─── SALVAR / BUSCAR LEAD ─────────────────────────────────
async function upsertLead(telegramUser, botRecord) {
  try {
    const { data: existing } = await supabase
      .from("customers")
      .select("id, name, lead_status")
      .eq("telegram_id", String(telegramUser.id))
      .eq("bot_id", botRecord.id)
      .single();

    if (existing) return existing;

    const fullName = [telegramUser.first_name, telegramUser.last_name]
      .filter(Boolean).join(" ") || "Usuário";

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
    console.log(`✅ [${botRecord.name}] Novo lead: ${fullName}`);
    return data;
  } catch (err) {
    console.error(`[${botRecord.name}] Erro ao salvar lead:`, err.message);
    return null;
  }
}

// ─── ENVIAR BOAS-VINDAS ───────────────────────────────────
async function sendWelcome(ctx, config, lead) {
  const welcome = config.welcome || {};
  const firstName = lead?.name?.split(" ")[0] || ctx.from.first_name || "amigo";

  const vars = {
    nome: lead?.name || firstName,
    primeiro_nome: firstName,
    username: ctx.from.username || firstName,
  };

  const message = replaceVars(welcome.message, vars);

  // Se não tem mensagem configurada, manda padrão
  const texto = message && message.trim()
    ? message
    : `👋 Olá, *${firstName}*! Seja bem-vindo(a)!\n\nEscolha uma opção abaixo:`;

  // Delay antes de enviar (se configurado)
  if (welcome.delay && welcome.delay > 0) {
    await new Promise((r) => setTimeout(r, welcome.delay * 1000));
  }

  // Monta botões inline (configurados no fluxo)
  let keyboard = null;
  if (welcome.buttons && welcome.buttons.length > 0) {
    keyboard = new InlineKeyboard();
    welcome.buttons.forEach((btn) => {
      if (btn.text) {
        keyboard.text(btn.text, btn.callback || "btn_custom").row();
      }
    });
  }

  const opts = { parse_mode: "Markdown" };
  if (keyboard) opts.reply_markup = keyboard;

  await ctx.reply(texto, opts);
}

// ─── ENVIAR PLANOS ────────────────────────────────────────
async function sendPlans(ctx, config, botRecord) {
  const plans = config.plans || [];

  if (plans.length === 0) {
    await ctx.reply("_Nenhum plano configurado ainda._", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Monta texto dos planos
  let texto = `📦 *Escolha seu plano:*\n\n`;
  plans.forEach((plan, i) => {
    const preco = Number(plan.price).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
    const duracao = formatDuration(plan.duration);
    texto += `*${i + 1}. ${plan.name}*\n`;
    texto += `💰 ${preco} — ${duracao}\n\n`;
  });

  // Botões para cada plano
  const keyboard = new InlineKeyboard();
  plans.forEach((plan) => {
    const preco = Number(plan.price).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
    keyboard
      .text(`${plan.name} — ${preco}`, `plan_${botRecord.id}_${plan.id}`)
      .row();
  });

  await ctx.reply(texto, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// ─── HANDLERS DO BOT ──────────────────────────────────────
function setupBotHandlers(bot, botRecord) {

  // /start — entrada principal
  bot.command("start", async (ctx) => {
    try {
      const lead = await upsertLead(ctx.from, botRecord);
      const flow = await getFlowForBot(botRecord);

      if (!flow) {
        // Sem fluxo configurado — mensagem padrão
        const firstName = ctx.from.first_name || "amigo";
        await ctx.reply(
          `👋 Olá, *${firstName}*! Bem-vindo!\n\n_Configure um fluxo no painel do Octopus Bot para personalizar esta mensagem._`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const config = flow.config || {};

      // 1. Envia boas-vindas
      await sendWelcome(ctx, config, lead);

      // 2. Envia planos (se tiver)
      const plans = config.plans || [];
      if (plans.length > 0) {
        await sendPlans(ctx, config, botRecord);
      }

    } catch (err) {
      console.error(`[${botRecord.name}] Erro no /start:`, err.message);
    }
  });

  // Seleção de plano
  bot.callbackQuery(new RegExp(`^plan_${botRecord.id}_(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();

    try {
      const planId = ctx.match[1];
      const flow = await getFlowForBot(botRecord);
      const config = flow?.config || {};
      const plans = config.plans || [];
      const plan = plans.find((p) => p.id === planId);

      if (!plan) {
        await ctx.reply("❌ Plano não encontrado.");
        return;
      }

      const lead = await upsertLead(ctx.from, botRecord);
      const firstName = lead?.name?.split(" ")[0] || ctx.from.first_name;

      const preco = Number(plan.price).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });

      // Verifica se tem Order Bump configurado
      const orderBump = config.orderBump?.sections?.initial;
      if (orderBump?.productName && Number(orderBump.price) > 0) {
        await sendOrderBump(ctx, plan, orderBump, botRecord, lead);
        return;
      }

      // Gera PIX direto
      await sendPixMessage(ctx, config, plan, lead, botRecord);

    } catch (err) {
      console.error(`[${botRecord.name}] Erro ao selecionar plano:`, err.message);
    }
  });

  // Order Bump — aceitar
  bot.callbackQuery(new RegExp(`^ob_yes_${botRecord.id}_(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery("✅ Adicionado!");
    try {
      const planId = ctx.match[1];
      const flow = await getFlowForBot(botRecord);
      const config = flow?.config || {};
      const plans = config.plans || [];
      const plan = plans.find((p) => p.id === planId);
      const lead = await upsertLead(ctx.from, botRecord);

      await ctx.reply("✅ *Produto adicional incluído!*", { parse_mode: "Markdown" });
      await sendPixMessage(ctx, config, plan, lead, botRecord, true);
    } catch (err) {
      console.error(`[${botRecord.name}] Erro no order bump:`, err.message);
    }
  });

  // Order Bump — recusar
  bot.callbackQuery(new RegExp(`^ob_no_${botRecord.id}_(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const planId = ctx.match[1];
      const flow = await getFlowForBot(botRecord);
      const config = flow?.config || {};
      const plans = config.plans || [];
      const plan = plans.find((p) => p.id === planId);
      const lead = await upsertLead(ctx.from, botRecord);

      await sendPixMessage(ctx, config, plan, lead, botRecord, false);
    } catch (err) {
      console.error(`[${botRecord.name}] Erro ao recusar order bump:`, err.message);
    }
  });

  // Verificar status do pagamento
  bot.callbackQuery(new RegExp(`^verify_${botRecord.id}_(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery("🔄 Verificando...");
    try {
      const saleId = ctx.match[1];
      const { data: sale } = await supabase
        .from("sales")
        .select("status, amount")
        .eq("id", saleId)
        .single();

      if (!sale) {
        await ctx.reply("❌ Venda não encontrada.");
        return;
      }

      if (sale.status === "paid" || sale.status === "approved") {
        const flow = await getFlowForBot(botRecord);
        const config = flow?.config || {};
        await sendApprovedMessage(ctx, config, sale);
      } else if (sale.status === "pending") {
        await ctx.reply("⏳ *Pagamento ainda pendente.*\n\nAguarde a confirmação do PIX ou tente novamente em alguns instantes.", {
          parse_mode: "Markdown",
        });
      } else {
        await ctx.reply("❌ *Pagamento não aprovado.*\n\nTente novamente.", {
          parse_mode: "Markdown",
        });
      }
    } catch (err) {
      console.error(`[${botRecord.name}] Erro ao verificar:`, err.message);
    }
  });

  // Cancelar pagamento
  bot.callbackQuery(new RegExp(`^cancel_${botRecord.id}_(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery("❌ Cancelado");
    await ctx.reply("❌ *Pedido cancelado.*\n\nDigite /start para recomeçar.", {
      parse_mode: "Markdown",
    });
  });

  // Erro geral
  bot.catch((err) => {
    console.error(`[Bot ${botRecord.name}] Erro:`, err.message);
  });
}

// ─── ORDER BUMP ───────────────────────────────────────────
async function sendOrderBump(ctx, plan, orderBump, botRecord, lead) {
  const precoOb = Number(orderBump.price).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  const texto =
    `🛒 *Oferta especial antes de pagar!*\n\n` +
    `*${orderBump.productName}*\n` +
    `${orderBump.description ? orderBump.description + "\n" : ""}` +
    `💰 Por apenas *${precoOb}*\n\n` +
    `Deseja adicionar ao seu pedido?`;

  const keyboard = new InlineKeyboard()
    .text(orderBump.buttonText || "✅ Quero adicionar", `ob_yes_${botRecord.id}_${plan.id}`)
    .row()
    .text("❌ Não, obrigado", `ob_no_${botRecord.id}_${plan.id}`);

  await ctx.reply(texto, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ─── MENSAGEM DO PIX ──────────────────────────────────────
async function sendPixMessage(ctx, config, plan, lead, botRecord, withOrderBump = false) {
  if (!plan) {
    await ctx.reply("❌ Plano não encontrado.");
    return;
  }

  const preco = Number(plan.price).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  // Cria registro de venda no Supabase
  const { data: sale } = await supabase
    .from("sales")
    .insert({
      bot_id: botRecord.id,
      user_id: botRecord.user_id,
      customer_id: lead?.id || null,
      amount: plan.price,
      status: "pending",
      gateway_id: null,
      pix_codigo: "PIX_CODIGO_AQUI", // será substituído pelo gateway
      pix_qrcode: null,
    })
    .select()
    .single();

  const saleId = sale?.id || "temp";

  // Variáveis para substituição
  const vars = {
    nome: lead?.name || ctx.from.first_name || "Cliente",
    primeiro_nome: (lead?.name || ctx.from.first_name || "").split(" ")[0],
    username: ctx.from.username || "cliente",
    plano: plan.name,
    valor: preco,
    valor_original: preco,
    desconto: "R$ 0,00",
    qr_code: "🔲 QR Code será exibido aqui",
    pix_codigo: "00020126580014BR.GOV.BCB.PIX...CODIGO_PIX_AQUI",
    bot_nome: botRecord.name,
    data: new Date().toLocaleDateString("pt-BR"),
    hora: new Date().toLocaleTimeString("pt-BR"),
  };

  // Mensagem do PIX configurada no fluxo
  const pixConfig = config.payments?.pix || {};
  const mensagemPix = replaceVars(pixConfig.message, vars) ||
    `💰 *${plan.name}* — ${preco}\n\nPague via PIX para confirmar seu acesso.`;

  // Monta teclado de ações
  const keyboard = new InlineKeyboard();
  const actions = config.payments?.actions || {};

  if (pixConfig.copyButton !== false) {
    keyboard.text("📋 Copiar código PIX", `copy_${botRecord.id}_${saleId}`).row();
  }
  if (actions.verifyStatus !== false) {
    keyboard.text("🔄 Verificar pagamento", `verify_${botRecord.id}_${saleId}`).row();
  }
  if (actions.cancel !== false) {
    keyboard.text("❌ Cancelar", `cancel_${botRecord.id}_${saleId}`).row();
  }

  // Mensagem antes dos botões
  let textoFinal = mensagemPix;
  if (pixConfig.beforeCodeMessage) {
    textoFinal += `\n\n*${pixConfig.beforeCodeMessage}*\n\`${vars.pix_codigo}\``;
  }

  await ctx.reply(textoFinal, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// ─── MENSAGEM DE APROVAÇÃO ────────────────────────────────
async function sendApprovedMessage(ctx, config, sale) {
  const approved = config.payments?.approved || {};

  const vars = {
    nome: ctx.from.first_name || "Cliente",
    username: ctx.from.username || "cliente",
    plano: "Plano",
    valor: Number(sale.amount).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    }),
    link_acesso: approved.accessButtonUrl || "",
    data: new Date().toLocaleDateString("pt-BR"),
    hora: new Date().toLocaleTimeString("pt-BR"),
  };

  const mensagem = replaceVars(approved.message, vars) ||
    `✅ *Pagamento aprovado!*\n\nBem-vindo(a), ${vars.nome}!`;

  const keyboard = new InlineKeyboard();
  if (approved.accessButtonText && approved.accessButtonUrl) {
    keyboard.url(approved.accessButtonText, approved.accessButtonUrl).row();
  }

  // Botões extras
  if (approved.extraButtons && approved.extraButtons.length > 0) {
    approved.extraButtons.forEach((btn) => {
      if (btn.text && btn.url) keyboard.url(btn.text, btn.url).row();
    });
  }

  await ctx.reply(mensagem, {
    parse_mode: "Markdown",
    reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  });
}

// ─── INICIAR BOT ──────────────────────────────────────────
async function startBot(botRecord) {
  if (activeBots.has(botRecord.id)) return;
  if (!botRecord.telegram_token) {
    console.warn(`[${botRecord.name}] Sem token, pulando.`);
    return;
  }

  try {
    const bot = new Bot(botRecord.telegram_token);
    setupBotHandlers(bot, botRecord);

    bot.start().catch((err) => {
      console.error(`[${botRecord.name}] Erro:`, err.message);
      activeBots.delete(botRecord.id);
    });

    activeBots.set(botRecord.id, bot);
    console.log(`🤖 [${botRecord.name}] Online!`);
  } catch (err) {
    console.error(`[${botRecord.name}] Falha ao criar:`, err.message);
  }
}

// ─── PARAR BOT ────────────────────────────────────────────
async function stopBot(botId, botName) {
  const bot = activeBots.get(botId);
  if (!bot) return;
  try {
    await bot.stop();
    activeBots.delete(botId);
    console.log(`🛑 [${botName}] Parado.`);
  } catch (err) {
    console.error(`Erro ao parar ${botName}:`, err.message);
  }
}

// ─── CARREGAR TODOS OS BOTS ───────────────────────────────
async function loadAllBots() {
  console.log("🔄 Carregando bots ativos...");

  const { data: bots, error } = await supabase
    .from("bots")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Erro ao carregar bots:", error.message);
    return;
  }

  if (!bots || bots.length === 0) {
    console.log("Nenhum bot ativo. Aguardando...");
    return;
  }

  console.log(`📋 ${bots.length} bot(s) encontrado(s).`);
  for (const botRecord of bots) {
    await startBot(botRecord);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── REALTIME ─────────────────────────────────────────────
function watchForNewBots() {
  console.log("👁️  Monitorando novos bots...");

  supabase
    .channel("bots_changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "bots" },
      async (payload) => {
        const { eventType, new: n, old: o } = payload;
        if (eventType === "INSERT" && n.is_active) await startBot(n);
        if (eventType === "UPDATE") {
          if (n.is_active && !o.is_active) await startBot(n);
          if (!n.is_active && o.is_active) await stopBot(n.id, n.name);
        }
        if (eventType === "DELETE") await stopBot(o.id, o.name);
      })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("✅ Realtime conectado!");
    });
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log("🐙 Octopus Bot Manager v4 iniciando...");
  startHealthServer();
  await loadAllBots();
  watchForNewBots();
  console.log("✅ Sistema pronto! Bots ativos:", activeBots.size);
}

process.on("SIGTERM", async () => {
  for (const [, bot] of activeBots) await bot.stop();
  process.exit(0);
});

main().catch(console.error);
