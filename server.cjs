// server.cjs
// ✅ TikTok PFP fetch (Playwright) + fast cache + image proxy
// ✅ Railway-ready (PORT env + 0.0.0.0)
// ✅ Safer /proxy-image (validates URL, adds headers)
// ✅ /cash is safe: confirmUrl only (no scraping)

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/health", (req, res) => res.status(200).send("ok"));

function normalizeUrl(u) {
  if (!u) return null;
  let url = String(u).trim();
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function isAllowedProxyUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// --------------------
// ✅ In-memory cache (instant on repeat)
// --------------------
const tiktokCache = new Map(); // user -> { name, avatar, time }
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24h

function cacheGet(user) {
  const hit = tiktokCache.get(user);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    tiktokCache.delete(user);
    return null;
  }
  return hit;
}

function cacheSet(user, name, avatar) {
  tiktokCache.set(user, { name, avatar, time: Date.now() });
}

// --------------------
// ✅ Reuse ONE browser instance (big speed boost)
// --------------------
let browserInstance = null;
async function getBrowser() {
  if (browserInstance) return browserInstance;

  browserInstance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  return browserInstance;
}

// --------------------
// ✅ Proxy image so TikTok avatars display in browser
// --------------------
app.get("/proxy-image", async (req, res) => {
  try {
    let imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url");

    imageUrl = normalizeUrl(imageUrl);
    if (!imageUrl || !isAllowedProxyUrl(imageUrl)) {
      return res.status(400).send("Invalid url");
    }

    const r = await fetch(imageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        referer: "https://www.tiktok.com/",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) return res.status(502).send(`proxy failed: ${r.status}`);

    const contentType = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const arrayBuffer = await r.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("proxy-image error:", e);
    res.status(500).send("proxy error");
  }
});

// --------------------
// ✅ TikTok Fetch (reliable parsing)
// --------------------
function extractAvatarFromUniversalJson(obj) {
  const targets = new Set(["avatarLarger", "avatarMedium", "avatarThumb"]);
  const queue = [obj];

  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (targets.has(k) && typeof v === "string" && v.length > 10) return v;
        if (v && typeof v === "object") queue.push(v);
      }
    }
  }
  return null;
}

app.get("/tiktok", async (req, res) => {
  let user = (req.query.user || "").toString().trim();
  if (!user) return res.status(400).json({ error: "Missing user" });

  user = user.replace(/^@/, "").toLowerCase();

  // ✅ instant on repeat
  const cached = cacheGet(user);
  if (cached) {
    return res.json({
      name: cached.name,
      avatar: cached.avatar,
      blocked: false,
      cached: true,
    });
  }

  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(user)}?lang=en`;

  let context;
  let page;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      locale: "en-US",
      viewport: { width: 900, height: 900 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);

    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });

    // Fast path: embedded JSON
    const universalText = await page
      .locator('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')
      .textContent()
      .catch(() => null);

    let avatar = null;

    if (universalText) {
      try {
        const json = JSON.parse(universalText);
        avatar = extractAvatarFromUniversalJson(json);
      } catch {}
    }

    // Fallback: og:image
    if (!avatar) {
      avatar = await page
        .locator('meta[property="og:image"]')
        .getAttribute("content")
        .catch(() => null);
    }

    if (avatar) {
      avatar = avatar
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");

      avatar = normalizeUrl(avatar);
      const proxied = avatar
        ? `/proxy-image?url=${encodeURIComponent(avatar)}`
        : null;

      cacheSet(user, user, proxied);

      return res.json({
        name: user,
        avatar: proxied,
        blocked: false,
        cached: false,
      });
    }

    return res.json({ name: user, avatar: null, blocked: true });
  } catch (e) {
    console.error("tiktok error:", e);
    return res.status(500).json({ error: "TikTok fetch failed", details: String(e) });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

// --------------------
// ✅ Cash (safe): confirm link only (no scraping)
// --------------------
app.get("/cash", (req, res) => {
  let tag = (req.query.tag || "").toString().trim();
  if (!tag) return res.status(400).json({ error: "Missing tag" });

  if (!tag.startsWith("$")) tag = "$" + tag;

  res.json({
    cashtag: tag,
    name: tag.replace(/^\$/, ""),
    avatar: null,
    confirmUrl: `https://cash.app/${encodeURIComponent(tag)}`,
  });
});

// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
