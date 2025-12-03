// ─────────────────────────────────────────────────────────
// STUDENT BOT — FULL PRODUCTION BUILD (MongoDB)
// Зробив як просив: без зайвих базарів і тестів
// ─────────────────────────────────────────────────────────

const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
require("dotenv").config();

// 🔑 ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = process.env.ADMIN_IDS.split(",");
const START_STICKER = process.env.START_STICKER_ID || null;

const bot = new Telegraf(BOT_TOKEN);

// ───────────────────────────────────────────
// MongoDB
// ───────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("🟢 MongoDB Connected"))
  .catch(err => console.log("🔴 MongoDB Error:", err));

// ───────────────────────────────────────────
// Schemas
// ───────────────────────────────────────────
const User = mongoose.model("User", new mongoose.Schema({
  chat_id: String,
  username: String,
  first_name: String,
  faculty: String,
  approved: { type: Boolean, default: false },
  pendingFaculty: String
}));

const Event = mongoose.model("Event", new mongoose.Schema({
  faculty: String,
  title: String,
  date: String
}));

// ───────────────────────────────────────────
// Data
// ───────────────────────────────────────────
const FAC = {
  log: "Логістика",
  psy: "Психологія",
  eco: "Економіка",
  law: "Право",
  man: "Управління",
  other: "Інший"
};

const isAdmin = id => ADMIN_IDS.includes(String(id));

// ───────────────────────────────────────────
// UI
// ───────────────────────────────────────────
const studentMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback("📅 Календар", "calendar")],
  [Markup.button.callback("🎓 Мій факультет", "my_fac")],
  [Markup.button.callback("🔄 Змінити факультет", "change_fac")]
]);

const adminMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback("🆕 Нові заявки", "adm_req")],
  [Markup.button.callback("👥 Студенти", "adm_users")],
  [Markup.button.callback("📢 Розсилка", "adm_broadcast")],
  [Markup.button.callback("📅 Події", "adm_events")]
]);

// ───────────────────────────────────────────
// START
// ───────────────────────────────────────────
bot.start(async ctx => {
  const id = String(ctx.from.id);

  if (START_STICKER) await ctx.replyWithSticker(START_STICKER);

  let u = await User.findOne({ chat_id: id });

  if (!u) {
    await User.create({
      chat_id: id,
      username: ctx.from.username,
      first_name: ctx.from.first_name
    });
  }

  u = await User.findOne({ chat_id: id });

  if (!u.approved) {
    return ctx.reply("⏳ Заявка на доступ ще розглядається.");
  }

  return ctx.reply("🔹 Меню студента", studentMenu());
});

// ───────────────────────────────────────────
// Set Faculty (initial or change request)
// ───────────────────────────────────────────
bot.action(/set_(.+)/, async ctx => {
  const fac = ctx.match[1];
  const uid = String(ctx.from.id);
  let u = await User.findOne({ chat_id: uid });

  u.pendingFaculty = fac;
  await u.save();

  ctx.reply("📝 Заявка на доступ відправлена. Очікуйте.");

  for (const admin of ADMIN_IDS) {
    bot.telegram.sendMessage(
      admin,
      `📩 *Нова заявка*\n\n👤 @${u.username || "нема"}\n🆔 ${uid}\n🎓 Хоче: ${FAC[fac]}`,
      {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([
          [{ text: "✔️ Дозволити", callback_data: `appr_${uid}` }],
          [{ text: "❌ Відмовити", callback_data: `rej_${uid}` }]
        ])
      }
    );
  }
});

// ───────────────────────────────────────────
// Admin Approve / Reject
// ───────────────────────────────────────────
bot.action(/appr_(.+)/, async ctx => {
  const id = ctx.match[1];
  let u = await User.findOne({ chat_id: id });
  if (!u) return;

  u.approved = true;
  u.faculty = u.pendingFaculty;
  u.pendingFaculty = null;
  await u.save();

  bot.telegram.sendMessage(id, "🎉 Доступ відкрито!", studentMenu());
  ctx.editMessageText("✔️ Підтверджено");
});

bot.action(/rej_(.+)/, async ctx => {
  const id = ctx.match[1];
  let u = await User.findOne({ chat_id: id });
  if (!u) return;

  u.pendingFaculty = null;
  await u.save();

  bot.telegram.sendMessage(id, "❌ Відмовлено.");
  ctx.editMessageText("❌ Відхилено");
});

// ───────────────────────────────────────────
// Student menu
// ───────────────────────────────────────────
bot.action("calendar", async ctx => {
  const uid = String(ctx.from.id);
  const u = await User.findOne({ chat_id: uid });

  if (!u.faculty) return ctx.reply("🤔 Немає факультету?");

  const events = await Event.find({ faculty: u.faculty });
  if (!events.length) return ctx.reply("📭 Подій нема");

  let txt = `📅 Події (${FAC[u.faculty]}):\n\n`;
  events.forEach(ev => txt += `• *${ev.date}* — ${ev.title}\n`);

  ctx.reply(txt, { parse_mode: "Markdown" });
});

bot.action("change_fac", async ctx => {
  ctx.reply("Окей, обери інший факультет:", {
    reply_markup: {
      inline_keyboard: Object.entries(FAC).map(([k,v]) => [
        Markup.button.callback(v, `set_${k}`)
      ])
    }
  });
});

bot.action("my_fac", async ctx => {
  const u = await User.findOne({ chat_id: String(ctx.from.id) });
  ctx.reply(`🎓 Твій факультет: ${FAC[u.faculty]}`);
});

// ───────────────────────────────────────────
// Admin Panel
// ───────────────────────────────────────────
bot.command("admin", ctx => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply("🛠 Адмін панель", adminMenu());
});

// All approved users count
bot.action("adm_users", async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const users = await User.find({ approved: true });
  ctx.reply(`👥 Активних студентів: ${users.length}`);
});

// Pending
bot.action("adm_req", async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const pending = await User.find({ pendingFaculty: { $ne: null } });
  if (!pending.length) return ctx.reply("🎯 Нема заявок");

  pending.forEach(u => {
    ctx.reply(
      `📩 @${u.username || "нема"}\n🆔 ${u.chat_id}\n🎓 Хоче: ${FAC[u.pendingFaculty]}`,
      Markup.inlineKeyboard([
        [{ text: "✔️", callback_data: `appr_${u.chat_id}` }],
        [{ text: "❌", callback_data: `rej_${u.chat_id}` }]
      ])
    );
  });
});

// ───────────────────────────────────────────
// Broadcast
// ───────────────────────────────────────────
const broadcasting = {};

bot.action("adm_broadcast", ctx => {
  if (!isAdmin(ctx.from.id)) return;
  broadcasting[String(ctx.from.id)] = true;
  ctx.reply("✍️ Напиши текст розсилки:");
});

bot.on("text", async ctx => {
  if (!broadcasting[String(ctx.from.id)]) return;

  broadcasting[String(ctx.from.id)] = false;
  const text = ctx.message.text;

  const users = await User.find({ approved: true });
  let sent = 0;

  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.chat_id, text);
      sent++;
    } catch {}
  }

  ctx.reply(`📢 Доставлено: ${sent}/${users.length}`);
});

// ───────────────────────────────────────────
// Профіль студента (!ти / /ти)
// ───────────────────────────────────────────
async function card(ctx, target) {
  let u = await User.findOne({ chat_id: String(target.id) });

  ctx.reply(
    `📇 *Картка студента*\n\n` +
    `🆔 ${target.id}\n` +
    `👤 ${target.first_name}\n` +
    `🔗 @${target.username || "—"}\n` +
    `🎓 ${u?.faculty ? FAC[u.faculty] : "нема"}\n` +
    `🔐 ${u?.approved ? "Доступ є" : "Нема"}`,
    { parse_mode: "Markdown" }
  );
}

bot.hears(/^!ти$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  if (!ctx.message.reply_to_message) return;
  card(ctx, ctx.message.reply_to_message.from);
});

bot.command("ти", async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  if (!ctx.message.reply_to_message) return;
  card(ctx, ctx.message.reply_to_message.from);
});

// ───────────────────────────────────────────
// Launch
// ───────────────────────────────────────────
bot.launch();
console.log("🚀 BOT ONLINE | MongoDB Prod Mode");