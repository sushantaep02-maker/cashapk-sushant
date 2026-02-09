const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

// Helper: build a proxy URL that your existing contact-pay.html can load in <img src="...">
function asProxy(url) {
  if (!url) return null;
  return `http://localhost:3000/proxy-image?url=${encodeURIComponent(url)}`;
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
  const { user } = req.query;
  if (!user) return res.status(400).json({ error: "Missing user" });

  const handle = user.startsWith("@") ? user.slice(1) : user;

  // 1) Try profile page -> SIGI_STATE -> userInfo.user.avatarLarger/avatarMedium
  try {
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    const page = await axios.get(profileUrl, {
      headers: HEADERS,
      timeout: 15000,
      // TikTok sometimes redirects or gives non-200 for bot checks; we still may get HTML we can parse
      validateStatus: (s) => s >= 200 && s < 500,
    });

    const html = page.data || "";
    // Extract JSON from <script id="SIGI_STATE" type="application/json">...</script>
    const m = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>(.*?)<\/script>/s);
    if (m && m[1]) {
      let state;
      try {
        state = JSON.parse(m[1]);
      } catch (_) {
        state = null;
      }

      const u =
        state?.UserModule?.users?.[handle] ||
        // sometimes the key is lowercase/normalized; try to find first match
        (state?.UserModule?.users ? Object.values(state.UserModule.users)[0] : null);

      const avatar =
        u?.avatarLarger ||
        u?.avatarMedium ||
        u?.avatarThumb ||
        state?.userInfo?.user?.avatarLarger ||
        state?.userInfo?.user?.avatarMedium ||
        state?.userInfo?.user?.avatarThumb;

      const name =
        u?.nickname ||
        state?.userInfo?.user?.nickname ||
        `@${handle}`;

      if (avatar && typeof avatar === "string") {
        return res.json({
          name,
          avatar: asProxy(avatar),
        });
      }
    }
  } catch (_) {
    // ignore and fallback
  }

  // 2) Fallback: oEmbed
  try {
    const oembed = await axios.get(
      `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${encodeURIComponent(handle)}`,
      { headers: HEADERS, timeout: 15000 }
    );
    return res.json({
      name: oembed.data?.author_name || `@${handle}`,
      avatar: asProxy(oembed.data?.thumbnail_url),
    });
  } catch (e) {
    return res.status(404).json({ error: "Not found" });
  }
});

app.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
