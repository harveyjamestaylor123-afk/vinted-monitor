import { chromium } from "playwright";
import fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_SECONDS =
  Number(process.env.CHECK_INTERVAL_SECONDS || "10");

const DRAKES_BRAND_ID = "389025";

const SEEN_FILE = "/tmp/vinted_drakes_seen.json";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing Telegram environment variables");
  process.exit(1);
}

let seen = new Set();

try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(
      JSON.parse(
        fs.readFileSync(SEEN_FILE, "utf8")
      )
    );
  }
} catch (error) {
  console.log(
    "Could not load seen file:",
    error.message
  );
}

function saveSeen() {
  try {
    fs.writeFileSync(
      SEEN_FILE,
      JSON.stringify([...seen])
    );
  } catch (error) {
    console.error(
      "Could not save seen file:",
      error.message
    );
  }
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function telegramRequest(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram ${data.error_code}: ${data.description}`
    );
  }

  return data;
}

function getPhoto(item) {
  return (
    item.photo?.url ||
    item.photo?.full_size_url ||
    item.photos?.[0]?.url ||
    item.photos?.[0]?.full_size_url ||
    ""
  );
}

async function sendTelegram(item) {
  const relativeUrl =
    item.url ||
    `/items/${item.id}`;

  const itemUrl =
    relativeUrl.startsWith("http")
      ? relativeUrl
      : `https://www.vinted.co.uk${relativeUrl}`;

  const price =
    item.price?.amount
      ? `£${item.price.amount}`
      : "";

  const totalPrice =
    item.total_item_price?.amount
      ? `£${item.total_item_price.amount}`
      : "";

  const seller =
    item.user?.login || "";

  const message = [
    "🚨 <b>NEW DRAKE'S LISTING</b>",
    "",
    `<b>${escapeHtml(
      item.title || "New Drake's listing"
    )}</b>`,
    "",
    price
      ? `💷 <b>Price:</b> ${escapeHtml(price)}`
      : "",
    totalPrice && totalPrice !== price
      ? `🛍 <b>Total:</b> ${escapeHtml(totalPrice)}`
      : "",
    seller
      ? `👤 <b>Seller:</b> ${escapeHtml(seller)}`
      : "",
    "",
    `<a href="${itemUrl}">OPEN ON VINTED</a>`
  ]
    .filter(Boolean)
    .join("\n");

  const photo = getPhoto(item);

  if (photo) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id: CHAT_ID,
          photo,
          caption: message,
          parse_mode: "HTML"
        }
      );

      return;
    } catch (error) {
      console.log(
        "Photo failed, sending text:",
        error.message
      );
    }
  }

  await telegramRequest(
    "sendMessage",
    {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false
    }
  );
}

async function fetchDrakes(page) {
  return await page.evaluate(
    async brandId => {
      const params =
        new URLSearchParams();

      params.set("page", "1");
      params.set("per_page", "96");

      params.set(
        "time",
        String(
          Math.floor(Date.now() / 1000)
        )
      );

      /*
       * This is the exact endpoint and
       * brand-filter format observed in
       * Vinted's own Network request.
       */
      params.set(
        "attribute_ids[brand]",
        brandId
      );

      params.set(
        "attribute_ids[catalog]",
        ""
      );

      params.set(
        "attribute_ids[size]",
        ""
      );

      params.set(
        "attribute_ids[status]",
        ""
      );

      params.set(
        "attribute_ids[color]",
        ""
      );

      params.set(
        "attribute_ids[material]",
        ""
      );

      params.set(
        "order",
        "newest_first"
      );

      const url =
        "https://api.vinted.co.uk/svc-catalogue/items?" +
        params.toString();

      const response =
        await fetch(
          url,
          {
            credentials: "include",
            headers: {
              Accept:
                "application/json, text/plain, */*"
            }
          }
        );

      const text =
        await response.text();

      return {
        status: response.status,
        text,
        url
      };
    },
    DRAKES_BRAND_ID
  );
}

async function main() {
  console.log(
    "🚀 Starting Drake's-only Vinted monitor"
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  const browser =
    await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

  const context =
    await browser.newContext({
      locale: "en-GB",

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36",

      extraHTTPHeaders: {
        "Accept-Language":
          "en-GB,en;q=0.9"
      }
    });

  const page =
    await context.newPage();

  console.log(
    "Opening Vinted session..."
  );

  await page.goto(
    "https://www.vinted.co.uk/catalog?brand_ids[]=389025",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  await page.waitForTimeout(3000);

  console.log(
    "✅ Vinted browser session ready."
  );

  let baselineDone =
    seen.size > 0;

  let errors = 0;

  while (true) {
    try {
      console.log(
        "Checking Drake's..."
      );

      const result =
        await fetchDrakes(page);

      console.log(
        `Catalogue HTTP ${result.status}`
      );

      if (result.status !== 200) {
        throw new Error(
          `Vinted returned HTTP ${result.status}`
        );
      }

      const data =
        JSON.parse(result.text);

      if (!Array.isArray(data.items)) {
        throw new Error(
          "Vinted response contained no items array."
        );
      }

      const items =
        data.items.filter(
          item => item && item.id
        );

      console.log(
        `Drake's catalogue returned ${items.length} listing(s).`
      );

      /*
       * Establish the baseline after every fresh
       * deployment rather than sending everything.
       */
      if (!baselineDone) {
        for (const item of items) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen();

        baselineDone = true;

        console.log(
          `✅ Baseline created with ${seen.size} listings.`
        );
      }

      else {
        const newItems =
          items.filter(
            item =>
              !seen.has(
                String(item.id)
              )
          );

        /*
         * SAFETY LOCK:
         *
         * A real Drake's update might add one or a
         * handful of listings.
         *
         * If suddenly dozens appear, assume the
         * filter/API has gone wrong and DO NOT spam
         * Telegram.
         */
        if (newItems.length > 10) {
          console.error(
            `🛑 SAFETY LOCK: ${newItems.length} unseen items returned. No Telegram messages sent.`
          );

          console.error(
            "Possible Vinted filter failure."
          );
        }

        else if (newItems.length === 0) {
          console.log(
            "No new Drake's listings."
          );
        }

        else {
          console.log(
            `🚨 ${newItems.length} NEW Drake's listing(s).`
          );

          for (
            const item of [...newItems].reverse()
          ) {
            try {
              console.log(
                `🚨 NEW: ${item.title}`
              );

              await sendTelegram(item);

              seen.add(
                String(item.id)
              );

              saveSeen();

              console.log(
                `✅ Telegram sent for ${item.id}`
              );

              await sleep(500);

            } catch (error) {
              console.error(
                `Telegram failed for ${item.id}:`,
                error.message
              );
            }
          }
        }
      }

      errors = 0;

    } catch (error) {
      errors++;

      console.error(
        "❌ Check failed:",
        error.message
      );

      if (errors >= 3) {
        try {
          console.log(
            "Refreshing Vinted browser session..."
          );

          await page.goto(
            "https://www.vinted.co.uk/catalog?brand_ids[]=389025",
            {
              waitUntil: "domcontentloaded",
              timeout: 60000
            }
          );

          await page.waitForTimeout(3000);

          errors = 0;

        } catch (refreshError) {
          console.error(
            "Session refresh failed:",
            refreshError.message
          );
        }
      }
    }

    await sleep(
      CHECK_INTERVAL_SECONDS * 1000
    );
  }
}

main().catch(error => {
  console.error(
    "❌ Fatal error:",
    error
  );

  process.exit(1);
});
