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

if (
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID
) {
  console.error(
    "❌ Missing Telegram environment variables."
  );
  process.exit(1);
}

if (!VINTED_COOKIE) {
  console.error(
    "❌ Missing VINTED_COOKIE environment variable."
  );
  process.exit(1);
}

fs.mkdirSync(
  DATA_DIR,
  { recursive: true }
);

const SEEN_FILE =
  path.join(
    DATA_DIR,
    "vinted_drakes_seen.json"
  );

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function loadSeen() {
  try {
    return new Set(
      JSON.parse(
        fs.readFileSync(
          SEEN_FILE,
          "utf8"
        )
      )
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify(
      [...seen],
      null,
      2
    )
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

async function telegramRequest(
  method,
  body
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram ${data.error_code}: ${data.description}`
    );
  }

  return data;
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
    "",
    `<a href="${itemUrl}">OPEN ON VINTED</a>`
  ]
    .filter(Boolean)
    .join("\n");

  const photo =
    getPhoto(item);

  if (photo) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id:
            TELEGRAM_CHAT_ID,

          photo,

          caption,

          parse_mode:
            "HTML"
        }
      );

      return;

    } catch (error) {
      console.log(
        "Photo failed, using text:",
        error.message
      );
    }
  }

  await telegramRequest(
    "sendMessage",
    {
      chat_id:
        TELEGRAM_CHAT_ID,

      text:
        caption,

      parse_mode:
        "HTML",

      disable_web_page_preview:
        false
    }
  );
}

function buildApiUrl() {
  const url =
    new URL(API_URL);

  url.searchParams.set(
    "page",
    "1"
  );

  url.searchParams.set(
    "per_page",
    "96"
  );

  url.searchParams.set(
    "time",
    String(
      Math.floor(
        Date.now() / 1000
      )
    )
  );

  /*
   * Match your actual UK search.
   */
  url.searchParams.set(
    "search_text",
    "drakes"
  );

  url.searchParams.set(
    "order",
    "relevance"
  );

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
  const url =
    buildApiUrl();

  const response =
    await fetch(
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

          /*
           * Your real UK Vinted browser session.
           *
           * This comes from Railway's secret
           * VINTED_COOKIE variable.
           */
          Cookie:
            VINTED_COOKIE
        },

        redirect:
          "follow"
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

  if (
    !Array.isArray(
      data.items
    )
  ) {
    throw new Error(
      "Vinted response contained no items array."
    );
  }

  return data.items;
}

function validateDrakes(items) {
  return items.filter(
    item => {
      if (!item?.id) {
        return false;
      }

      /*
       * Brand ID should already restrict
       * the results.
       *
       * This extra check prevents obvious
       * Drake/Drakes false positives.
       */
      const title =
        String(
          item.title || ""
        );

      return (
        /\bdrake['’]s\b/i.test(
          title
        ) ||
        /\bdrakes\b/i.test(
          title
        )
      );
    }
  );
}

async function main() {
  const seen =
    loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen item(s).`
  );

  console.log(
    "🇬🇧 Starting UK-session Drake's monitor."
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  let baselineDone =
    seen.size > 0;

  let failures = 0;

  while (true) {
    const started =
      Date.now();

    try {
      console.log(
        "🔎 Checking Drake's..."
      );

      const rawItems =
        await fetchDrakes();

      const items =
        validateDrakes(
          rawItems
        );

      console.log(
        `API returned ${rawItems.length} result(s).`
      );

      console.log(
        `Accepted ${items.length} Drake's listing(s).`
      );

      /*
       * If Vinted suddenly stops applying
       * the filter, don't Telegram anything.
       */
      if (
        rawItems.length > 0 &&
        items.length === 0
      ) {
        throw new Error(
          "Listings returned but none passed Drake's validation."
        );
      }

      if (!baselineDone) {
        for (
          const item of items
        ) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen(seen);

        baselineDone = true;

        console.log(
          `✅ Baseline saved with ${seen.size} listing(s).`
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
         * Spam protection.
         */
        if (
          newItems.length > 10
        ) {
          console.error(
            `🛑 SAFETY LOCK: ${newItems.length} unseen listings.`
          );

          console.error(
            "Telegram alerts suppressed."
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
            `🚨 ${newItems.length} NEW Drake's listing(s)!`
          );

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

              saveSeen(seen);

              console.log(
                `✅ Telegram sent for ${item.id}`
              );

              await sleep(
                400
              );

            } catch (error) {
              console.error(
                `Telegram failed for ${item.id}:`,
                error.message
              );
            }
          }
        }
      }

      failures = 0;

    } catch (error) {
      failures++;

      console.error(
        "❌ Check failed:",
        error.message
      );

      /*
       * A 401/403 after this was previously
       * working usually means the Vinted
       * browser cookie has expired.
       */
      if (
        String(error.message)
          .includes("401") ||
        String(error.message)
          .includes("403")
      ) {
        console.error(
          "⚠️ VINTED_COOKIE may have expired or Vinted may be rejecting Railway's IP."
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
