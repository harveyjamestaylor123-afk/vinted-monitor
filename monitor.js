import { chromium } from "playwright";
import fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL = 15000;

const VINTED_URL =
  "https://www.vinted.co.uk/catalog?search_text=drakes&brand_ids[]=389025&order=newest_first";

const SEEN_FILE = "/tmp/seen.json";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing Telegram environment variables");
  process.exit(1);
}

let seen = new Set();

try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(
      JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))
    );
  }
} catch (err) {
  console.log("Could not load seen file.");
}

function saveSeen() {
  try {
    fs.writeFileSync(
      SEEN_FILE,
      JSON.stringify([...seen])
    );
  } catch (err) {
    console.error("Could not save seen file:", err.message);
  }
}

async function sendTelegram(item) {
  const itemUrl = item.url.startsWith("http")
    ? item.url
    : `https://www.vinted.co.uk${item.url}`;

  const price =
    item.price?.amount
      ? `${item.price.amount} ${item.price.currency_code || "GBP"}`
      : "Unknown";

  const text =
`🚨 <b>NEW DRAKE'S LISTING</b>

<b>${escapeHtml(item.title || "Drake's item")}</b>

💷 ${escapeHtml(price)}

<a href="${itemUrl}">OPEN ON VINTED</a>`;

  const photo =
    item.photo?.url ||
    item.photo?.full_size_url ||
    item.photos?.[0]?.url;

  if (photo) {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          photo,
          caption: text,
          parse_mode: "HTML"
        })
      }
    );

    if (response.ok) return;
  }

  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
    }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function main() {
  console.log("🚀 Starting Vinted Drake's monitor");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    locale: "en-GB",

    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",

    extraHTTPHeaders: {
      "Accept-Language": "en-GB,en;q=0.9"
    }
  });

  const page = await context.newPage();

  console.log("Opening Vinted...");

  await page.goto(
    "https://www.vinted.co.uk/",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  console.log("Initial Vinted page opened.");

  await page.waitForTimeout(3000);

  let firstRun = true;

  while (true) {
    try {
      console.log("Checking Drake's...");

      await page.goto(
        `${VINTED_URL}&time=${Date.now()}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60000
        }
      );

      await page.waitForTimeout(3000);

      /*
       * Make the API request INSIDE the Vinted browser.
       *
       * This means the request inherits the cookies/session
       * established by Chromium.
       */
      const result = await page.evaluate(async () => {
        const params = new URLSearchParams();

        params.set("page", "1");
        params.set("per_page", "96");
        params.set(
          "time",
          String(Math.floor(Date.now() / 1000))
        );

        params.set("search_text", "drakes");
        params.set("order", "newest_first");

        /*
         * Drake's Vinted brand ID.
         */
        params.set(
          "attribute_ids[brand]",
          "389025"
        );

        const response = await fetch(
          `https://www.vinted.co.uk/api/v2/catalog/items?${params.toString()}`,
          {
            credentials: "include",
            headers: {
              "Accept": "application/json"
            }
          }
        );

        const text = await response.text();

        return {
          status: response.status,
          text
        };
      });

      console.log(
        `Browser API HTTP ${result.status}`
      );

      if (result.status !== 200) {
        console.error(
          `❌ Vinted returned ${result.status}`
        );

        await new Promise(resolve =>
          setTimeout(resolve, 60000)
        );

        continue;
      }

      let data;

      try {
        data = JSON.parse(result.text);
      } catch {
        console.error(
          "❌ Could not parse Vinted response"
        );

        await new Promise(resolve =>
          setTimeout(resolve, 60000)
        );

        continue;
      }

      const rawItems =
        Array.isArray(data.items)
          ? data.items
          : [];

      /*
       * EXTRA FILTER.
       *
       * Even though we request brand ID 389025,
       * only allow listings whose title contains
       * Drake / Drake's / Drakes.
       */
      const items = rawItems.filter(item => {
        const title =
          String(item.title || "").toLowerCase();

        return (
          title.includes("drake") ||
          title.includes("drake's") ||
          title.includes("drakes")
        );
      });

      console.log(
        `Found ${items.length} Drake's listing(s).`
      );

      /*
       * First successful run becomes our baseline.
       * This prevents 96 existing listings suddenly
       * flooding Telegram.
       */
      if (firstRun && seen.size === 0) {
        for (const item of items) {
          seen.add(String(item.id));
        }

        saveSeen();

        firstRun = false;

        console.log(
          `✅ Baseline created with ${seen.size} listings.`
        );

      } else {

        firstRun = false;

        const newItems = items.filter(
          item => !seen.has(String(item.id))
        );

        if (newItems.length === 0) {
          console.log(
            "No new Drake's listings."
          );
        }

        for (const item of [...newItems].reverse()) {

          console.log(
            `🚨 NEW: ${item.title}`
          );

          await sendTelegram(item);

          seen.add(String(item.id));

          saveSeen();

          await new Promise(resolve =>
            setTimeout(resolve, 1000)
          );
        }
      }

    } catch (err) {

      console.error(
        "❌ Check failed:",
        err.message
      );

    }

    await new Promise(resolve =>
      setTimeout(resolve, CHECK_INTERVAL)
    );
  }
}

main().catch(err => {
  console.error(
    "❌ Fatal error:",
    err
  );

  process.exit(1);
});
