const sharp = require("sharp");

const TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const SECRET = process.env.WEBHOOK_SECRET;
const API = `https://api.telegram.org/bot${TOKEN}`;

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

const reply = (chatId, text) => tg("sendMessage", { chat_id: chatId, text });

// ---------- Supabase ----------
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function getMode(userId) {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/users?user_id=eq.${userId}&select=mode`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0]?.mode) || "sticker";
  } catch (e) {
    return "sticker";
  }
}

async function setMode(userId, mode) {
  await fetch(`${SB_URL}/rest/v1/users?on_conflict=user_id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: userId, mode }),
  });
}

// ---------- Логіка бота ----------
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  if (text.startsWith("/start")) {
    return reply(
      chatId,
      "Привіт! 👋\n\n" +
        "Надішли мені картинку, і я додам її у твій набір.\n\n" +
        "/sticker — режим наліпок (за замовчуванням)\n" +
        "/emoji — режим кастомних емоджі\n\n" +
        "Підказки:\n" +
        "• Щоб фон лишався прозорим, надсилай картинку як ФАЙЛ.\n" +
        "• Щоб прив'язати до наліпки своє емоджі, напиши його в підписі до картинки."
    );
  }

  if (text.startsWith("/sticker")) {
    await setMode(userId, "sticker");
    return reply(chatId, "Режим: наліпки ✅ Надсилай картинку.");
  }

  if (text.startsWith("/emoji")) {
    await setMode(userId, "emoji");
    return reply(chatId, "Режим: емоджі ✅ Надсилай картинку.");
  }

  // Шукаємо картинку в повідомленні
  let fileId = null;
  if (msg.photo) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    fileId = msg.document.file_id;
  }

  if (!fileId) {
    return reply(chatId, "Надішли мені картинку 🙂");
  }

  // Яке емоджі прив'язати
  const found = (msg.caption || "").match(/\p{Extended_Pictographic}/u);
  const emoji = found ? found[0] : "😀";

  // Завантажуємо картинку з Telegram
  const fileInfo = await tg("getFile", { file_id: fileId });
  if (!fileInfo.ok) return reply(chatId, "Не вдалося отримати файл 😕");

  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.result.file_path}`
  );
  const buf = Buffer.from(await fileRes.arrayBuffer());

  // Обробка картинки
  const mode = await getMode(userId);
  const isEmoji = mode === "emoji";

  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const png = isEmoji
    ? await sharp(buf)
        .resize(100, 100, { fit: "contain", background: transparent })
        .png()
        .toBuffer()
    : await sharp(buf)
        .resize(512, 512, { fit: "inside" })
        .png()
        .toBuffer();

  // Назви наборів: окремо для наліпок (s...) та емоджі (e...)
  const setName = `${isEmoji ? "e" : "s"}${userId}_by_${BOT_USERNAME}`;
  const exists = (await tg("getStickerSet", { name: setName })).ok;

  const form = new FormData();
  form.append("user_id", String(userId));
  form.append("name", setName);
  form.append("file0", new Blob([png], { type: "image/png" }), "sticker.png");

  const inputSticker = {
    sticker: "attach://file0",
    format: "static",
    emoji_list: [emoji],
  };

  let result;
  if (exists) {
    form.append("sticker", JSON.stringify(inputSticker));
    result = await tgForm("addStickerToSet", form);
  } else {
    form.append("title", isEmoji ? "Мої емоджі" : "Мої наліпки");
    form.append("stickers", JSON.stringify([inputSticker]));
    if (isEmoji) form.append("sticker_type", "custom_emoji");
    result = await tgForm("createNewStickerSet", form);
  }

  if (!result.ok) {
    return reply(chatId, `Не вийшло 😕\nПомилка Telegram: ${result.description}`);
  }

  const link = isEmoji
    ? `https://t.me/addemoji/${setName}`
    : `https://t.me/addstickers/${setName}`;
  return reply(chatId, `Готово! ✅\n${link}`);
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
