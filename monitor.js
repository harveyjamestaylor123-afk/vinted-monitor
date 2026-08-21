import fs from "fs";
import path from "path";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  VINTED_COOKIE,
  CHECK_INTERVAL_SECONDS = "10",
  DATA_DIR = "/data"
} = process.env;

const DRAKES_BRAND_ID = "389025";
const API_URL =
  "https://api.vinted.co.uk/svc-catalogue/items";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing Telegram variables.");
  process.exit(1);
}

if (!VINTED_COOKIE) {
  console.error("❌ Missing VINTED_COOKIE.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * New state file so we start this version cleanly.
 */
const SEEN_FILE = path.join(
  DATA_DIR,
  "vinted_drakes_seen_v2.json"
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSeen() {
  try {
    return new Set(
      JSON.parse(
        fs.readFileSync(SEEN_FILE, "utf8")
      )
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify([...seen], null, 2)
  );
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function telegramRequest(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
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

  const caption = [
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
      ? `🛍 <b>Incl. buyer protection:</b> ${escapeHtml(totalPrice)}`
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
          chat_id: TELEGRAM_CHAT_ID,
          photo,
          caption,
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
      chat_id: TELEGRAM_CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false
    }
  );
}

function buildApiUrl() {
  const url = new URL(API_URL);

  url.searchParams.set("page", "1");

  /*
   * Keep the full first page.
   */
  url.searchParams.set(
    "per_page",
    "96"
  );

  /*
   * Fresh request timestamp.
   */
  url.searchParams.set(
    "time",
    String(
      Math.floor(Date.now() / 1000)
    )
  );

  url.searchParams.set(
    "search_text",
    "drakes"
  );

  /*
   * Critical:
   * ask Vinted for newest listings first.
   */
  url.searchParams.set(
    "order",
    "newest_first"
  );

  /*
   * Drake's brand ID from your real Vinted search.
   */
  url.searchParams.set(
    "attribute_ids[brand]",
    DRAKES_BRAND_ID
  );

  url.searchParams.set(
    "attribute_ids[catalog]",
    ""
  );

  url.searchParams.set(
    "attribute_ids[size]",
    ""
  );

  url.searchParams.set(
    "attribute_ids[status]",
    ""
  );

  url.searchParams.set(
    "attribute_ids[color]",
    ""
  );

  url.searchParams.set(
    "attribute_ids[material]",
    ""
  );

  return url.toString();
}

async function fetchDrakes() {
  const url = buildApiUrl();

  const response = await fetch(
    url,
    {
      headers: {
        Accept:
          "application/json, text/plain, */*",

        "Accept-Language":
          "en-GB,en;q=0.9",

        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",

        Origin:
          "https://www.vinted.co.uk",

        Referer:
          "https://www.vinted.co.uk/catalog?search_text=drakes&brand_ids[]=389025&page=1",

        Cookie:
          VINTED_COOKIE
      },

      redirect: "follow"
    }
  );

  console.log(
    `Vinted HTTP ${response.status}`
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Vinted returned ${response.status}: ${body.slice(0, 180)}`
    );
  }

  const data =
    await response.json();

  if (!Array.isArray(data.items)) {
    throw new Error(
      "Vinted response contained no items array."
    );
  }

  return data.items.filter(
    item => item && item.id
  );
}

async function main() {
  const seen = loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen item(s).`
  );

  console.log(
    "🚀 Drake's newest-first monitor started."
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  let baselineDone =
    seen.size > 0;

  while (true) {
    const started = Date.now();

    try {
      console.log(
        "🔎 Checking newest Drake's listings..."
      );

      const items =
        await fetchDrakes();

      console.log(
        `API returned ${items.length} item(s).`
      );

      /*
       * Diagnostic:
       * show exactly what Vinted considers
       * the newest 10 results.
       */
      console.log(
        "TOP 10 FROM VINTED:"
      );

      for (
        const item of items.slice(0, 10)
      ) {
        console.log(
          `${item.id} | ${item.title}`
        );
      }

      /*
       * First successful run becomes baseline.
       */
      if (!baselineDone) {
        for (const item of items) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen(seen);

        baselineDone = true;

        console.log(
          `✅ Baseline saved with ${seen.size} item(s).`
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
         * Prevent another flood.
         */
        if (newItems.length > 10) {
          console.error(
            `🛑 SAFETY LOCK: ${newItems.length} unseen items returned.`
          );

          console.error(
            "No Telegram messages sent."
          );
        }

        else if (
          newItems.length === 0
        ) {
          console.log(
            "No new Drake's listings."
          );
        }

        else {
          console.log(
            `🚨 ${newItems.length} NEW LISTING(S)!`
          );

          for (
            const item of [...newItems].reverse()
          ) {
            try {
              console.log(
                `🚨 NEW: ${item.id} | ${item.title}`
              );

              await sendTelegram(item);

              seen.add(
                String(item.id)
              );

              saveSeen(seen);

              console.log(
                `✅ Telegram sent for ${item.id}`
              );

              await sleep(300);

            } catch (error) {
              console.error(
                `Telegram failed for ${item.id}:`,
                error.message
              );
            }
          }
        }
      }

    } catch (error) {
      console.error(
        "❌ Check failed:",
        error.message
      );

      if (
        String(error.message).includes("401") ||
        String(error.message).includes("403")
      ) {
        console.error(
          "⚠️ Your VINTED_COOKIE may need refreshing."
        );
      }
    }

    const elapsed =
      Date.now() - started;

    const target =
      Number(
        CHECK_INTERVAL_SECONDS
      ) * 1000;

    await sleep(
      Math.max(
        1000,
        target - elapsed
      )
    );
  }
}

main().catch(error => {
  console.error(
    "❌ Fatal monitor error:",
    error
  );

  process.exit(1);
});
