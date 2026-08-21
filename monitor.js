import { chromium } from "playwright";
import fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_SECONDS =
  Number(process.env.CHECK_INTERVAL_SECONDS || "10");

const DRAKES_BRAND_ID = "389025";

const VINTED_URL =
  `https://www.vinted.co.uk/catalog?brand_ids[]=${DRAKES_BRAND_ID}&order=newest_first`;

const SEEN_FILE = "/tmp/seen.json";

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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function telegramRequest(
  method,
  body
) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
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

function getItemPhoto(item) {
  return (
    item.photo?.url ||
    item.photo?.full_size_url ||
    item.photos?.[0]?.url ||
    item.photos?.[0]?.full_size_url ||
    ""
  );
}

async function sendTelegram(item) {
  const itemUrl =
    item.url?.startsWith("http")
      ? item.url
      : `https://www.vinted.co.uk${item.url || `/items/${item.id}`}`;

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

  const lines = [
    "🚨 <b>NEW DRAKE'S LISTING</b>",
    "",
    `<b>${escapeHtml(
      item.title ||
      "New Drake's listing"
    )}</b>`,
    "",
    price
      ? `💷 <b>Price:</b> ${escapeHtml(price)}`
      : "",
    totalPrice &&
    totalPrice !== price
      ? `🛍 <b>Incl. buyer protection:</b> ${escapeHtml(totalPrice)}`
      : "",
    seller
      ? `👤 <b>Seller:</b> ${escapeHtml(seller)}`
      : "",
    item.favourite_count !== undefined
      ? `❤️ <b>Favourites:</b> ${item.favourite_count}`
      : "",
    "",
    `<a href="${itemUrl}">OPEN ON VINTED</a>`
  ]
    .filter(Boolean)
    .join("\n");

  const photo =
    getItemPhoto(item);

  if (photo) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id: CHAT_ID,
          photo,
          caption: lines,
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
      text: lines,
      parse_mode: "HTML",
      disable_web_page_preview:
        false
    }
  );
}

async function fetchDrakesItems(page) {
  /*
   * This request runs INSIDE the Vinted
   * browser session, which is why Vinted
   * accepts it when Railway's direct API
   * requests received HTTP 403.
   */
  return await page.evaluate(
    async brandId => {

      const params =
        new URLSearchParams();

      params.set(
        "page",
        "1"
      );

      params.set(
        "per_page",
        "96"
      );

      params.set(
        "time",
        String(
          Math.floor(
            Date.now() / 1000
          )
        )
      );

      /*
       * IMPORTANT:
       * No search_text=drakes.
       *
       * We rely ONLY on Vinted's actual
       * Drake's brand ID.
       */
      params.set(
        "attribute_ids[brand]",
        brandId
      );

      params.set(
        "order",
        "newest_first"
      );

      const response =
        await fetch(
          `https://www.vinted.co.uk/api/v2/catalog/items?${params.toString()}`,
          {
            credentials:
              "include",

            headers: {
              Accept:
                "application/json"
            }
          }
        );

      const text =
        await response.text();

      return {
        status:
          response.status,
        text
      };

    },
    DRAKES_BRAND_ID
  );
}

async function main() {
  console.log(
    "🚀 Starting Drake's Vinted monitor"
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
      locale:
        "en-GB",

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",

      extraHTTPHeaders: {
        "Accept-Language":
          "en-GB,en;q=0.9"
      }
    });

  const page =
    await context.newPage();

  console.log(
    "Opening Vinted..."
  );

  await page.goto(
    "https://www.vinted.co.uk/",
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );

  await page.waitForTimeout(
    3000
  );

  console.log(
    "✅ Vinted browser session ready."
  );

  /*
   * Open the Drake's brand page once.
   */
  await page.goto(
    VINTED_URL,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );

  await page.waitForTimeout(
    2500
  );

  let firstSuccessfulRun =
    true;

  let errors =
    0;

  while (true) {
    try {
      console.log(
        "Checking Drake's..."
      );

      const result =
        await fetchDrakesItems(
          page
        );

      console.log(
        `Browser API HTTP ${result.status}`
      );

      if (
        result.status !== 200
      ) {
        throw new Error(
          `Vinted returned HTTP ${result.status}`
        );
      }

      let data;

      try {
        data =
          JSON.parse(
            result.text
          );
      } catch {
        throw new Error(
          "Could not parse Vinted catalogue response."
        );
      }

      if (
        !Array.isArray(
          data.items
        )
      ) {
        throw new Error(
          "Vinted response contained no items array."
        );
      }

      /*
       * Vinted has already filtered these by
       * brand ID 389025.
       *
       * Don't perform title matching here.
       */
      const items =
        data.items.filter(
          item =>
            item &&
            item.id
        );

      console.log(
        `Found ${items.length} Drake's listing(s).`
      );

      /*
       * Baseline existing listings so we
       * don't flood Telegram after a restart.
       */
      if (
        firstSuccessfulRun &&
        seen.size === 0
      ) {
        for (
          const item of items
        ) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen();

        firstSuccessfulRun =
          false;

        console.log(
          `✅ Baseline created with ${seen.size} listings.`
        );
      }

      else {
        firstSuccessfulRun =
          false;

        const newItems =
          items.filter(
            item =>
              !seen.has(
                String(item.id)
              )
          );

        if (
          newItems.length === 0
        ) {
          console.log(
            "No new Drake's listings."
          );
        }

        if (
          newItems.length > 0
        ) {
          console.log(
            `🚨 ${newItems.length} NEW Drake's listing(s)!`
          );

          /*
           * Reverse so Telegram displays
           * multiple simultaneous finds
           * in sensible order.
           */
          for (
            const item of
              [...newItems].reverse()
          ) {
            try {
              console.log(
                `🚨 NEW: ${item.title}`
              );

              await sendTelegram(
                item
              );

              seen.add(
                String(item.id)
              );

              saveSeen();

              console.log(
                `✅ Telegram sent for ${item.id}`
              );

            } catch (error) {
              console.error(
                `❌ Telegram failed for ${item.id}:`,
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

      /*
       * Re-open Vinted after repeated errors
       * in case the browser session has gone stale.
       */
      if (
        errors >= 3
      ) {
        try {
          console.log(
            "Refreshing Vinted browser session..."
          );

          await page.goto(
            VINTED_URL,
            {
              waitUntil:
                "domcontentloaded",

              timeout:
                60000
            }
          );

          await page.waitForTimeout(
            3000
          );

          errors = 0;

        } catch (
          refreshError
        ) {
          console.error(
            "Session refresh failed:",
            refreshError.message
          );
        }
      }
    }

    await sleep(
      CHECK_INTERVAL_SECONDS *
      1000
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
