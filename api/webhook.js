// =====================================================================
// ПРИВАТНИЙ БОТ
// Доступ мають лише адміністратор (ADMIN_ID) і люди, яких додано
// командою /adduser. Таблиці в Supabase: users (з колонкою opts), packs, allowed_users.
// Додатково: ефекти (/effects), нарізка на частини, інструменти для наборів, /extract.
// =====================================================================

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
const ADMIN_ID = String(process.env.ADMIN_ID || "").trim();
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

// Запасна пам'ять на випадок, якщо база даних недоступна
const mem = new Map();

async function getState(userId) {
  const local = mem.get(userId);
  // Якщо останній запис у базу не вдався, віримо пам'яті
  if (local && local.dirty) return local.data;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/users?user_id=eq.${userId}&select=*`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    if (!r.ok) {
      console.error("Supabase GET error:", r.status, JSON.stringify(rows));
      return local ? local.data : {};
    }
    if (Array.isArray(rows) && rows[0]) return rows[0];
    return local ? local.data : {};
  } catch (e) {
    console.error("Supabase GET exception:", e);
    return local ? local.data : {};
  }
}

// Зберігає стан у базу і в пам'ять. Повертає true, якщо база прийняла запис.
async function saveState(userId, fields) {
  const prev = (mem.get(userId) || {}).data || {};
  const data = { ...prev, ...fields };
  let ok = false;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId, ...fields }),
    });
    ok = r.ok;
    if (!r.ok) console.error("Supabase SAVE error:", r.status, await r.text());
  } catch (e) {
    console.error("Supabase SAVE exception:", e);
  }
  mem.set(userId, { data, dirty: !ok });
  return ok;
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

  try {
    const a = await fetch(`${SB_URL}/rest/v1/allowed_users?select=user_id&limit=1`, {
      headers: sbHeaders,
    });
    lines.push(`allowed_users: ${a.status} ${(await a.text()).slice(0, 250)}`);
  } catch (e) {
    lines.push(`allowed_users: помилка з'єднання ${e.message}`);
  }

  return lines.join("\n");
}

// ---------- Список дозволених користувачів ----------
async function isAllowed(userId) {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/allowed_users?user_id=eq.${userId}&select=user_id`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    if (!r.ok) {
      console.error("allowed_users GET error:", r.status, JSON.stringify(rows));
      return false;
    }
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error("allowed_users GET exception:", e);
    return false;
  }
}

async function addAllowed(id) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/allowed_users?on_conflict=user_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: Number(id) }),
    });
    if (r.ok) return { ok: true };
    const t = await r.text();
    console.error("allowed_users ADD error:", r.status, t);
    return { ok: false, info: `${r.status} ${t.slice(0, 300)}` };
  } catch (e) {
    console.error("allowed_users ADD exception:", e);
    return { ok: false, info: `помилка з'єднання: ${e.message}` };
  }
}

async function removeAllowed(id) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/allowed_users?user_id=eq.${Number(id)}`, {
      method: "DELETE",
      headers: sbHeaders,
    });
    if (r.ok) return { ok: true };
    const t = await r.text();
    console.error("allowed_users DEL error:", r.status, t);
    return { ok: false, info: `${r.status} ${t.slice(0, 300)}` };
  } catch (e) {
    console.error("allowed_users DEL exception:", e);
    return { ok: false, info: `помилка з'єднання: ${e.message}` };
  }
}

async function listAllowed() {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/allowed_users?select=user_id&order=added_at.asc`,
      { headers: sbHeaders }
    );
    const rows = await r.json();
    if (!r.ok || !Array.isArray(rows)) return null;
    return rows.map((x) => x.user_id);
  } catch (e) {
    return null;
  }
}

// ---------- Наявні набори (таблиця packs) ----------
const makePackName = (ts, userId) => `p${ts}u${userId}_by_${BOT_USERNAME}`;
const tsOf = (name) => ((name || "").match(/^p([0-9a-z]+)u\d+_by_/i) || [])[1];

async function sbJson(path, opts = {}) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders, ...opts });
    if (!r.ok) {
      console.error("Supabase error:", path, r.status, await r.text());
      return null;
    }
    const t = await r.text();
    return t ? JSON.parse(t) : [];
  } catch (e) {
    console.error("Supabase exception:", path, e);
    return null;
  }
}

async function recordPack(row) {
  const res = await sbJson("packs?on_conflict=pack_name", {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });
  return res !== null;
}

const listPacks = (userId) =>
  sbJson(`packs?user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`);

async function getPackRow(userId, name) {
  const rows = await sbJson(
    `packs?user_id=eq.${userId}&pack_name=eq.${encodeURIComponent(name)}&select=*`
  );
  return (rows && rows[0]) || null;
}

async function findCloneRow(userId, source) {
  const rows = await sbJson(
    `packs?user_id=eq.${userId}&source_set=eq.${encodeURIComponent(source)}&select=*&limit=1`
  );
  return (rows && rows[0]) || null;
}

const deletePackRow = (name) =>
  sbJson(`packs?pack_name=eq.${encodeURIComponent(name)}`, { method: "DELETE" });

const updatePackRow = (name, fields) =>
  sbJson(`packs?pack_name=eq.${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });

// ---------- Кнопки і тексти ----------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "🖼 Створити стікер-пак", callback_data: "new:sticker" }],
    [{ text: "😀 Створити емоджі", callback_data: "new:emoji" }],
    [{ text: "📚 Мої набори", callback_data: "my:list" }],
    [{ text: "📥 Скопіювати старий набір", callback_data: "cl:start" }],
    [
      { text: "🎛 Ефекти", callback_data: "fx:menu" },
      { text: "📤 Витягнути файл", callback_data: "ex:start" },
    ],
  ],
};

const STICKER_TYPES = {
  inline_keyboard: [
    [
      { text: "🎞 Анімовані", callback_data: "t:sticker:video" },
      { text: "🖼 Звичайні", callback_data: "t:sticker:static" },
    ],
    [{ text: "🔀 Змішаний (анімовані + звичайні)", callback_data: "t:sticker:mixed" }],
  ],
};

const EMOJI_TYPES = {
  inline_keyboard: [
    [{ text: "🎨 Адаптивні (міняють колір)", callback_data: "t:emoji:adaptive" }],
    [{ text: "😀 Звичайні", callback_data: "t:emoji:mixed" }],
  ],
};

const LABELS = {
  "sticker:static": "звичайні наліпки",
  "sticker:video": "анімовані наліпки",
  "sticker:mixed": "змішані наліпки (і анімовані, і звичайні)",
  "emoji:static": "звичайні емоджі",
  "emoji:adaptive": "адаптивні емоджі",
  "emoji:video": "анімовані емоджі",
  "emoji:mixed": "звичайні емоджі (будь-які)",
};

const WHAT_TO_SEND = {
  "sticker:static":
    "Надсилай картинки. Щоб фон був прозорим, надсилай їх як ФАЙЛ (скріпка → Файл).",
  "sticker:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку.",
  "sticker:mixed":
    "Надсилай що завгодно: картинки стануть звичайними наліпками, а відео чи GIF анімованими (перші 3 секунди). Усе потрапить в один набір.",
  "emoji:static":
    "Надсилай картинки. Вони стануть квадратними 100×100. Для прозорого фону надсилай як ФАЙЛ.",
  "emoji:adaptive":
    "Надсилай що завгодно: фото, картинки, відео, GIF, готові наліпки чи емоджі. Усе стане однотонним силуетом, а колір підлаштується під текст. Найкраще виходять прості іконки на прозорому фоні (як ФАЙЛ). Якщо фон непрозорий, темні елементи залишаться, а світлі зникнуть.",
  "emoji:video":
    "Надсилай відео або GIF. Береться перші 3 секунди, без звуку, розмір 100×100.",
  "emoji:mixed":
    "Надсилай що завгодно: картинки, відео, GIF, готові кастомні емоджі або звичайні наліпки (крім анімованих TGS). Усе стане емоджі 100×100.",
};

const HELP_TEXT =
  "Я роблю наліпки та кастомні емоджі 🙂\n\n" +
  "/newsticker — створити стікер-пак (можна додавати картинки, відео, GIF і готові наліпки)\n" +
  "/newemoji — створити набір емоджі (адаптивні або звичайні)\n" +
  "/mypacks — мої набори (додати, перейменувати, змінити емоджі й порядок, мініатюра, ключові слова, перемістити, резервна копія, видалити)\n" +
  "/clonepack — скопіювати старий набір, щоб його можна було редагувати\n" +
  "/effects — ефекти: обводка, фон, форма, швидкість, реверс, нарізка та інше\n" +
  "/extract — перетворити наліпку на файл (PNG, GIF, WEBM, TGS)\n" +
  "/done — завершити набір\n" +
  "/cancel — скасувати\n" +
  "/id — дізнатись свій Telegram ID\n\n" +
  "Як це працює: обираєш тип, пишеш назву набору, а потім надсилаєш картинки чи відео. Кожен файл додається в набір.\n\n" +
  "Щоб прив'язати до наліпки своє емоджі, напиши його в підписі до файлу (за замовчуванням 😀).";

function setLink(st) {
  const base = st.kind === "emoji" ? "addemoji" : "addstickers";
  return `https://t.me/${base}/${st.pack_name}`;
}

// ---------- Обробка зображень ----------
// mode: "auto" (як є), "alpha" (форма з прозорості), "luma" (видно темні пікселі)
async function toAdaptive(buf, opts = {}) {
  // Робимо з картинки білий силует: колір потім підставить сам Telegram
  const { data, info } = await sharp(buf)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let mode = opts.mode || "auto";
  if (mode === "auto") {
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) {
        hasAlpha = true;
        break;
      }
    }
    mode = hasAlpha ? "alpha" : "luma";
  }

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    let alpha = data[i + 3];
    if (mode === "luma") {
      // Немає прозорості: видно темні пікселі (або світлі, якщо увімкнено інверсію)
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const k = Math.max(0, Math.min(255, opts.invert ? lum : 255 - lum));
      alpha = Math.round((alpha * k) / 255);
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

// ---------- Ефекти для картинок (прості піксельні перетворення) ----------
const FX_DEFAULT = {
  outline: false,
  removeBg: false,
  trim: false,
  shape: "none",
  speed: 1,
  reverse: false,
  start: 0,
  chroma: false,
  grid: "off",
  invert: false,
};

function parseOpts(st) {
  try {
    return JSON.parse((st && st.opts) || "{}") || {};
  } catch (e) {
    return {};
  }
}
const fxOf = (st) => ({ ...FX_DEFAULT, ...(parseOpts(st).fx || {}) });

// Змінює збережені налаштування (opts) користувача
async function patchOpts(userId, fn) {
  const st = await getState(userId);
  const o = parseOpts(st);
  const next = fn(o) || o;
  const ok = await saveState(userId, { opts: JSON.stringify(next) });
  return { opts: next, ok };
}

const hasImageFx = (fx) => !!(fx.outline || fx.removeBg || fx.trim || fx.shape !== "none");

async function hasTransparency(buf) {
  const { data } = await sharp(buf)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

function colorDist(d, i, r, g, b) {
  const dr = d[i] - r;
  const dg = d[i + 1] - g;
  const db = d[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Прибирає однотонний фон, який стикається з краєм картинки
function removeSolidBackground(img, tol = 38) {
  const { data, width: w, height: h } = img;
  const cs = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  let r = 0, g = 0, b = 0;
  for (const c of cs) {
    // кут уже прозорий: фон прибрано
    if (data[c + 3] < 20) return img;
    r += data[c];
    g += data[c + 1];
    b += data[c + 2];
  }
  r /= 4; g /= 4; b /= 4;
  // кути мають бути одного кольору, інакше фон не однотонний
  for (const c of cs) {
    if (colorDist(data, c, r, g, b) > 40) return img;
  }

  const marked = new Uint8Array(w * h);
  const stack = [];
  const tryPush = (x, y) => {
    const p = y * w + x;
    if (marked[p]) return;
    if (colorDist(data, p * 4, r, g, b) <= tol) {
      marked[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) tryPush(x - 1, y);
    if (x < w - 1) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y < h - 1) tryPush(x, y + 1);
  }

  const out = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (marked[p]) {
        out[p * 4 + 3] = 0;
        continue;
      }
      // м'який край: пікселі поруч із прибраним фоном стають напівпрозорими
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && marked[yy * w + xx]) {
            near = true;
            break;
          }
        }
      }
      if (near) {
        const d = colorDist(data, p * 4, r, g, b);
        const k = Math.max(0, Math.min(1, (d - tol) / tol));
        out[p * 4 + 3] = Math.round(data[p * 4 + 3] * k);
      }
    }
  }
  return { data: out, width: w, height: h };
}

// Обрізає прозорі краї
function trimTransparent(img, thr = 10) {
  const { data, width: w, height: h } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const nw = x1 - x0 + 1;
  const nh = y1 - y0 + 1;
  if (nw === w && nh === h) return img;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    data.copy(out, y * nw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + nw) * 4);
  }
  return { data: out, width: nw, height: nh };
}

// Форма: коло або заокруглені кути
function applyShape(img, shape) {
  let { data, width: w, height: h } = img;
  if (shape === "circle") {
    const s = Math.min(w, h);
    const sq = Buffer.alloc(s * s * 4);
    const ox = Math.floor((w - s) / 2);
    const oy = Math.floor((h - s) / 2);
    for (let y = 0; y < s; y++) {
      data.copy(sq, y * s * 4, ((oy + y) * w + ox) * 4, ((oy + y) * w + ox + s) * 4);
    }
    data = sq; w = s; h = s;
  }
  const out = Buffer.from(data);
  const rad = shape === "circle" ? Math.min(w, h) / 2 : Math.max(2, Math.round(Math.min(w, h) * 0.2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dist;
      if (shape === "circle") {
        dist = Math.sqrt((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2);
      } else {
        const dx = Math.max(rad - x - 0.5, x + 0.5 - (w - rad), 0);
        const dy = Math.max(rad - y - 0.5, y + 0.5 - (h - rad), 0);
        dist = Math.sqrt(dx * dx + dy * dy);
      }
      const cover = Math.max(0, Math.min(1, rad - dist + 0.5));
      if (cover < 1) {
        const i = (y * w + x) * 4;
        out[i + 3] = Math.round(out[i + 3] * cover);
      }
    }
  }
  return { data: out, width: w, height: h };
}

// Біла обводка навколо силуету (стиль наліпок)
function addOutline(img, radius) {
  const { data, width: w, height: h } = img;
  const offs = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offs.push([dx, dy]);
    }
  }
  const out = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a === 255) continue;
      let oa = 0;
      for (const [dx, dy] of offs) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const na = data[(yy * w + xx) * 4 + 3];
        if (na > oa) {
          oa = na;
          if (oa === 255) break;
        }
      }
      if (oa <= a) continue;
      // оригінал поверх білого шару обводки
      const A = a + oa * (1 - a / 255);
      out[i] = Math.round((data[i] * a + 255 * oa * (1 - a / 255)) / A);
      out[i + 1] = Math.round((data[i + 1] * a + 255 * oa * (1 - a / 255)) / A);
      out[i + 2] = Math.round((data[i + 2] * a + 255 * oa * (1 - a / 255)) / A);
      out[i + 3] = Math.round(A);
    }
  }
  return { data: out, width: w, height: h };
}

async function resizeRaw(img, w, h) {
  const { data, info } = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function placeCentered(img, T) {
  const canvas = Buffer.alloc(T * T * 4);
  const ox = Math.floor((T - img.width) / 2);
  const oy = Math.floor((T - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(canvas, ((oy + y) * T + ox) * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return { data: canvas, width: T, height: T };
}

// target: 512 для наліпок, 100 для емоджі. Повертає PNG
async function processImageFx(buf, target, fx, isEmoji) {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let img = { data, width: info.width, height: info.height };

  if (fx.removeBg) img = removeSolidBackground(img);
  if (fx.trim || fx.removeBg) img = trimTransparent(img);
  if (fx.shape && fx.shape !== "none") img = applyShape(img, fx.shape);

  const pad = fx.outline ? (isEmoji ? 3 : 10) : 0;
  const box = target - 2 * pad;
  const scale = Math.min(box / img.width, box / img.height);
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));
  img = await resizeRaw(img, nw, nh);

  if (fx.outline) {
    img = addOutline(placeCentered(img, target), pad - 1);
  } else if (isEmoji) {
    img = placeCentered(img, target);
  }

  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
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

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WHITE = "lutrgb=r=255:g=255:b=255";

// Чи є прозорість у першому кадрі: true / false, або null, якщо не вдалося прочитати
async function videoHasAlpha(ff, input, decoderArgs) {
  try {
    const { stdout } = await execFileP(
      ff,
      [
        "-v", "error",
        ...decoderArgs,
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale=64:64",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "pipe:1",
      ],
      { encoding: "buffer", timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
    );
    for (let i = 3; i < stdout.length; i += 4) {
      if (stdout[i] < 250) return true;
    }
    return stdout.length > 0 ? false : null;
  } catch (e) {
    return null;
  }
}

// adaptive = true: перетворюємо відео на білий силует, колір підставить Telegram
// fx: { speed, reverse, start, chroma }, extra: { crop: {cols, rows, c, r}, maxBytes }
async function toWebm(buf, isEmoji, adaptive = false, fx = {}, extra = {}) {
  const ff = getFfmpeg();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const input = path.join("/tmp", `in_${id}`);
  const output = path.join("/tmp", `out_${id}.webm`);
  fs.writeFileSync(input, buf);

  const speed = fx.speed || 1;
  const reverse = !!fx.reverse;
  let start = fx.start || 0;
  const chroma = !!fx.chroma;
  const crop = extra.crop;
  const maxBytes = extra.maxBytes || 256 * 1024;
  // Скільки секунд вхідного відео читаємо, щоб вийшло 3 секунди результату
  const readSeconds = Math.min(reverse ? 6 : 12, 3 * speed);

  // WEBM з прозорістю треба читати декодером libvpx
  let decoderArgs = buf.subarray(0, 4).equals(WEBM_MAGIC) ? ["-c:v", "libvpx-vp9"] : [];

  let silhouette = "";
  if (adaptive) {
    let hasAlpha = chroma ? true : await videoHasAlpha(ff, input, decoderArgs);
    if (!chroma && hasAlpha === null && decoderArgs.length) {
      decoderArgs = [];
      hasAlpha = await videoHasAlpha(ff, input, decoderArgs);
    }
    silhouette = hasAlpha
      ? `${WHITE},`
      : // Немає прозорості: темні пікселі стають непрозорими
        `split[a][b];[a]format=gray,negate[m];[b]${WHITE}[w];[w][m]alphamerge,format=rgba,`;
  }

  const size = isEmoji
    ? "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
    : "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";

  // Пробуємо від кращої якості до більш стиснутої, поки не влізе в ліміт
  const attempts =
    maxBytes < 100 * 1024
      ? [
          { crf: 45, fps: 20 },
          { crf: 52, fps: 15 },
          { crf: 58, fps: 12 },
          { crf: 63, fps: 10 },
        ]
      : [
          { crf: 34, fps: 30 },
          { crf: 42, fps: 30 },
          { crf: 50, fps: 24 },
          { crf: 58, fps: 20 },
        ];

  const buildArgs = (a, dec, ss) => {
    const pre = [];
    if (reverse) pre.push("reverse");
    if (speed !== 1) pre.push(`setpts=PTS/${speed}`);
    pre.push(`fps=${a.fps}`);
    if (crop) {
      pre.push(
        `crop=iw/${crop.cols}:ih/${crop.rows}:iw/${crop.cols}*${crop.c}:ih/${crop.rows}*${crop.r}`
      );
    }
    if (chroma) pre.push("chromakey=color=0x00ff00:similarity=0.28:blend=0.08");
    return [
      "-y",
      ...(ss > 0 ? ["-ss", String(ss)] : []),
      "-t", String(readSeconds),
      ...dec,
      "-i", input,
      "-t", "3",
      "-an",
      "-vf", `${pre.join(",")},format=rgba,${silhouette}${size}`,
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
  };
  const opts = { timeout: 40000, maxBuffer: 20 * 1024 * 1024 };

  const runOnce = async (a) => {
    try {
      await execFileP(ff, buildArgs(a, decoderArgs, start), opts);
    } catch (e) {
      if (decoderArgs.length) {
        decoderArgs = []; // можливо, це не VP9, пробуємо звичайний декодер
        return runOnce(a);
      }
      if (start > 0) {
        start = 0; // відео коротше за вибраний початок
        return runOnce(a);
      }
      throw e;
    }
  };

  try {
    for (const a of attempts) {
      await runOnce(a);
      let out = fs.readFileSync(output);
      if (out.length < 1000 && start > 0) {
        start = 0;
        await runOnce(a);
        out = fs.readFileSync(output);
      }
      if (out.length <= maxBytes) return out;
    }
    throw new Error(
      `Не вдалося стиснути відео до ${Math.round(maxBytes / 1024)} КБ. Спробуй простіше або коротше.`
    );
  } finally {
    for (const f of [input, output]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

// WEBM-наліпка в GIF (для команди «Витягнути файл»)
async function webmToGif(buf) {
  const ff = getFfmpeg();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const input = path.join("/tmp", `in_${id}`);
  const output = path.join("/tmp", `out_${id}.gif`);
  fs.writeFileSync(input, buf);
  let dec = buf.subarray(0, 4).equals(WEBM_MAGIC) ? ["-c:v", "libvpx-vp9"] : [];
  const args = (d) => [
    "-y",
    ...d,
    "-i", input,
    "-t", "3",
    "-vf",
    "fps=15,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128",
    "-loop", "0",
    output,
  ];
  const opts = { timeout: 40000, maxBuffer: 20 * 1024 * 1024 };
  try {
    try {
      await execFileP(ff, args(dec), opts);
    } catch (e) {
      if (!dec.length) throw e;
      await execFileP(ff, args([]), opts);
    }
    return fs.readFileSync(output);
  } finally {
    for (const f of [input, output]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function prepare(buf, kind, variant, fx = FX_DEFAULT) {
  if (variant === "video" || variant === "adaptive_video") {
    return {
      buffer: await toWebm(buf, kind === "emoji", variant === "adaptive_video", fx),
      mime: "video/webm",
      filename: "sticker.webm",
    };
  }

  const imgFx = hasImageFx(fx);

  if (kind === "emoji") {
    let out;
    if (variant === "adaptive") {
      // Обводка в білому силуеті не має сенсу, тому її вимикаємо
      const src = imgFx ? await processImageFx(buf, 100, { ...fx, outline: false }, true) : buf;
      const mode = imgFx
        ? fx.removeBg || fx.shape !== "none" || (await hasTransparency(buf))
          ? "alpha"
          : "luma"
        : "auto";
      out = await toAdaptive(src, { mode, invert: fx.invert });
    } else if (imgFx) {
      out = await processImageFx(buf, 100, fx, true);
    } else {
      out = await sharp(buf)
        .resize(100, 100, { fit: "contain", background: TRANSPARENT })
        .png()
        .toBuffer();
    }
    return { buffer: out, mime: "image/png", filename: "emoji.png" };
  }

  // Звичайна наліпка: WEBP, більша сторона 512, до 512 КБ
  const src = imgFx ? await processImageFx(buf, 512, fx, false) : buf;
  let out;
  for (const q of [90, 75, 60, 40]) {
    out = await sharp(src)
      .resize(512, 512, { fit: "inside" })
      .webp({ quality: q })
      .toBuffer();
    if (out.length <= 500 * 1024) break;
  }
  return { buffer: out, mime: "image/webp", filename: "sticker.webp" };
}

// ---------- Пошук файлу в повідомленні ----------
// Повертає { file, variant }, де variant це те, як саме обробляти цей файл
function pickFile(msg, variant) {
  const mime = msg.document?.mime_type || "";
  const video =
    msg.video ||
    msg.animation ||
    msg.video_note ||
    (msg.document && (mime.startsWith("video/") || mime === "image/gif")
      ? msg.document
      : null);
  const image = msg.photo
    ? msg.photo[msg.photo.length - 1]
    : msg.document && mime.startsWith("image/")
    ? msg.document
    : null;

  if (variant === "adaptive") {
    if (video) return { file: video, variant: "adaptive_video" };
    if (image) return { file: image, variant: "adaptive" };
    return null;
  }
  if (variant === "video") return video ? { file: video, variant: "video" } : null;
  if (variant === "mixed") {
    if (video) return { file: video, variant: "video" };
    if (image) return { file: image, variant: "static" };
    return null;
  }
  return image ? { file: image, variant } : null;
}

// ---------- Завантаження в Telegram ----------
// source: { buffer, mime, filename } для нового файлу або { fileId } для готової наліпки
async function uploadToSet(userId, st, source, emoji, format) {
  const isEmoji = st.kind === "emoji";
  const inputSticker = {
    sticker: source.fileId || "attach://file0",
    format,
    emoji_list: [emoji],
  };

  const baseForm = () => {
    const f = new FormData();
    f.append("user_id", String(userId));
    f.append("name", st.pack_name);
    if (source.buffer) {
      f.append("file0", new Blob([source.buffer], { type: source.mime }), source.filename);
    }
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

// Додавання готової наліпки (яку користувач переслав боту)
async function importSticker(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sk = msg.sticker;
  const isEmojiPack = st.kind === "emoji";

  if (sk.type === "mask") {
    return send(chatId, "Маскові наліпки бот не підтримує 🙂");
  }
  const isCustomEmoji = sk.type === "custom_emoji";
  if (!isEmojiPack && isCustomEmoji) {
    return send(
      chatId,
      "Це кастомне емоджі, а зараз створюється набір наліпок. Для емоджі створи окремий набір: /newemoji"
    );
  }

  const format = sk.is_video ? "video" : sk.is_animated ? "animated" : "static";
  const v = st.variant;
  const ok =
    v === "mixed" ||
    v === "adaptive" ||
    (v === "static" && format === "static") ||
    (v === "video" && format !== "static");
  if (!ok) {
    const hint = isEmojiPack
      ? "Для будь-яких емоджі створи набір «Звичайні» (/newemoji)."
      : "Створи змішаний набір (/newsticker → Змішаний), щоб додавати будь-які.";
    const why =
      v === "adaptive"
        ? "В адаптивний набір можна додавати лише нерухомі зображення й емоджі."
        : format === "static"
        ? "Це нерухоме, а набір анімований."
        : "Це анімоване, а набір для нерухомих.";
    return send(chatId, `${why}\n${hint}`);
  }

  try {
    // Наліпки й готові кастомні емоджі додаємо напряму за file_id.
    // Звичайну наліпку для емоджі та неадаптивне емоджі для адаптивного набору перетворюємо.
    const direct =
      !isEmojiPack || (isCustomEmoji && (v !== "adaptive" || sk.needs_repainting));
    let source = { fileId: sk.file_id };
    let fmt = format;

    if (!direct) {
      if (format === "animated") {
        return send(
          chatId,
          "Анімовані (TGS) наліпки не можна перетворити на емоджі. Надішли відео чи GIF або готове кастомне емоджі."
        );
      }
      const buf = await downloadFile(sk.file_id);
      source = await prepare(
        buf,
        "emoji",
        format === "video"
          ? v === "adaptive"
            ? "adaptive_video"
            : "video"
          : v === "adaptive"
          ? "adaptive"
          : "static",
        fxOf(st)
      );
      fmt = format === "video" ? "video" : "static";
    }

    const result = await uploadToSet(userId, st, source, sk.emoji || "😀", fmt);
    if (!result.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${result.description}`);
    }
    return send(
      chatId,
      `${isEmojiPack ? "Емоджі" : "Наліпку"} додано ✅\n${setLink(st)}\n\nНадсилай ще або натисни /done, щоб завершити.`
    );
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

async function handleMedia(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.sticker) return importSticker(msg, st);

  const picked = pickFile(msg, st.variant);
  if (!picked) {
    return send(
      chatId,
      st.variant === "video"
        ? "Для анімованих потрібне відео або GIF 🎞"
        : st.variant === "mixed" || st.variant === "adaptive"
        ? "Надішли картинку, відео або GIF 🖼🎞"
        : "Надішли картинку 🖼 (краще як файл, щоб зберегти прозорість)."
    );
  }
  const f = picked.file;
  const variant = picked.variant;

  if (f.file_size && f.file_size > 20 * 1024 * 1024) {
    return send(chatId, "Файл завеликий: Telegram дозволяє боту брати до 20 МБ 😕");
  }

  const found = (msg.caption || "").match(/\p{Extended_Pictographic}/u);
  const emoji = found ? found[0] : "😀";

  const isVid = variant === "video" || variant === "adaptive_video";
  const fx = fxOf(st);
  if (fx.grid !== "off") {
    return handleGrid(chatId, userId, st, f, variant, emoji, fx, isVid);
  }
  if (isVid) await send(chatId, "⏳ Обробляю відео...");

  try {
    const buf = await downloadFile(f.file_id);
    const file = await prepare(buf, st.kind, variant, fx);
    const result = await uploadToSet(
      userId,
      st,
      file,
      emoji,
      isVid ? "video" : "static"
    );

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

// ---------- Нарізка на частини ----------
function parseGrid(g) {
  const [cols, rows] = String(g).split("x").map(Number);
  return { cols: cols || 1, rows: rows || 1 };
}

async function gridImageFiles(buf, kind, variant, fx) {
  const { cols, rows } = parseGrid(fx.grid);
  const S = kind === "emoji" ? 100 : 512;
  const big = await sharp(buf)
    .rotate()
    .resize(cols * S, rows * S, { fit: "cover" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const mode =
    variant === "adaptive" ? ((await hasTransparency(buf)) ? "alpha" : "luma") : null;

  const files = [];
  for (let idx = 0; idx < cols * rows; idx++) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const cell = await sharp(big)
      .extract({ left: c * S, top: r * S, width: S, height: S })
      .png()
      .toBuffer();
    if (kind === "emoji") {
      const out =
        variant === "adaptive" ? await toAdaptive(cell, { mode, invert: fx.invert }) : cell;
      files.push({ buffer: out, mime: "image/png", filename: "emoji.png" });
    } else {
      let out;
      for (const q of [90, 75, 60, 40]) {
        out = await sharp(cell).webp({ quality: q }).toBuffer();
        if (out.length <= 500 * 1024) break;
      }
      files.push({ buffer: out, mime: "image/webp", filename: "sticker.webp" });
    }
  }
  return files;
}

async function handleGrid(chatId, userId, st, f, variant, emoji, fx, isVid) {
  const { cols, rows } = parseGrid(fx.grid);
  const total = cols * rows;
  if (isVid && total > 9) {
    return send(
      chatId,
      "Для відео нарізка можлива максимум 3×3, щоб не перевантажувати сервер. Зміни розмір у /effects."
    );
  }
  await send(chatId, `⏳ Нарізаю на ${total} частин...`);

  try {
    const buf = await downloadFile(f.file_id);
    const deadline = Date.now() + 48000;
    const cells = isVid ? null : await gridImageFiles(buf, st.kind, variant, fx);
    let added = 0;
    let failed = 0;
    let done = 0;
    let lastErr = "";

    for (let idx = 0; idx < total; idx++) {
      if (Date.now() > deadline) break;
      done++;
      try {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const file = isVid
          ? {
              buffer: await toWebm(buf, st.kind === "emoji", variant === "adaptive_video", fx, {
                crop: { cols, rows, c, r },
              }),
              mime: "video/webm",
              filename: "sticker.webm",
            }
          : cells[idx];
        const result = await uploadToSet(userId, st, file, emoji, isVid ? "video" : "static");
        if (result.ok) added++;
        else {
          failed++;
          lastErr = result.description;
        }
      } catch (e) {
        failed++;
        lastErr = e.message;
      }
    }

    return send(
      chatId,
      `Готово! ✅ Додано ${added} із ${total}\n${setLink(st)}` +
        (done < total ? `\nНе вистачило часу на останні ${total - done} частин.` : "") +
        (failed ? `\n(${failed} не вдалося: ${lastErr})` : "") +
        "\n\nНадсилай ще або натисни /done."
    );
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

// ---------- Головна логіка ----------
function packKeyboard(ts) {
  return {
    inline_keyboard: [
      [
        { text: "➕ Додати", callback_data: `pa:${ts}` },
        { text: "✏️ Перейменувати", callback_data: `pr:${ts}` },
      ],
      [
        { text: "🙂 Змінити емоджі", callback_data: `pe:${ts}` },
        { text: "↕️ Змінити порядок", callback_data: `po:${ts}` },
      ],
      [
        { text: "🖼 Мініатюра", callback_data: `pt:${ts}` },
        { text: "🔎 Ключові слова", callback_data: `pk:${ts}` },
      ],
      [
        { text: "📦 Перемістити елемент", callback_data: `pv:${ts}` },
        { text: "💾 Резервна копія", callback_data: `pb:${ts}` },
      ],
      [
        { text: "➖ Видалити елемент", callback_data: `px:${ts}` },
        { text: "🗑 Видалити набір", callback_data: `pd:${ts}` },
      ],
      [{ text: "⬅️ До списку", callback_data: "my:list" }],
    ],
  };
}

async function showMyPacks(chatId, userId) {
  const rows = await listPacks(userId);
  if (rows === null) {
    return send(
      chatId,
      "Не вдалося прочитати список 😕 Перевір, чи створена таблиця packs у Supabase."
    );
  }

  const checked = await Promise.all(
    rows.map(async (row) => {
      const r = await tg("getStickerSet", { name: row.pack_name });
      return { row, set: r.ok ? r.result : null, desc: r.description || "" };
    })
  );

  const alive = [];
  for (const c of checked) {
    if (c.set) {
      alive.push(c);
    } else if (
      /STICKERSET_INVALID|not found/i.test(c.desc) &&
      Date.now() - new Date(c.row.created_at).getTime() > 24 * 3600 * 1000
    ) {
      await deletePackRow(c.row.pack_name); // набір давно видалений
    }
  }

  if (!alive.length) {
    return send(
      chatId,
      "У тебе ще немає наборів, створених через цього бота.",
      MAIN_MENU
    );
  }

  const lines = alive.map((c, i) => {
    const label = LABELS[`${c.row.kind}:${c.row.variant}`] || "";
    return `${i + 1}. ${c.set.title} — ${c.set.stickers.length} шт.${label ? " · " + label : ""}`;
  });
  const keyboard = {
    inline_keyboard: alive.map((c, i) => [
      {
        text: `${i + 1}. ${(c.set.title || "").slice(0, 30)}`,
        callback_data: `pm:${tsOf(c.row.pack_name)}`,
      },
    ]),
  };
  return send(chatId, "📚 Твої набори:\n\n" + lines.join("\n") + "\n\nОбери набір, щоб ним керувати.", keyboard);
}

async function packAction(action, ts, chatId, userId) {
  const name = makePackName(ts, userId);
  const row = await getPackRow(userId, name);
  if (!row) return send(chatId, "Набір не знайдено 🤷 Відкрий /mypacks ще раз.");
  const link = setLink({ kind: row.kind, pack_name: name });

  if (["pe", "po", "pt", "pk", "pv", "pb", "pdb"].includes(action)) {
    return packExtra(action, ts, row, name, chatId, userId);
  }

  if (action === "pm") {
    const r = await tg("getStickerSet", { name });
    if (!r.ok) return send(chatId, "Цього набору вже немає в Telegram.");
    return send(
      chatId,
      `«${r.result.title}» — ${r.result.stickers.length} шт.\n${link}`,
      packKeyboard(ts)
    );
  }

  if (action === "pa") {
    const variant = row.variant || "mixed";
    await saveState(userId, {
      kind: row.kind,
      variant,
      title: row.title,
      pack_name: name,
      step: "ready",
    });
    return send(
      chatId,
      `Додаємо в «${row.title}» ✅\n\n` +
        (WHAT_TO_SEND[`${row.kind}:${variant}`] ||
          "Надсилай файли або пересилай готові наліпки.") +
        "\n\nЩоб закінчити, натисни /done."
    );
  }

  if (action === "pr") {
    await saveState(userId, { kind: row.kind, title: row.title, pack_name: name, step: "rename" });
    return send(chatId, `Напиши нову назву для «${row.title}» (до 64 символів).`);
  }

  if (action === "px") {
    await saveState(userId, { kind: row.kind, title: row.title, pack_name: name, step: "remove" });
    return send(
      chatId,
      `Перешли мені наліпку (або емоджі) з набору «${row.title}», яку треба видалити.\nЩоб закінчити, натисни /done.`
    );
  }

  if (action === "pd") {
    return send(chatId, `Точно видалити набір «${row.title}»? Це незворотно.`, {
      inline_keyboard: [
        [
          { text: "Так, видалити", callback_data: `pdy:${ts}` },
          { text: "Скасувати", callback_data: `pm:${ts}` },
        ],
        [{ text: "💾 Зробити копію й видалити", callback_data: `pdb:${ts}` }],
      ],
    });
  }

  if (action === "pdy") {
    const res = await tg("deleteStickerSet", { name });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    await deletePackRow(name);
    await saveState(userId, { step: null, pack_name: null });
    return send(chatId, "Набір видалено 🗑", MAIN_MENU);
  }
}

async function startClone(chatId, userId) {
  await saveState(userId, { step: "clone" });
  return send(
    chatId,
    "Надішли мені будь-яку наліпку (або кастомне емоджі) з набору, який хочеш скопіювати.\n\n" +
      "Я зроблю його копію, яку зможу редагувати: додавати, видаляти, перейменовувати. " +
      "Telegram не дозволяє ботам змінювати набори, створені не ними, тому потрібна копія. " +
      "Користуйся цим для своїх наборів."
  );
}

// Копіює весь набір в новий, який належить боту
async function cloneSet(msg, st) {
  const sk = msg.sticker;
  if (!sk.set_name) {
    return send(
      msg.chat.id,
      "Ця наліпка не належить жодному набору. Надішли наліпку з набору, який хочеш скопіювати."
    );
  }
  return cloneByName(msg.chat.id, msg.from.id, sk.set_name);
}

// opts.fresh: завжди нова копія; opts.suffix: приписка до назви. Повертає { complete, name }
async function cloneByName(chatId, userId, setName, opts = {}) {
  const srcRes = await tg("getStickerSet", { name: setName });
  if (!srcRes.ok) {
    return send(chatId, `Не вдалося відкрити набір 😕\n${srcRes.description}`);
  }
  const src = srcRes.result;
  if (src.sticker_type === "mask") {
    return send(chatId, "Маскові набори бот не підтримує 🙂");
  }

  const isEmoji = src.sticker_type === "custom_emoji";
  const kind = isEmoji ? "emoji" : "sticker";
  const items = src.stickers;
  const toInput = (x) => ({
    sticker: x.file_id,
    format: x.is_video ? "video" : x.is_animated ? "animated" : "static",
    emoji_list: [x.emoji || "😀"],
  });

  // Можливо, цей набір уже копіювали і треба продовжити
  let name = null;
  let title = null;
  let i = 0;
  const prev = opts.fresh ? null : await findCloneRow(userId, src.name);
  if (prev) {
    const cur = await tg("getStickerSet", { name: prev.pack_name });
    if (cur.ok) {
      name = prev.pack_name;
      title = prev.title;
      i = cur.result.stickers.length;
    }
  }
  if (name && i >= items.length) {
    return send(
      chatId,
      `Цей набір уже повністю скопійовано ✅\n${setLink({ kind, pack_name: name })}\n\n` +
        "Щоб зробити нову копію, спершу видали стару в /mypacks."
    );
  }

  await send(chatId, `⏳ Копіюю «${src.title}» (${items.length} шт.)...`);
  const deadline = Date.now() + 45000;
  let failed = 0;

  if (!name) {
    name = makePackName(Date.now().toString(36), userId);
    title = `${src.title} (${opts.suffix || "копія"})`.slice(0, 64);
    const body = {
      user_id: userId,
      name,
      title,
      stickers: [toInput(items[0])],
      sticker_type: isEmoji ? "custom_emoji" : "regular",
    };
    if (isEmoji && items[0].needs_repainting) body.needs_repainting = true;
    const created = await tg("createNewStickerSet", body);
    if (!created.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${created.description}`);
    }
    await recordPack({
      pack_name: name,
      user_id: userId,
      title,
      kind,
      variant: "mixed",
      source_set: src.name,
    });
    i = 1;
  }

  for (; i < items.length; i++) {
    if (Date.now() > deadline) break;
    const r = await tg("addStickerToSet", { user_id: userId, name, sticker: toInput(items[i]) });
    if (!r.ok) {
      failed++;
      console.error("clone add failed:", r.description);
    }
  }

  const link = setLink({ kind, pack_name: name });
  if (i < items.length) {
    await send(
      chatId,
      `Скопійовано ${i - failed} із ${items.length}, а далі не вистачило часу.\n${link}\n\n` +
        (opts.fresh
          ? "Набір завеликий для одного разу, тому копія неповна."
          : "Надішли наліпку з того ж набору ще раз, щоб продовжити.")
    );
    return { complete: false, name };
  }

  if (!opts.fresh) {
    await saveState(userId, { kind, variant: "mixed", title, pack_name: name, step: "ready" });
  }
  await send(
    chatId,
    `Готово! ✅ Скопійовано ${items.length - failed} із ${items.length}.\n${link}\n\n` +
      (opts.fresh
        ? "Це окремий набір-копія, його видно в /mypacks."
        : "Тепер можна додавати сюди нові наліпки або керувати набором через /mypacks.") +
      (failed ? `\n(${failed} не вдалося скопіювати)` : "")
  );
  return { complete: failed === 0, name };
}

// ---------- Меню ефектів ----------
const FX_SPEEDS = [0.5, 1, 1.5, 2];
const FX_STARTS = [0, 1, 2, 3, 5, 10];
const FX_GRIDS = ["off", "2x2", "3x2", "2x3", "3x3", "4x4"];
const FX_SHAPES = ["none", "circle", "rounded"];
const SHAPE_LABEL = { none: "звичайна", circle: "коло", rounded: "заокруглена" };
const nextOf = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];

function fxKeyboard(fx) {
  const t = (v) => (v ? "✅" : "▫️");
  return {
    inline_keyboard: [
      [
        { text: `${t(fx.outline)} Біла обводка`, callback_data: "fx:outline" },
        { text: `${t(fx.removeBg)} Прибрати фон`, callback_data: "fx:removeBg" },
      ],
      [
        { text: `${t(fx.trim)} Автообрізка`, callback_data: "fx:trim" },
        { text: `🔷 Форма: ${SHAPE_LABEL[fx.shape]}`, callback_data: "fx:shape" },
      ],
      [
        { text: `⏱ Швидкість: ${fx.speed}×`, callback_data: "fx:speed" },
        { text: `${t(fx.reverse)} Реверс`, callback_data: "fx:reverse" },
      ],
      [
        { text: `▶️ Початок відео: ${fx.start} с`, callback_data: "fx:start" },
        { text: `${t(fx.chroma)} Зелений фон`, callback_data: "fx:chroma" },
      ],
      [
        {
          text: `🧩 Нарізка: ${fx.grid === "off" ? "вимк." : fx.grid.replace("x", "×")}`,
          callback_data: "fx:grid",
        },
        {
          text: `🎨 Силует: ${fx.invert ? "світлий малюнок" : "темний малюнок"}`,
          callback_data: "fx:invert",
        },
      ],
      [
        { text: "♻️ Скинути все", callback_data: "fx:reset" },
        { text: "✅ Готово", callback_data: "fx:done" },
      ],
    ],
  };
}

const FX_TEXT =
  "🎛 Ефекти\n\n" +
  "Вони застосовуються до кожного нового файлу, який ти надсилаєш у набір.\n\n" +
  "Картинки: біла обводка, прибирання однотонного фону, автообрізка, форма (коло чи заокруглена).\n" +
  "Відео: швидкість, реверс, з якої секунди брати 3 секунди, зелений фон (хромакей).\n" +
  "Нарізка: одну велику картинку чи відео розрізає на частини (2×2, 3×3...) і додає всі в набір. У нарізці картинкові ефекти не діють.\n" +
  "Силует: для адаптивних емоджі без прозорості, чи малюнок темний, чи світлий.";

async function showFx(chatId, userId) {
  const fx = fxOf(await getState(userId));
  return send(chatId, FX_TEXT, fxKeyboard(fx));
}

async function handleFx(cq, key) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const messageId = cq.message.message_id;

  if (key === "menu") return showFx(chatId, userId);

  if (key === "done") {
    const fx = fxOf(await getState(userId));
    const on = [];
    if (fx.outline) on.push("обводка");
    if (fx.removeBg) on.push("прибрати фон");
    if (fx.trim) on.push("автообрізка");
    if (fx.shape !== "none") on.push(`форма: ${SHAPE_LABEL[fx.shape]}`);
    if (fx.speed !== 1) on.push(`швидкість ${fx.speed}×`);
    if (fx.reverse) on.push("реверс");
    if (fx.start) on.push(`початок з ${fx.start} с`);
    if (fx.chroma) on.push("зелений фон");
    if (fx.grid !== "off") on.push(`нарізка ${fx.grid.replace("x", "×")}`);
    if (fx.invert) on.push("світлий силует");
    return tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text:
        "✅ Ефекти збережено.\n" +
        (on.length ? `Зараз увімкнено: ${on.join(", ")}.` : "Зараз усі ефекти вимкнені.") +
        "\nЗмінити: /effects",
    });
  }

  const { opts, ok } = await patchOpts(userId, (o) => {
    const cur = { ...FX_DEFAULT, ...(o.fx || {}) };
    if (key === "reset") Object.assign(cur, FX_DEFAULT);
    else if (key === "shape") cur.shape = nextOf(FX_SHAPES, cur.shape);
    else if (key === "speed") cur.speed = nextOf(FX_SPEEDS, cur.speed);
    else if (key === "start") cur.start = nextOf(FX_STARTS, cur.start);
    else if (key === "grid") cur.grid = nextOf(FX_GRIDS, cur.grid);
    else if (key in FX_DEFAULT && typeof FX_DEFAULT[key] === "boolean") cur[key] = !cur[key];
    o.fx = cur;
    return o;
  });
  await tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: fxKeyboard({ ...FX_DEFAULT, ...opts.fx }),
  });
  if (!ok) {
    await send(
      chatId,
      "⚠️ Не вдалося зберегти ефекти в базі. Потрібна колонка opts у таблиці users (SQL з інструкції). Поки що ефекти можуть «забуватись»."
    );
  }
}

// ---------- Інструменти для готових наборів ----------
const stickerFormat = (sk) => (sk.is_video ? "video" : sk.is_animated ? "animated" : "static");
const TOOL_STEPS = [
  "emoji_pick", "emoji_set", "pos_pick", "pos_set", "kw_pick", "kw_set",
  "move_pick", "move_target", "thumb", "extract",
];
const PICK_NEXT = {
  emoji_pick: "emoji_set",
  pos_pick: "pos_set",
  kw_pick: "kw_set",
  move_pick: "move_target",
};
const EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;
const DONE_HINT = "Щоб закінчити, натисни /done.";

async function setTmp(userId, tmp) {
  await patchOpts(userId, (o) => {
    o.tmp = tmp;
    return o;
  });
}

async function packExtra(action, ts, row, name, chatId, userId) {
  const base = { kind: row.kind, title: row.title, pack_name: name };

  if (action === "pe") {
    await saveState(userId, { ...base, step: "emoji_pick" });
    return send(chatId, `Перешли мені наліпку (або емоджі) з набору «${row.title}», емоджі якої треба змінити.\n${DONE_HINT}`);
  }
  if (action === "po") {
    await saveState(userId, { ...base, step: "pos_pick" });
    return send(chatId, `Перешли мені наліпку з набору «${row.title}», яку треба перемістити на іншу позицію.\n${DONE_HINT}`);
  }
  if (action === "pk") {
    await saveState(userId, { ...base, step: "kw_pick" });
    return send(chatId, `Перешли мені наліпку з набору «${row.title}», до якої треба додати ключові слова для пошуку.\n${DONE_HINT}`);
  }
  if (action === "pv") {
    await saveState(userId, { ...base, step: "move_pick" });
    return send(chatId, `Перешли мені наліпку з набору «${row.title}», яку треба перемістити в інший твій набір.\n${DONE_HINT}`);
  }
  if (action === "pt") {
    await saveState(userId, { ...base, step: "thumb" });
    return send(
      chatId,
      `Надішли картинку, наліпку чи відео/GIF для мініатюри набору «${row.title}».\n` +
        "Краще квадратну картинку (мініатюра стане 100×100).\n" + DONE_HINT
    );
  }
  if (action === "pb") {
    return cloneByName(chatId, userId, name, { fresh: true, suffix: "резерв" });
  }
  if (action === "pdb") {
    const res = await cloneByName(chatId, userId, name, { fresh: true, suffix: "резерв" });
    if (!res || !res.complete) {
      return send(chatId, "Резервну копію не створено повністю, тому набір НЕ видалено.");
    }
    const del = await tg("deleteStickerSet", { name });
    if (!del.ok) return send(chatId, `Копію створено, але видалити набір не вдалося: ${del.description}`);
    await deletePackRow(name);
    await saveState(userId, { step: null, pack_name: null });
    return send(chatId, "Резервну копію збережено, а оригінал видалено 🗑", MAIN_MENU);
  }
}

// Кнопки з іншими наборами того ж типу
async function sendMoveTargets(chatId, userId, st) {
  const rows = ((await listPacks(userId)) || []).filter(
    (r) => r.kind === st.kind && r.pack_name !== st.pack_name
  );
  const alive = [];
  for (const row of rows) {
    const r = await tg("getStickerSet", { name: row.pack_name });
    if (r.ok) alive.push({ row, set: r.result });
  }
  if (!alive.length) {
    return send(
      chatId,
      "У тебе немає інших наборів такого ж типу. Створи новий: /newsticker або /newemoji.\n" + DONE_HINT
    );
  }
  return send(chatId, "Обери набір, куди перемістити:", {
    inline_keyboard: alive.map((a) => [
      {
        text: `${(a.set.title || "").slice(0, 30)} (${a.set.stickers.length})`,
        callback_data: `mt:${tsOf(a.row.pack_name)}`,
      },
    ]),
  });
}

async function moveTo(ts, chatId, userId) {
  const st = await getState(userId);
  const tmp = parseOpts(st).tmp;
  const targetName = makePackName(ts, userId);
  const row = await getPackRow(userId, targetName);
  if (st.step !== "move_target" || !tmp || !row || row.kind !== st.kind) {
    return send(chatId, "Спершу перешли наліпку, яку треба перемістити (меню набору → Перемістити елемент).");
  }
  try {
    const buf = await downloadFile(tmp.file_id);
    const file =
      tmp.format === "video"
        ? { buffer: buf, mime: "video/webm", filename: "sticker.webm" }
        : tmp.format === "animated"
        ? { buffer: buf, mime: "application/x-tgsticker", filename: "sticker.tgs" }
        : { buffer: buf, mime: "image/webp", filename: "sticker.webp" };

    // Спершу видаляємо з початкового набору (поки діє file_id), потім додаємо в новий
    const del = await tg("deleteStickerFromSet", { sticker: tmp.file_id });
    if (!del.ok) {
      return send(chatId, `Не вдалося видалити з початкового набору, нічого не змінено.\n${del.description}`);
    }
    const target = { kind: row.kind, variant: row.variant, title: row.title, pack_name: targetName };
    const add = await uploadToSet(userId, target, file, tmp.emoji || "😀", tmp.format);
    if (!add.ok) {
      // Повертаємо наліпку назад
      await uploadToSet(userId, { ...target, pack_name: st.pack_name, title: st.title }, file, tmp.emoji || "😀", tmp.format);
      return send(chatId, `Не вийшло додати в новий набір, наліпку повернуто назад.\n${add.description}`);
    }
    await saveState(userId, { step: "move_pick" });
    return send(chatId, `Переміщено в «${row.title}» ✅ Перешли ще одну наліпку.\n${DONE_HINT}`);
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

async function setThumb(msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sk = msg.sticker;
  const mime = msg.document?.mime_type || "";
  const isTgs = !!(sk && sk.is_animated);
  const isVideo = !!(
    msg.video || msg.animation || msg.video_note ||
    (msg.document && (mime.startsWith("video/") || mime === "image/gif")) ||
    (sk && sk.is_video)
  );
  const isImage = !!(
    msg.photo ||
    (msg.document && mime.startsWith("image/") && mime !== "image/gif") ||
    (sk && !sk.is_video && !sk.is_animated)
  );
  if (!isTgs && !isVideo && !isImage) {
    return send(chatId, `Надішли картинку, наліпку чи відео/GIF для мініатюри.\n${DONE_HINT}`);
  }
  const fileId = msg.photo
    ? msg.photo[msg.photo.length - 1].file_id
    : sk
    ? sk.file_id
    : (msg.video || msg.animation || msg.video_note || msg.document).file_id;

  try {
    const form = new FormData();
    form.append("user_id", String(userId));
    form.append("name", st.pack_name);
    if (isTgs) {
      form.append("format", "animated");
      form.append("thumbnail", fileId);
    } else {
      const buf = await downloadFile(fileId);
      if (isVideo) {
        const webm = await toWebm(buf, true, false, {}, { maxBytes: 32 * 1024 });
        form.append("format", "video");
        form.append("thumbnail", new Blob([webm], { type: "video/webm" }), "thumb.webm");
      } else {
        const png = await sharp(buf)
          .resize(100, 100, { fit: "contain", background: TRANSPARENT })
          .png()
          .toBuffer();
        form.append("format", "static");
        form.append("thumbnail", new Blob([png], { type: "image/png" }), "thumb.png");
      }
    }
    const res = await tgForm("setStickerSetThumbnail", form);
    if (!res.ok) return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    await saveState(userId, { step: null });
    return send(chatId, "✅ Мініатюру встановлено. Telegram може показати її не одразу.");
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

// ---------- Витягнути файл з наліпки ----------
async function startExtract(chatId, userId) {
  await saveState(userId, { step: "extract" });
  return send(
    chatId,
    "Перешли мені будь-яку наліпку чи кастомне емоджі, і я надішлю її як файл: PNG для звичайних, GIF і WEBM для відео, TGS для анімованих.\n" + DONE_HINT
  );
}

async function sendDocument(chatId, buf, filename, mime, caption) {
  const f = new FormData();
  f.append("chat_id", String(chatId));
  f.append("document", new Blob([buf], { type: mime }), filename);
  if (caption) f.append("caption", caption);
  return tgForm("sendDocument", f);
}

async function extractSticker(chatId, sk) {
  try {
    const buf = await downloadFile(sk.file_id);
    if (sk.is_animated) {
      await sendDocument(chatId, buf, "sticker.tgs", "application/gzip", "Анімована наліпка (TGS)");
    } else if (sk.is_video) {
      await sendDocument(chatId, buf, "sticker.webm", "video/webm", "Відео-наліпка (WEBM)");
      const gif = await webmToGif(buf);
      await sendDocument(chatId, gif, "sticker.gif", "image/gif", "GIF-версія");
    } else {
      const png = await sharp(buf).png().toBuffer();
      await sendDocument(chatId, png, "sticker.png", "image/png", "Наліпка як PNG");
    }
    return send(chatId, `Готово ✅ Перешли ще одну або натисни /done.`);
  } catch (e) {
    console.error(e);
    return send(chatId, `Не вийшло 😕\n${e.message}`);
  }
}

// ---------- Кроки діалогів з інструментами ----------
async function handleToolStep(msg, st, text) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sk = msg.sticker;

  if (st.step === "extract") {
    if (!sk) return send(chatId, `Перешли мені саме наліпку чи емоджі.\n${DONE_HINT}`);
    return extractSticker(chatId, sk);
  }
  if (st.step === "thumb") return setThumb(msg, st);

  // Вибір наліпки з набору
  if (PICK_NEXT[st.step]) {
    if (!sk) return send(chatId, `Перешли мені наліпку (або емоджі) з вибраного набору.\n${DONE_HINT}`);
    if (sk.set_name !== st.pack_name) {
      return send(chatId, "Ця наліпка з іншого набору. Перешли наліпку з вибраного набору.");
    }
    await setTmp(userId, { file_id: sk.file_id, format: stickerFormat(sk), emoji: sk.emoji || "😀" });
    await saveState(userId, { step: PICK_NEXT[st.step] });
    if (st.step === "emoji_pick") {
      return send(chatId, "Надішли нові емоджі для цієї наліпки (до 20 штук в одному повідомленні).");
    }
    if (st.step === "kw_pick") {
      return send(chatId, "Напиши ключові слова через кому (до 20 слів, разом не більше 64 символів). За ними наліпку знаходитимуть у пошуку.");
    }
    if (st.step === "pos_pick") {
      const info = await tg("getStickerSet", { name: st.pack_name });
      const n = info.ok ? info.result.stickers.length : "?";
      return send(chatId, `На яку позицію перемістити? Напиши число від 1 до ${n}.`);
    }
    return sendMoveTargets(chatId, userId, st);
  }

  if (st.step === "move_target") {
    return send(chatId, "Обери набір кнопкою вище 👆");
  }

  const tmp = parseOpts(st).tmp;
  if (!tmp) {
    await saveState(userId, { step: null });
    return send(chatId, "Щось пішло не так, спробуй ще раз з меню набору (/mypacks).");
  }

  if (st.step === "emoji_set") {
    const list = (text.match(EMOJI_RE) || []).slice(0, 20);
    if (!list.length) return send(chatId, "Надішли хоча б одне емоджі 🙂");
    const res = await tg("setStickerEmojiList", { sticker: tmp.file_id, emoji_list: list });
    if (!res.ok) return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    await saveState(userId, { step: "emoji_pick" });
    return send(chatId, `Готово ✅ Тепер до наліпки прив'язано: ${list.join(" ")}\nПерешли ще одну наліпку.\n${DONE_HINT}`);
  }

  if (st.step === "pos_set") {
    const info = await tg("getStickerSet", { name: st.pack_name });
    const count = info.ok ? info.result.stickers.length : 0;
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 1 || n > count) {
      return send(chatId, `Напиши число від 1 до ${count}.`);
    }
    const res = await tg("setStickerPositionInSet", { sticker: tmp.file_id, position: n - 1 });
    if (!res.ok) return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    await saveState(userId, { step: "pos_pick" });
    return send(chatId, `Готово ✅ Наліпку переміщено на позицію ${n}.\nПерешли ще одну.\n${DONE_HINT}`);
  }

  if (st.step === "kw_set") {
    const words = text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    const total = words.reduce((sum, w) => sum + w.length, 0);
    if (!words.length || total > 64) {
      return send(chatId, "Напиши від 1 до 20 слів через кому, разом не більше 64 символів.");
    }
    const res = await tg("setStickerKeywords", { sticker: tmp.file_id, keywords: words });
    if (!res.ok) return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    await saveState(userId, { step: "kw_pick" });
    return send(chatId, `Готово ✅ Ключові слова: ${words.join(", ")}\nПерешли ще одну наліпку.\n${DONE_HINT}`);
  }
}

async function handleCallback(cq) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const [a, kind, variant] = (cq.data || "").split(":");

  if (a === "my") return showMyPacks(chatId, userId);
  if (a === "cl") return startClone(chatId, userId);
  if (a === "fx") return handleFx(cq, kind);
  if (a === "ex") return startExtract(chatId, userId);
  if (a === "mt") return moveTo(kind, chatId, userId);
  if (["pm", "pa", "pr", "px", "pd", "pdy", "pe", "po", "pt", "pk", "pv", "pb", "pdb"].includes(a)) {
    return packAction(a, kind, chatId, userId);
  }

  if (a === "new") {
    if (kind === "sticker") return beginPack(chatId, userId, "sticker", "mixed");
    return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
  }

  if (a === "t" && LABELS[`${kind}:${variant}`]) {
    return beginPack(chatId, userId, kind, variant);
  }
}

async function beginPack(chatId, userId, kind, variant) {
  const saved = await saveState(userId, {
    kind,
    variant,
    step: "title",
    title: null,
    pack_name: null,
  });
  await send(
    chatId,
    (kind === "sticker"
      ? "Створюємо стікер-пак ✅"
      : `Обрано: ${LABELS[`${kind}:${variant}`]} ✅`) +
      "\n\nТепер напиши назву набору (до 64 символів)."
  );
  if (!saved) {
    await send(
      chatId,
      "⚠️ База даних не відповідає, тому бот може «забути» твій вибір. Адміністратору: напиши /debug."
    );
  }
}

const ADMIN_HELP =
  "\n\nКоманди адміністратора:\n" +
  "/adduser 123456789 — дати доступ людині\n" +
  "/removeuser 123456789 — забрати доступ\n" +
  "/users — список людей з доступом\n" +
  "/debug — перевірка бази даних";

async function handleUpdate(update) {
  const cq = update.callback_query;
  const msg = update.message;
  const from = cq ? cq.from : msg && msg.from;
  if (!from) return;

  const userId = from.id;
  const chatId = cq ? cq.message.chat.id : msg.chat.id;
  const isAdmin = ADMIN_ID !== "" && String(userId) === ADMIN_ID;
  const text = msg ? (msg.text || "").trim() : "";
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";

  // /id працює для всіх: так людина дізнається свій ID
  if (cmd === "/id") return send(chatId, `Твій Telegram ID: ${userId}`);

  // Перевірка доступу
  if (!isAdmin && !(await isAllowed(userId))) {
    if (cq) await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return send(
      chatId,
      "🔒 Цей бот приватний.\n\n" +
        `Твій ID: ${userId}\n` +
        "Надішли його адміністратору, щоб отримати доступ."
    );
  }

  if (cq) return handleCallback(cq);
  if (!msg) return;

  // Команди
  if (cmd) {
    if (cmd === "/start") {
      return send(
        chatId,
        "Привіт! 👋 Я роблю наліпки та кастомні емоджі.\nЩо створюємо?",
        MAIN_MENU
      );
    }
    if (cmd === "/help") {
      return send(chatId, HELP_TEXT + (isAdmin ? ADMIN_HELP : ""), MAIN_MENU);
    }
    if (cmd === "/newsticker" || cmd === "/sticker") {
      return beginPack(chatId, userId, "sticker", "mixed");
    }
    if (cmd === "/newemoji" || cmd === "/emoji") {
      return send(chatId, "Які емоджі створюємо?", EMOJI_TYPES);
    }
    if (cmd === "/mypacks" || cmd === "/mysets") return showMyPacks(chatId, userId);
    if (cmd === "/clonepack") return startClone(chatId, userId);
    if (cmd === "/effects") return showFx(chatId, userId);
    if (cmd === "/extract") return startExtract(chatId, userId);
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

    // Команди адміністратора
    if (["/adduser", "/removeuser", "/users", "/debug"].includes(cmd)) {
      if (!isAdmin) return send(chatId, "Ця команда лише для адміністратора.");

      if (cmd === "/debug") return send(chatId, await debugSupabase(userId));

      if (cmd === "/users") {
        const ids = await listAllowed();
        if (!ids) {
          return send(
            chatId,
            "Не вдалося прочитати список. Перевір, чи створена таблиця allowed_users у Supabase."
          );
        }
        return send(
          chatId,
          ids.length
            ? `Люди з доступом (${ids.length}):\n` + ids.join("\n")
            : "Список порожній. Ти (адміністратор) маєш доступ завжди."
        );
      }

      const id = (text.split(/\s+/)[1] || "").trim();
      if (!/^\d{5,15}$/.test(id)) {
        return send(
          chatId,
          `Напиши так: ${cmd} 123456789\n(ID людина дізнається, надіславши боту /id)`
        );
      }

      if (cmd === "/adduser") {
        const res = await addAllowed(id);
        if (!res.ok) {
          return send(chatId, `Не вдалося записати в базу 😕\nПричина: ${res.info}`);
        }
        // Повідомляємо людину (спрацює, якщо вона вже натискала Start у боті)
        await send(Number(id), "✅ Тобі відкрито доступ до бота. Натисни /start");
        return send(chatId, `Додано: ${id} ✅`);
      }

      const res = await removeAllowed(id);
      return send(
        chatId,
        res.ok ? `Доступ забрано: ${id} ✅` : `Не вдалося видалити 😕\nПричина: ${res.info}`
      );
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
    const packName = makePackName(Date.now().toString(36), userId);
    await saveState(userId, { title: text, pack_name: packName, step: "ready" });
    await recordPack({
      pack_name: packName,
      user_id: userId,
      title: text,
      kind: st.kind,
      variant: st.variant,
    });
    return send(
      chatId,
      `Назва: «${text}» ✅\n\n${WHAT_TO_SEND[`${st.kind}:${st.variant}`]}\n\n` +
        "Щоб прив'язати своє емоджі, напиши його в підписі до файлу. Краще надсилай файли по одному." +
        (st.kind === "sticker"
          ? "\n\nМожна також переслати мені готові наліпки з інших наборів, і я додам їх сюди."
          : "\n\nМожна також переслати готові кастомні емоджі, і я додам їх сюди.")
    );
  }

  // Перейменування набору
  if (st.step === "rename") {
    if (!text) return send(chatId, "Напиши нову назву текстом ✍️");
    if (text.length > 64) {
      return send(chatId, "Назва задовга, максимум 64 символи. Спробуй коротше.");
    }
    const res = await tg("setStickerSetTitle", { name: st.pack_name, title: text });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    await updatePackRow(st.pack_name, { title: text });
    await saveState(userId, { step: null, title: text });
    return send(chatId, `Готово ✅ Нова назва: «${text}»`, MAIN_MENU);
  }

  // Видалення елемента з набору
  if (st.step === "remove") {
    const sk = msg.sticker;
    if (!sk) {
      return send(
        chatId,
        "Перешли мені наліпку (або емоджі) з цього набору, яку треба видалити. Щоб закінчити, натисни /done."
      );
    }
    if (sk.set_name !== st.pack_name) {
      return send(chatId, "Ця наліпка з іншого набору. Перешли наліпку з вибраного набору.");
    }
    const res = await tg("deleteStickerFromSet", { sticker: sk.file_id });
    if (!res.ok) {
      return send(chatId, `Не вийшло 😕\nПомилка Telegram: ${res.description}`);
    }
    return send(chatId, "Видалено ✅ Пересилай ще або натисни /done.");
  }

  // Копіювання старого набору
  if (st.step === "clone") {
    if (!msg.sticker) {
      return send(
        chatId,
        "Надішли саме наліпку (або кастомне емоджі) з набору, який треба скопіювати. Щоб скасувати, натисни /cancel."
      );
    }
    return cloneSet(msg, st);
  }

  // Інструменти для наборів (змінити емоджі, порядок, мініатюра, переміщення, витягнути файл)
  if (TOOL_STEPS.includes(st.step)) return handleToolStep(msg, st, text);

  // Готові приймати файли
  if (st.step === "ready" && st.kind && st.variant && st.pack_name) {
    return handleMedia(msg, st);
  }

  await send(chatId, "Спершу створи набір 👇", MAIN_MENU);
  if (isAdmin) {
    // Автоматична діагностика для адміністратора
    await send(
      chatId,
      "🔧 Діагностика (бачиш лише ти).\nЩо бот пам'ятає про тебе: " +
        JSON.stringify(st) +
        "\n\n" +
        (await debugSupabase(userId))
    );
  }
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
