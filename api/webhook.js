const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execFileP = promisify(execFile);

const TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const SECRET = process.env.WEBHOOK_SECRET;
const API = `https://api.telegram.org/bot${TOKEN}`;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgForm(method, form) {
  const r = await fetch(`${API}/${method}`, { method: "POST", body: form });
  return r.json();
}

const send = (chatId, text, markup) =>
  tg("sendMessage", {
    chat_id: chatId,
    text,
    ...(markup ? { reply_markup: markup } : {}),
  });

async function downloadFile(fileId) {
  const info = await tg("getFile", { file_id: fileId });
  if (!info.ok) {
    throw new Error("Не вдалося отримати файл (можливо, він більший за 20 МБ).");
  }
  const res = await fetch(
    `https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`
  );
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Supabase ----------
const sbHeaders = {
  apikey: SB_KEY,
  "Content-Type": "application/json",
  // Старий ключ (eyJ...) це JWT і потребує Bearer. Новий (sb_secret_...) ні.
  ...(SB_KEY && SB_KEY.startsWith("eyJ")
    ? { Authorization: `Bearer ${SB_KEY}` }
    : {}),
};

async function getState(userId) {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/users?user_id=eq.${userId}&select=*`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    if (!r.ok) {
      console.error("Supabase GET error:", r.status, JSON.stringify(rows));
      return {};
    }
    return (Array.isArray(rows) && rows[0]) || {};
  } catch (e) {
    console.error("Supabase GET exception:", e);
    return {};
  }
}

// Повертає true, якщо збережено
async function saveState(userId, fields) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId, ...fields }),
    });
    if (!r.ok) {
      console.error("Supabase SAVE error:", r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("Supabase SAVE exception:", e);
    return false;
  }
}

async function debugSupabase(userId) {
  const keyType = !SB_KEY
    ? "НЕМАЄ"
    : SB_KEY.startsWith("eyJ")
    ? "старий JWT-ключ"
    : SB_KEY.startsWith("sb_secret_")
    ? "новий secret-ключ"
    : SB_KEY.startsWith("sb_publishable_")
    ? "publishable (НЕ ПІДХОДИТЬ, потрібен secret/service_role)"
    : "невідомий формат";
  const lines = [
    `SUPABASE_URL: ${SB_URL ? "є" : "НЕМАЄ"}`,
    `SUPABASE_KEY: ${keyType}`,
  ];

  try {
    const g = await fetch(
      `${SB_URL}/rest/v1/users?user_id=eq.${userId}&select=*`,
      { headers: sbHeaders }
    );
    lines.push(`Читання: ${g.status} ${(await g.text()).slice(0, 250)}`);
  } catch (e) {
    lines.push(`Читання: помилка з'єднання ${e.message}`);
  }

  try {
    const w = await fetch(`${SB_URL}/rest/v1/users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId }),
    });
    lines.push(`Запис: ${w.status} ${(await w.text()).slice(0, 250)}`);
  } catch (e) {
    lines.push(`Запис: помилка з'єднання ${e.message}`);
  }

  return lines.join("\n");
}

// ---------- Кнопки і тексти ----------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "🖼 Створити стікер-пак", callback_data: "new:sticker" }],
    [{ text: "😀 Створити емоджі", callback_data: "new:emoji" }],
  ],
};

const STICKER_TYPES = {
  inline_keyboard: [
    [
      { text: "🎞 Анімовані", callback_data: "t:sticker:video" },
      { text: "🖼 Звичайні", callback_data: "t:sticker:static" },
    ],
  ],
};

const EMOJI_TYPES = {
  inline_keyboard: [
    [{ text: "🎨 Адаптивні (міняють колір)", callback_data: "t:emoji:adaptive" }],
    [
      { text: "😀 Звичайні", callback_data: "t:emoji:static" },
      { text: "🎞 Анімовані", callback_data: "t:emoji:video" },
    ],
  ],
};

const LABELS = {
  "sticker:static": "звичайні наліпки",
  "sticker:video": "анімовані наліпки",
  "emoji:static": "звичайні емоджі",
  "emoji:adaptive": "адаптивні емоджі",
  "emoji:video": "анімовані емоджі",
};

const WHAT_TO_SEND = {
  "sticker:static":
    "Надсилай картинки. Щоб фон був прозорим, надсилай їх як ФАЙЛ (скріпка → Файл).",
  "sticker:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку.",
  "emoji:static":
    "Надсилай картинки. Вони стануть квадратними 100×100. Для прозорого фону надсилай як ФАЙЛ.",
  "emoji:adaptive":
    "Надсилай прості однотонні іконки на прозорому фоні (як ФАЙЛ). Якщо фон непрозорий, темний малюнок на світлому фоні теж підійде. Колір підлаштується під текст сам.",
  "emoji:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку, розмір 100×100.",
};

const HELP_TEXT =
  "Я роблю наліпки та кастомні емоджі 🙂\n\n" +
  "/newsticker — створити стікер-пак (анімовані або звичайні)\n" +
  "/newemoji — створити набір емоджі (адаптивні, звичайні або анімовані)\n" +
  "/done — завершити набір\n" +
  "/cancel — скасувати\n\n" +
  "Як це працює: обираєш тип, пишеш назву набору, а потім надсилаєш картинки чи відео. Кожен файл додається в набір.\n\n" +
  "Щоб прив'язати до наліпки своє емоджі, напиши його в підписі до файлу (за замовчуванням 😀).";

function setLink(st) {
  const base = st.kind === "emoji" ? "addemoji" : "addstickers";
  return `https://t.me/${base}/${st.pack_name}`;
}

// ---------- Обробка зображень ----------
async function toAdaptive(buf) {
  // Робимо з картинки білий силует: колір потім підставить сам Telegram
  const { data, info } = await sharp(buf)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      hasAlpha = true;
      break;
    }
  }

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    let alpha = data[i + 3];
    if (!hasAlpha) {
      // Немає прозорості: темні пікселі стають непрозорими
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      alpha = Math.max(0, Math.min(255, Math.round(255 - lum)));
    }
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = alpha;
  }

  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize(100, 100, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

// ---------- Обробка відео (ffmpeg) ----------
function getFfmpeg() {
  if (!ffmpegPath) throw new Error("ffmpeg недоступний на сервері.");
  const dest = "/tmp/ffmpeg";
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(ffmpegPath, dest);
    fs.chmodSync(dest, 0o755);
  }
  return dest;
}

async function toWebm(buf, isEmoji) {
  const ff = getFfmpeg();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const input = path.join("/tmp", `in_${id}`);
  const output = path.join("/tmp", `out_${id}.webm`);
  fs.writeFileSync(input, buf);

  const size = isEmoji
    ? "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
    : "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";

  // Пробуємо від кращої якості до більш стиснутої, поки не влізе в 256 КБ
  const attempts = [
    { crf: 34, fps: 30 },
    { crf: 42, fps: 30 },
    { crf: 50, fps: 24 },
    { crf: 58, fps: 20 },
  ];

  try {
    for (const a of attempts) {
      const args = [
        "-y",
        "-i", input,
        "-t", "3",
        "-an",
        "-vf", `fps=${a.fps},format=rgba,${size}`,
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-b:v", "0",
        "-crf", String(a.crf),
        "-auto-alt-ref", "0",
        "-row-mt", "1",
        "-deadline", "good",
        "-cpu-used", "4",
        output,
      ];
      await execFileP(ff, args, { timeout: 40000, maxBuffer: 20 * 1024 * 1024 });
      const out = fs.readFileSync(output);
      if (out.length <= 256 * 1024) return out;
    }
    throw new Error("Не вдалося стиснути відео до 256 КБ. Спробуй простіше або коротше.");
  } finally {
    for (const f of [input, output]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function prepare(buf, kind, variant) {
  if (variant === "video") {
    return {
      buffer: await toWebm(buf, kind === "emoji"),
      mime: "video/webm",
      filename: "sticker.webm",
    };
  }

  if (kind === "emoji") {
    const out =
      variant === "adaptive"
        ? await toAdaptive(buf)
        : await sharp(buf)
            .resize(100, 100, { fit: "contain", background: TRANSPARENT })
            .png()
            .toBuffer();
    return { buffer: out, mime: "image/png", filename: "emoji.png" };
  }

  // Звичайна наліпка: WEBP, більша сторона 512, до 512 КБ
  let out;
  for (const q of [90, 75, 60, 40]) {
    out = await sharp(buf)
      .resize(512, 512, { fit: "inside" })
      .webp({ quality: q })
      .toBuffer();
    if (out.length <= 500 * 1024) break;
  }
  return { buffer: out, mime: "image/webp", filename: "sticker.webp" };
}

// ---------- Пошук файлу в повідомленні ----------
function pickFile(msg, variant) {
  const mime = msg.document?.mime_type || "";
  if (variant === "video") {
    if (msg.video) return msg.video;
    if (msg.animation) return msg.animation;
    if (msg.video_note) return msg.video_note;
    if (msg.document && (mime.startsWith("video/") || mime === "image/gif")) {
      return msg.document;
    }
    return null;
  }
  if (msg.photo) return msg.photo[msg.photo.length - 1];
  if (msg.document && mime.startsWith("image/")) return msg.document;
  return null;
}

// ---------- Завантаження в Telegram ----------
async function uploadToSet(userId, st, file, emoji) {
  const isEmoji = st.kind === "emoji";
  const inputSticker = {
    sticker: "attach://file0",
    format: st.variant === "video" ? "video" : "static",
    emoji_list: [emoji],
  };

  const baseForm = () => {
    const f = new FormData();
    f.append("user_id", String(userId));
    f.append("name", st.pack_name);
    f.append("file0", new Blob([file.buffer], { type: file.mime }), file.filename);
    return f;
  };

  const add = () => {
    const f = baseForm();
    f.append("sticker", JSON.stringify(inputSticker));
    return tgForm("addStickerToSet", f);
  };

  const create = () => {
    const f = baseForm();
    f.append("title", st.title || "Мій набір");
    f.append("stickers", JSON.stringify([inputSticker]));
    if (isEmoji) f.append("sticker_type", "custom_emoji");
    if (st.variant === "adaptive") f.append("needs_repainting", "true");
    return tgForm("createNewStickerSet", f);
  };

  const exists = (await tg("getStickerSet", { name: st.pack_name })).ok;
  if (exists) return add();

  const res = await create();
  // Якщо файли прийшли одночасно і набір уже хтось створив, просто додаємо
  if (!res.ok && /already occupied|already exists/i.test(res.description || "")) {
    return add();
  }
  return res;
}

async function handleMedia(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const f = pickFile(msg, st.variant);
  if (!f) {
    return send(
      chatId,
      st.variant === "video"
        ? "Для анімованих потрібне відео або GIF 🎞"
        : "Надішли картинку 🖼 (краще як файл, щоб зберегти прозорість)."
    );
  }
  if (f.file_size && f.file_size > 20 * 1024 * 1024) {
    return send(chatId, "Файл завеликий: Telegram дозволяє боту брати до 20 МБ 😕");
  }

  const found = (msg.caption || "").match(/\p{Extended_Pictographic}/u);
  const emoji = found ? found[0] : "😀";

  if (st.variant === "video") await send(chatId, "⏳ Обробляю відео...");

  try {
    const buf = await downloadFile(f.file_id);
    const file = await prepare(buf, st.kind, st.variant);
    const result = await uploadToSet(userId, st, file, emoji);

    if (!result.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${result.description}`);
    }
    return send(
      chatId,
      `Готово! ✅\n${setLink(st)}\n\nНадсилай ще або натисни /done, щоб завершити.`
    );
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

// ---------- Головна логіка ----------
async function handleCallback(cq) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const [a, kind, variant] = (cq.data || "").split(":");

  if (a === "new") {
    if (kind === "sticker") {
      return send(chatId, "Який стікер-пак створюємо?", STICKER_TYPES);
    }
    return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
  }

  if (a === "t" && LABELS[`${kind}:${variant}`]) {
    const saved = await saveState(userId, {
      kind,
      variant,
      step: "title",
      title: null,
      pack_name: null,
    });
    if (!saved) {
      return send(
        chatId,
        "⚠️ Не вдалося зберегти вибір у базі даних. Напиши /debug, щоб побачити причину."
      );
    }
    return send(
      chatId,
      `Обрано: ${LABELS[`${kind}:${variant}`]} ✅\n\nТепер напиши назву набору (до 64 символів).`
    );
  }
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  // Команди
  if (text.startsWith("/")) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();

    if (cmd === "/start") {
      return send(
        chatId,
        "Привіт! 👋 Я роблю наліпки та кастомні емоджі.\nЩо створюємо?",
        MAIN_MENU
      );
    }
    if (cmd === "/help") return send(chatId, HELP_TEXT, MAIN_MENU);
    if (cmd === "/debug") return send(chatId, await debugSupabase(userId));
    if (cmd === "/newsticker" || cmd === "/sticker") {
      return send(chatId, "Який стікер-пак створюємо?", STICKER_TYPES);
    }
    if (cmd === "/newemoji" || cmd === "/emoji") {
      return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
    }
    if (cmd === "/cancel") {
      await saveState(userId, { step: null });
      return send(chatId, "Скасовано. Щоб почати знову, натисни /start", MAIN_MENU);
    }
    if (cmd === "/done") {
      const st = await getState(userId);
      await saveState(userId, { step: null });
      if (st.pack_name) {
        const exists = (await tg("getStickerSet", { name: st.pack_name })).ok;
        if (exists) {
          return send(chatId, `Набір завершено 🎉\n${setLink(st)}`, MAIN_MENU);
        }
      }
      return send(chatId, "Поки що нічого не створено. Почнемо?", MAIN_MENU);
    }
    return send(chatId, "Не знаю такої команди. Спробуй /help");
  }

  const st = await getState(userId);

  // Очікуємо назву набору
  if (st.step === "title") {
    if (!text) {
      return send(chatId, "Спершу напиши назву набору текстом ✍️");
    }
    if (text.length > 64) {
      return send(chatId, "Назва задовга, максимум 64 символи. Спробуй коротше.");
    }
    const packName = `p${Date.now().toString(36)}u${userId}_by_${BOT_USERNAME}`;
    const saved = await saveState(userId, {
      title: text,
      pack_name: packName,
      step: "ready",
    });
    if (!saved) {
      return send(
        chatId,
        "⚠️ Не вдалося зберегти назву у базі даних. Напиши /debug, щоб побачити причину."
      );
    }
    return send(
      chatId,
      `Назва: «${text}» ✅\n\n${WHAT_TO_SEND[`${st.kind}:${st.variant}`]}\n\n` +
        "Щоб прив'язати своє емоджі, напиши його в підписі до файлу. Краще надсилай файли по одному."
    );
  }

  // Готові приймати файли
  if (st.step === "ready" && st.kind && st.variant && st.pack_name) {
    return handleMedia(msg, st);
  }

  return send(
    chatId,
    "Спершу створи набір 👇\n(якщо ти вже обирав тип, а бот не пам'ятає, напиши /debug)",
    MAIN_MENU
  );
}

// ---------- Точка входу для Vercel ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  // Перевірка, що запит справді від Telegram
  if (SECRET && req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error(e);
  }
  res.status(200).send("OK");
};
