const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

// 👉 ВСТАВ СЮДИ СВІЙ ТОКЕН
const BOT_TOKEN = "8503102136:AAEwTajMmCIM3YZK5rny4pxCMu88itAaPUQ";

// 👉 РЕАЛЬНІ ID АДМІНІВ (числа з @userinfobot)
const ADMIN_IDS = [517143184, 6146757092];

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./db.sqlite');

// ─── ФАКУЛЬТЕТИ ───

const FACULTY_NAMES = {
  psy: "Психологія",
  eco: "Економіка",
  it: "Інформатика"
};

const FACULTY_CODES = ["psy", "eco", "it"];

// ─── СТАН ДЛЯ АДМІНІВ (РОЗСИЛКА / ПОШУК / REVOKE / ADD_EVENT) ───

const adminStates = {}; 
// { [adminId]: { mode: "broadcast" | "search" | "revoke_access" | "add_event", step?, faculty?, date? } }

// ─── БАЗА ───

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      faculty TEXT,
      approved INTEGER DEFAULT 0,
      request_sent INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      old_faculty TEXT,
      new_faculty TEXT,
      status TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty TEXT,
      date TEXT,
      title TEXT
    )
  `);
});

// ─── HELPERS ───

function isAdmin(id) {
  return ADMIN_IDS.includes(id);
}

function prettyFaculty(code) {
  return FACULTY_NAMES[code] || "—";
}

function facultyButtons(prefix = "FAC_") {
  return FACULTY_CODES.map(code => ([
    { text: FACULTY_NAMES[code], callback_data: prefix + code }
  ]));
}

function showUserMenu(ctx) {
  ctx.reply("📋 Твоє меню:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Календар", callback_data: "MENU_CALENDAR" }],
        [{ text: "🎓 Мій факультет", callback_data: "MENU_FACULTY" }],
        [{ text: "🔄 Змінити факультет", callback_data: "MENU_CHANGE_FACULTY" }]
      ]
    }
  });
}

function showAdminPanel(ctx) {
  ctx.reply("🛠 Адмін-панель:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Статистика", callback_data: "ADM_STATS" }],
        [{ text: "👥 Список юзерів", callback_data: "ADM_USERS" }],
        [{ text: "📢 Розсилка", callback_data: "ADM_BROADCAST" }],
        [{ text: "🔎 Пошук юзера", callback_data: "ADM_SEARCH" }],
        [{ text: "🚫 Забрати доступ", callback_data: "ADM_REVOKE" }],
        [{ text: "📅 Календар (адмін)", callback_data: "ADM_CALENDAR" }]
      ]
    }
  });
}

function showAdminCalendarMenu(ctx) {
  ctx.reply("📅 Календар (адмін):", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Додати подію", callback_data: "ADM_CAL_ADD" }],
        [{ text: "🗑 Видалити подію", callback_data: "ADM_CAL_DEL" }]
      ]
    }
  });
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}`;
}

function sendCalendar(ctx, chatId) {
  db.get(
    "SELECT faculty FROM users WHERE chat_id = ?",
    [chatId],
    (err, user) => {
      if (!user || !user.faculty) {
        ctx.reply("Спочатку обери факультет через /start.");
        return;
      }

      const faculty = user.faculty;

      db.all(
        "SELECT DISTINCT date FROM events WHERE faculty = ? AND date >= date('now') ORDER BY date LIMIT 30",
        [faculty],
        (e, rows) => {
          if (!rows || !rows.length) {
            ctx.reply("Для твого факультету ще немає запланованих подій 😴");
            return;
          }

          const dates = rows.map(r => r.date);
          const keyboard = [];
          for (let i = 0; i < dates.length; i += 3) {
            const slice = dates.slice(i, i + 3);
            keyboard.push(
              slice.map(d => ({
                text: formatDateLabel(d),
                callback_data: `CAL_DATE_${d}`
              }))
            );
          }

          keyboard.push([
            { text: "🔄 Оновити", callback_data: "CAL_REFRESH" }
          ]);

          ctx.reply("📅 Обери дату, щоб побачити події твого факультету:", {
            reply_markup: {
              inline_keyboard: keyboard
            }
          });
        }
      );
    }
  );
}

function ADMINIDS_notifyNewUser(chatId, username) {
  ADMIN_IDS.forEach(async (adminId) => {
    try {
      await bot.telegram.sendMessage(
        adminId,
        `🆕 Новий користувач хоче доступ до бота:\n\n` +
        `chat_id: ${chatId}\n` +
        `username: @${username || "—"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Дати доступ", callback_data: `GATE_OK_${chatId}` },
                { text: "❌ Відхилити", callback_data: `GATE_NO_${chatId}` }
              ]
            ]
          }
        }
      );
    } catch (e) {
      console.log("Не зміг написати адміну", adminId, e.description);
    }
  });
}

// ─── /start ───

bot.start(ctx => {
  const chatId = String(ctx.chat.id);
  const username = ctx.from.username || "";
  const isAdm = isAdmin(ctx.from.id);

  db.run(
    "INSERT OR IGNORE INTO users (chat_id, username, faculty, approved, request_sent) VALUES (?, ?, NULL, ?, 0)",
    [chatId, username, isAdm ? 1 : 0]
  );

  db.get(
    "SELECT faculty, approved, request_sent FROM users WHERE chat_id = ?",
    [chatId],
    (err, row) => {
      const faculty = row?.faculty || null;
      const approved = row?.approved === 1;
      const requestSent = row?.request_sent === 1;

      if (!isAdm && !approved) {
        if (!requestSent) {
          ctx.reply(
            "❌ У вас наразі немає доступу до бота.\n" +
            "Зверніться до менеджера, щоб вас підключили.\n\n" +
            "✅ Заявка відправлена. Після підтвердження просто надішліть /start ще раз."
          );
          db.run(
            "UPDATE users SET request_sent = 1 WHERE chat_id = ?",
            [chatId]
          );
          ADMINIDS_notifyNewUser(chatId, username);
        } else {
          ctx.reply(
            "⏳ Ваша заявка вже на розгляді.\n" +
            "Будь ласка, зачекайте, поки менеджер надасть доступ."
          );
        }
        return;
      }

      if (faculty) {
        ctx.reply("✅ У вас є доступ. Меню нижче 👇");
        showUserMenu(ctx);
        return;
      }

      ctx.reply(
        "👋 Привіт! Це тестовий бот підписки.\nОбери свій факультет:",
        {
          reply_markup: {
            inline_keyboard: facultyButtons("FAC_")
          }
        }
      );
    }
  );
});

// ─── /admin ───

bot.command("admin", ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Ти не в списку адмінів");
  showAdminPanel(ctx);
});

// ─── /add_event (резерв, якщо захочеш руками) ───
// формат: /add_event psy | 2025-12-01 | Назва події

bot.command("add_event", ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const raw = ctx.message.text.replace(/^\/add_event/, "").trim();
  const parts = raw.split("|").map(p => p.trim());

  if (parts.length < 3) {
    ctx.reply("❗ Формат:\n/add_event psy | 2025-12-01 | Назва події");
    return;
  }

  const faculty = parts[0];
  const date = parts[1];
  const title = parts[2];

  if (!FACULTY_CODES.includes(faculty)) {
    ctx.reply("Невірний faculty. Використовуй: " + FACULTY_CODES.join(", "));
    return;
  }

  db.run(
    "INSERT INTO events (faculty, date, title) VALUES (?, ?, ?)",
    [faculty, date, title],
    err => {
      if (err) {
        console.error("DB add_event error:", err);
        ctx.reply("Сталася помилка при додаванні події.");
        return;
      }
      ctx.reply(`✅ Подію додано для факультету ${prettyFaculty(faculty)} на ${date}`);
    }
  );
});

// ─── CALLBACK-и ───

bot.on('callback_query', ctx => {
  const data = ctx.callbackQuery.data;
  const chatId = String(ctx.callbackQuery.message.chat.id);
  const fromId = ctx.callbackQuery.from.id;

  // A) апрув доступу

  if (data.startsWith("GATE_OK_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    const targetId = data.replace("GATE_OK_", "");

    db.run(
      "UPDATE users SET approved = 1, request_sent = 0 WHERE chat_id = ?",
      [targetId]
    );

    bot.telegram.sendMessage(
      targetId,
      "✅ Вам надано доступ до бота.\nНапишіть /start, щоб продовжити.\n\nПосилання на чат: https://t.me/+8RWoLYUxHdc2ZTIy"
    ).catch(() => {});

    ctx.editMessageText("✅ Доступ користувачу надано");
    ctx.answerCbQuery();
    return;
  }

  if (data.startsWith("GATE_NO_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    const targetId = data.replace("GATE_NO_", "");

    db.run(
      "UPDATE users SET approved = 0, request_sent = 0 WHERE chat_id = ?",
      [targetId]
    );

    bot.telegram.sendMessage(
      targetId,
      "❌ Ваш запит на доступ до бота був відхилений.\nЗверніться до менеджера."
    ).catch(() => {});

    ctx.editMessageText("❌ Запит на доступ відхилено");
    ctx.answerCbQuery();
    return;
  }

  // B) вибір факультету

  if (data.startsWith("FAC_")) {
    const code = data.replace("FAC_", "");
    const nice = prettyFaculty(code);

    db.run(
      "UPDATE users SET faculty = ? WHERE chat_id = ? AND (faculty IS NULL OR faculty = '')",
      [code, chatId],
      function () {
        if (this.changes === 0) {
          ctx.answerCbQuery("Ти вже обрав факультет ✅", { show_alert: true });
          return;
        }
        ctx.editMessageReplyMarkup();
        ctx.reply(`✅ Збережено факультет: ${nice}`);
        showUserMenu(ctx);
      }
    );
    return;
  }

  // C) меню користувача

  if (data === "MENU_FACULTY") {
    db.get(
      "SELECT faculty FROM users WHERE chat_id = ?",
      [chatId],
      (e, row) => {
        const code = row?.faculty;
        const nice = prettyFaculty(code);
        ctx.reply(`🎓 Твій факультет: ${nice}`);
      }
    );
    ctx.answerCbQuery();
    return;
  }

  if (data === "MENU_CALENDAR") {
    sendCalendar(ctx, chatId);
    ctx.answerCbQuery();
    return;
  }

  if (data === "MENU_CHANGE_FACULTY") {
    ctx.reply("Обери новий факультет, запит піде на підтвердження адмінам 👇", {
      reply_markup: {
        inline_keyboard: facultyButtons("REQ_")
      }
    });
    ctx.answerCbQuery();
    return;
  }

  // D) календар: вибір дати

  if (data.startsWith("CAL_DATE_")) {
    const date = data.replace("CAL_DATE_", "");

    db.get(
      "SELECT faculty FROM users WHERE chat_id = ?",
      [chatId],
      (e, user) => {
        if (!user || !user.faculty) {
          ctx.reply("Спочатку обери факультет через /start.");
          return;
        }

        db.all(
          "SELECT id, title FROM events WHERE faculty = ? AND date = ? ORDER BY id",
          [user.faculty, date],
          (err, rows) => {
            if (!rows || !rows.length) {
              ctx.reply("На цю дату подій немає.");
              return;
            }

            const list = rows.map(e => `• ${e.title}`).join("\n");
            ctx.reply(
              `📅 Події на ${date} для факультету ${prettyFaculty(user.faculty)}:\n\n` + list,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "⬅ Назад до календаря", callback_data: "CAL_BACK" }]
                  ]
                }
              }
            );
          }
        );
      }
    );

    ctx.answerCbQuery();
    return;
  }

  if (data === "CAL_BACK" || data === "CAL_REFRESH") {
    sendCalendar(ctx, chatId);
    ctx.answerCbQuery();
    return;
  }

  // E) запит на зміну факультету

  if (data.startsWith("REQ_")) {
    const newCode = data.replace("REQ_", "");
    const newNice = prettyFaculty(newCode);

    db.get(
      "SELECT faculty FROM users WHERE chat_id = ?",
      [chatId],
      (e, row) => {
        const oldCode = row?.faculty || null;
        const oldNice = prettyFaculty(oldCode);

        db.run(
          "INSERT INTO change_requests (chat_id, old_faculty, new_faculty, status) VALUES (?, ?, ?, 'pending')",
          [chatId, oldCode, newCode]
        );

        ctx.reply("✅ Запит на зміну факультету відправлено. Чекай рішення адміна.");
        ctx.answerCbQuery();

        ADMIN_IDS.forEach(async (adminId) => {
          try {
            await bot.telegram.sendMessage(
              adminId,
              `🔁 Запит на зміну факультету:\n\n` +
              `chat_id: ${chatId}\n` +
              `З: ${oldNice}\n` +
              `На: ${newNice}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "✅ Схвалити", callback_data: `ADMIN_OK_${chatId}_${newCode}` },
                      { text: "❌ Відхилити", callback_data: `ADMIN_NO_${chatId}` }
                    ]
                  ]
                }
              }
            );
          } catch (err) {
            console.log("Не зміг написати адміну (change req)", adminId, err.description);
          }
        });
      }
    );

    return;
  }

  // F) адмін: схвалити/відхилити зміну факультету

  if (data.startsWith("ADMIN_OK_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }

    const parts = data.split("_");
    const targetId = parts[2];
    const newCode = parts[3];
    const newNice = prettyFaculty(newCode);

    db.run(
      "UPDATE users SET faculty = ? WHERE chat_id = ?",
      [newCode, targetId]
    );
    db.run(
      "UPDATE change_requests SET status = 'approved' WHERE chat_id = ? AND status = 'pending'",
      [targetId]
    );

    bot.telegram.sendMessage(
      targetId,
      `✅ Твій факультет змінено на: ${newNice}`
    ).catch(() => {});

    ctx.editMessageText("✅ Зміну факультету схвалено");
    ctx.answerCbQuery();
    return;
  }

  if (data.startsWith("ADMIN_NO_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }

    const targetId = data.split("_")[2];

    db.run(
      "UPDATE change_requests SET status = 'rejected' WHERE chat_id = ? AND status = 'pending'",
      [targetId]
    );

    bot.telegram.sendMessage(
      targetId,
      "❌ Запит на зміну факультету відхилено"
    ).catch(() => {});

    ctx.editMessageText("❌ Запит відхилено");
    ctx.answerCbQuery();
    return;
  }

  // G) адмін-календар: меню

  if (data === "ADM_CALENDAR") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    showAdminCalendarMenu(ctx);
    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_CAL_ADD") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    adminStates[fromId] = { mode: "add_event", step: "faculty" };
    ctx.reply("📚 Обери факультет для події:", {
      reply_markup: {
        inline_keyboard: facultyButtons("ADDEV_FAC_")
      }
    });
    ctx.answerCbQuery();
    return;
  }

  if (data.startsWith("ADDEV_FAC_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    const code = data.replace("ADDEV_FAC_", "");
    if (!FACULTY_CODES.includes(code)) {
      ctx.answerCbQuery("Невірний факультет", { show_alert: true });
      return;
    }

    adminStates[fromId] = {
      mode: "add_event",
      step: "date",
      faculty: code
    };

    ctx.reply(
      `✏ Обрано факультет: ${prettyFaculty(code)}\nВведи дату у форматі YYYY-MM-DD:`
    );
    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_CAL_DEL") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }

    db.all(
      "SELECT id, faculty, date, title FROM events ORDER BY date LIMIT 30",
      [],
      (err, rows) => {
        if (err) {
          console.error("ADM_CAL_DEL error:", err);
          ctx.reply("Помилка при завантаженні подій.");
          return;
        }

        if (!rows || !rows.length) {
          ctx.reply("Поки що немає подій для видалення.");
          return;
        }

        const keyboard = rows.map(ev => ([
          {
            text: `${formatDateLabel(ev.date)} • ${prettyFaculty(ev.faculty)}`,
            callback_data: `DEL_EVENT_${ev.id}`
          }
        ]));

        ctx.reply("🗑 Обери подію для видалення:", {
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      }
    );

    ctx.answerCbQuery();
    return;
  }

  if (data.startsWith("DEL_EVENT_")) {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    const idStr = data.replace("DEL_EVENT_", "");
    const eventId = parseInt(idStr, 10);

    db.run(
      "DELETE FROM events WHERE id = ?",
      [eventId],
      function (err) {
        if (err) {
          console.error("DEL_EVENT error:", err);
          ctx.reply("Помилка при видаленні події.");
          return;
        }
        if (this.changes === 0) {
          ctx.reply("Подію не знайдено (можливо, вже видалена).");
        } else {
          ctx.editMessageText("✅ Подію видалено.");
        }
      }
    );

    ctx.answerCbQuery();
    return;
  }

  // H) адмін-панель: стата / юзери / розсилка / пошук / revoke

  if (data === "ADM_STATS") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }

    db.all(
      "SELECT faculty, COUNT(*) as count FROM users GROUP BY faculty",
      (e, rows) => {
        if (!rows || !rows.length) {
          ctx.reply("Поки що нема юзерів 🤷‍♂️");
        } else {
          let text = "📊 Статистика по факультетах:\n\n";
          rows.forEach(r => {
            text += `${prettyFaculty(r.faculty)} — ${r.count}\n`;
          });
          ctx.reply(text);
        }
      }
    );

    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_USERS") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }

    db.all("SELECT * FROM users", (e, rows) => {
      if (!rows || !rows.length) {
        ctx.reply("Юзерів ще нема.");
        return;
      }

      const chunks = [];
      let current = "";

      rows.forEach(u => {
        const line =
          `👤 ${u.username || "—"} | ${u.chat_id} | ${prettyFaculty(u.faculty)} | approved: ${u.approved ? "✅" : "❌"}\n`;
        if ((current + line).length > 3500) {
          chunks.push(current);
          current = line;
        } else {
          current += line;
        }
      });
      if (current) chunks.push(current);

      chunks.forEach(chunk => ctx.reply(chunk));
    });

    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_BROADCAST") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    adminStates[fromId] = { mode: "broadcast" };
    ctx.reply("📢 Введи текст розсилки (піде всім схваленим юзерам):");
    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_SEARCH") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    adminStates[fromId] = { mode: "search" };
    ctx.reply("🔎 Введи username (без @), я знайду юзерів:");
    ctx.answerCbQuery();
    return;
  }

  if (data === "ADM_REVOKE") {
    if (!isAdmin(fromId)) {
      ctx.answerCbQuery("Ти не адмін", { show_alert: true });
      return;
    }
    adminStates[fromId] = { mode: "revoke_access" };
    ctx.reply("🚫 Введи username (без @) або chat_id, щоб забрати доступ:");
    ctx.answerCbQuery();
    return;
  }

  ctx.answerCbQuery();
});

// ─── МОДЕРАЦІЯ В ЧАТАХ (мут/бан) ───

async function handleModeration(ctx) {
  const chatId = ctx.chat.id;
  const fromId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (!isAdmin(fromId)) return;

  const reply = ctx.message.reply_to_message;
  if (!reply) {
    await ctx.reply("Зроби реплай на повідомлення користувача, якого хочеш мут/баннути.");
    return;
  }

  const targetId = reply.from.id;
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  const isMute = cmd === "!мут" || cmd === "!mute";
  const isUnmute = cmd === "!размут" || cmd === "!unmute";
  const isBan = cmd === "!бан" || cmd === "!ban";
  const isUnban = cmd === "!унбан" || cmd === "!unban";

  try {
    if (isMute) {
      let hours = 1;
      if (parts.length >= 3) {
        const num = parseInt(parts[1], 10);
        const unit = parts[2].toLowerCase();
        if (!isNaN(num)) {
          if (unit.startsWith("г") || unit.startsWith("h")) hours = num;
        }
      }
      const untilDate = Math.floor(Date.now() / 1000) + hours * 60 * 60;

      await ctx.telegram.restrictChatMember(chatId, targetId, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false
        },
        until_date: untilDate
      });

      await ctx.reply(`🔇 Користувач замучений на ${hours} год.`);
      return;
    }

    if (isUnmute) {
      await ctx.telegram.restrictChatMember(chatId, targetId, {
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: false,
          can_invite_users: true,
          can_pin_messages: false
        }
      });
      await ctx.reply("🔊 Мут знято.");
      return;
    }

    if (isBan) {
      await ctx.telegram.banChatMember(chatId, targetId);
      await ctx.reply("⛔ Користувача забанено.");
      return;
    }

    if (isUnban) {
      await ctx.telegram.unbanChatMember(chatId, targetId);
      await ctx.reply("✅ Користувача розбанено.");
      return;
    }
  } catch (err) {
    console.error("Moderation error:", err);
    await ctx.reply("⚠️ Не вдалось виконати дію. Перевір, чи бот адмін з правами.");
  }
}

// ─── ТЕКСТОВІ ПОВІДОМЛЕННЯ ───

bot.on('text', async ctx => {
  const chatType = ctx.chat.type;
  const fromId = ctx.from.id;
  const text = ctx.message.text || "";

  // 1) МОДЕРАЦІЯ В ГРУПАХ
  if ((chatType === "group" || chatType === "supergroup") && text.startsWith("!")) {
    if (isAdmin(fromId)) {
      await handleModeration(ctx);
    }
    return;
  }

  // 2) АДМІНСЬКІ СТАНИ (тільки в приваті)
  if (chatType !== "private" || !isAdmin(fromId)) return;

  const state = adminStates[fromId];
  if (!state) return;

  // РОЗСИЛКА
  if (state.mode === "broadcast") {
    delete adminStates[fromId];

    db.all("SELECT chat_id FROM users WHERE approved = 1", async (e, rows) => {
      if (!rows || !rows.length) {
        ctx.reply("Немає схвалених юзерів для розсилки.");
        return;
      }

      let ok = 0;
      let fail = 0;

      for (const u of rows) {
        try {
          await bot.telegram.sendMessage(u.chat_id, text);
          ok++;
        } catch {
          fail++;
        }
      }

      ctx.reply(
        `✅ Розсилка завершена\n\n` +
        `📬 Всього користувачів: ${rows.length}\n` +
        `✅ Доставлено: ${ok}\n` +
        `❌ Не доставлено: ${fail}`
      );
    });

    return;
  }

  // ПОШУК
  if (state.mode === "search") {
    delete adminStates[fromId];

    const uname = text.replace("@", "");

    db.all(
      "SELECT * FROM users WHERE username LIKE ?",
      [`%${uname}%`],
      (e, rows) => {
        if (!rows || !rows.length) {
          ctx.reply("🔍 Нічого не знайдено.");
          return;
        }

        const result = rows.map(u =>
          `👤 ${u.username || "—"}\n` +
          `ID: ${u.chat_id}\n` +
          `Факультет: ${prettyFaculty(u.faculty)}\n` +
          `Доступ: ${u.approved ? "✅" : "❌"}`
        ).join("\n\n");

        ctx.reply(result);
      }
    );

    return;
  }

  // ДОДАВАННЯ ПОДІЇ ЧЕРЕЗ АДМІН-МЕНЮ
  if (state.mode === "add_event") {
    if (state.step === "date") {
      const date = text.trim();
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(date);
      if (!ok) {
        ctx.reply("❗ Невірний формат дати. Приклад: 2025-12-01");
        return;
      }

      adminStates[fromId].date = date;
      adminStates[fromId].step = "title";
      ctx.reply("📝 Введи назву події:");
      return;
    }

    if (state.step === "title") {
      const title = text.trim();
      const { faculty, date } = adminStates[fromId];

      db.run(
        "INSERT INTO events (faculty, date, title) VALUES (?, ?, ?)",
        [faculty, date, title],
        err => {
          if (err) {
            console.error("add_event (wizard) error:", err);
            ctx.reply("Сталася помилка при додаванні події.");
            return;
          }
          ctx.reply(
            `✅ Подію додано:\n` +
            `Факультет: ${prettyFaculty(faculty)}\n` +
            `Дата: ${date}\n` +
            `Назва: ${title}`
          );
          delete adminStates[fromId];
        }
      );

      return;
    }
  }

  // РОЗВАЙТЛИСТ / ЗАБРАТИ ДОСТУП
  if (state.mode === "revoke_access") {
    delete adminStates[fromId];

    const input = text.trim();
    const isId = /^\d+$/.test(input);

    if (isId) {
      db.run(
        "UPDATE users SET approved = 0, request_sent = 0 WHERE chat_id = ?",
        [input],
        function (err) {
          if (err) {
            console.error("revoke_access error:", err);
            ctx.reply("Помилка при зміні доступу.");
            return;
          }
          if (this.changes === 0) {
            ctx.reply("Користувача з таким chat_id не знайдено.");
          } else {
            ctx.reply(`🚫 Доступ забрано у користувача з chat_id: ${input}`);
          }
        }
      );
    } else {
      const uname = input.replace("@", "");
      db.all(
        "SELECT * FROM users WHERE username LIKE ?",
        [`%${uname}%`],
        (err, rows) => {
          if (err) {
            console.error("revoke_access search error:", err);
            ctx.reply("Помилка при пошуку.");
            return;
          }
          if (!rows || !rows.length) {
            ctx.reply("Користувачів з таким username не знайдено.");
            return;
          }

          const ids = rows.map(r => r.chat_id);
          db.run(
            `UPDATE users SET approved = 0, request_sent = 0 WHERE chat_id IN (${ids.map(()=>'?').join(',')})`,
            ids,
            function (e2) {
              if (e2) {
                console.error("revoke_access update many error:", e2);
                ctx.reply("Помилка при зміні доступу.");
                return;
              }
              ctx.reply(`🚫 Доступ забрано у ${ids.length} користувача(ів).`);
            }
          );
        }
      );
    }
  }
});

// ─── ЗАПУСК ───

bot.launch();
console.log("✅ Бот запущений");