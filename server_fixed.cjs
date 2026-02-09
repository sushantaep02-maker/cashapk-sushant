

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());


const path = require("path");
app.use(express.static(process.cwd()));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "contact-pay.html"));
});

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

// Helper: build a proxy URL that your existing contact-pay.html can load in <img src="...">
function asProxy(url) {
  if (!url) return null;
  return `/proxy-image?url=${encodeURIComponent(url)}`;
}

/**
 * PROXY IMAGE
 * TikTok (and sometimes Cash) blocks direct hotlinking. This endpoint streams the bytes back
 * so the browser loads it as a first-party image from localhost.
 */
app.get("/proxy-image", async (req, res) => {
  const url = req.query.url;
  if (!url || url === "undefined") return res.status(400).send("No URL");

  const target = decodeURIComponent(url);

  // Safety: only allow http/https
  if (!/^https?:\/\//i.test(target)) return res.status(400).send("Bad URL");

  try {
    const response = await axios({
      url: target,
      method: "GET",
      responseType: "stream",
      maxRedirects: 5,
      timeout: 15000,
      headers: {
        ...HEADERS,
        // These two are what usually stop TikTok from serving a blank/blocked response
        Referer: "https://www.tiktok.com/",
        Origin: "https://www.tiktok.com",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const ct = response.headers["content-type"] || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    // Cache a bit so scrolling doesn't re-fetch constantly
    res.setHeader("Cache-Control", "public, max-age=3600");
    response.data.pipe(res);
  } catch (e) {
    res.status(404).send("Fetch Failed");
  }
});

app.get("/cash", async (req, res) => {
  const { tag } = req.query;
  try {
    const response = await axios.get(`https://cash.app/${tag}`, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(response.data);
    const name = $('meta[property="og:title"]')
      .attr("content")
      ?.replace("Pay ", "")
      ?.replace(" on Cash App", "");
    const rawImg = $('meta[property="og:image"]').attr("content");

    res.json({
      name: name || tag,
      // IMPORTANT: return proxy so your existing <img src="${contact.avatar}"> works
      avatar: asProxy(rawImg),
    });
  } catch (e) {
    res.status(404).json({ error: "Not found" });
  }
});

/**
 * TikTok PFP (REAL)
 * Your old method uses TikTok oEmbed thumbnail_url, which often returns the default green/blank avatar.
 * This tries to extract the real avatar from the profile page JSON (SIGI_STATE). If that fails, it
 * falls back to oEmbed.
 */
app.get("/tiktok", async (req, res) => {
  try {
    let user = req.query.user;
    if (!user) return res.status(400).json({ error: "Missing username" });

    user = user.replace(/^@/, "").trim();
    const url = `https://www.tiktok.com/@${user}?lang=en`;

    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://www.tiktok.com/",
      },
    });

    const html = await r.text();

    // ✅ Try to find avatar URL inside the page
    let avatar = null;

    // Method A: Look inside the big JSON script
    const scriptMatch = html.match(
      /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
    );

    if (scriptMatch) {
      const jsonText = scriptMatch[1].trim();
      const data = JSON.parse(jsonText);

      // Search avatar fields inside JSON text
      const str = JSON.stringify(data);
      const a =
        str.match(/"avatarLarger":"([^"]+)"/) ||
        str.match(/"avatarMedium":"([^"]+)"/) ||
        str.match(/"avatarThumb":"([^"]+)"/);

      if (a) avatar = a[1];
    }

    // Method B (fallback): search avatar directly in HTML
    if (!avatar) {
      const a =
        html.match(/"avatarLarger":"([^"]+)"/) ||
        html.match(/"avatarMedium":"([^"]+)"/) ||
        html.match(/"avatarThumb":"([^"]+)"/);

      if (a) avatar = a[1];
    }

    // Clean up escaped characters
    if (avatar) {
      avatar = avatar
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");
    }

    // If still null, TikTok likely blocked scraping
    if (!avatar) return res.json({ name: user, avatar: null, blocked: true });

    // ✅ Return proxied image URL so browser can load it
    const proxied = `/proxy-image?url=${encodeURIComponent(avatar)}`;

    res.json({ name: user, avatar: proxied });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch TikTok profile" });
  }
});
