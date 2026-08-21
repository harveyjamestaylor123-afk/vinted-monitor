import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CHECK_INTERVAL_SECONDS = "10",
  VINTED_SEARCH_URL =
    "https://www.vinted.co.uk/catalog?search_text=drakes&brand_ids[]=389025&page=1",
  DATA_DIR = "/data"
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing Telegram variables.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const seenFile = path.join(DATA_DIR, "seen_vinted.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSeen() {
  try {
    return new Set(
      JSON.parse(fs.readFileSync(seenFile, "utf8"))
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    seenFile,
    JSON.stringify([...seen], null, 2)
  );
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function photoUrl(item) {
  return (
    item.photo?.url ||
    item.photo?.full_size_url ||
    item.photos?.[0]?.url ||
    item.photos?.[0]?.full_size_url ||
    ""
  );
}

function normaliseItem(item) {
  const id = String(item.id || "");

  if (!id) return null;

  const title =
    item.title ||
    `Vinted item ${id}`;

  const price =
    item.price?.amount
      ? `£${item.price.amount}`
      : "";

  const totalPrice =
    item.total_item_price?.amount
      ? `£${item.total_item_price.amount}`
      : "";

  const relativeUrl =
    item.url ||
    `/items/${id}`;

  const url =
    relativeUrl.startsWith("http")
      ? relativeUrl
      : `https://www.vinted.co.uk${relativeUrl}`;

  return {
    id,
    title,
    price,
    totalPrice,
    image: photoUrl(item),
    url,
    promoted: item.promoted === true,
    contentSource: item.content_source || "",
    favouriteCount: item.favourite_count ?? null,
    seller: item.user?.login || ""
  };
}

async function sendListing(item) {
  const lines = [
    "🚨 <b>NEW VINTED LISTING</b>",
    "",
    `<b>${escapeHtml(item.title)}</b>`,
    "",
    `🏷 <b>Brand:</b> Drake's`,
    item.price
      ? `💷 <b>Price:</b> ${escapeHtml(item.price)}`
      : "",
    item.totalPrice && item.totalPrice !== item.price
      ? `💳 <b>Incl. buyer protection:</b> ${escapeHtml(item.totalPrice)}`
      : "",
    item.seller
      ? `👤 <b>Seller:</b> ${escapeHtml(item.seller)}`
      : "",
    item.favouriteCount !== null
      ? `❤️ <b>Favourites:</b> ${item.favouriteCount}`
      : "",
    "",
    `<a href="${item.url}">OPEN ON VINTED</a>`
  ].filter(Boolean);

  const caption = lines.join("\n");

  if (item.image) {
    try {
      await telegramRequest("sendPhoto", {
        chat_id: TELEGRAM_CHAT_ID,
        photo: item.image,
        caption,
        parse_mode: "HTML"
      });

      return;
    } catch (error) {
      console.log(
        "Photo send failed, using text:",
        error.message
      );
    }
  }

  await telegramRequest("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function getListings(page) {
  const responsePromise = page.waitForResponse(
    response => {
      const url = response.url();

      if (url.includes("/svc-catalogue/items")) {
        console.log(
          `🔎 Catalogue response detected: ${response.status()} ${url}`
        );

        return response.status() === 200;
      }

      return false;
    },
    {
      timeout: 45000
    }
  );

  await page.goto(
    VINTED_SEARCH_URL,
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  const response =
    await responsePromise;

  const data =
    await response.json();

  if (!Array.isArray(data.items)) {
    throw new Error(
      "Vinted catalogue response contained no items array."
    );
  }

  console.log(
    `Catalogue API returned ${data.items.length} item(s).`
  );

  return data.items
    .map(normaliseItem)
    .filter(Boolean);
}

async function main() {
  const seen =
    loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen Vinted item(s).`
  );

  const browser =
    await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

  const context =
    await browser.newContext({
      locale: "en-GB",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    });

  const page =
    await context.newPage();

  let baselineDone =
    seen.size > 0;

  let errors =
    0;

  console.log(
    "✅ Vinted API-response monitor started."
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  while (true) {
    try {
      const items =
        await getListings(page);

      if (!baselineDone) {
        for (const item of items) {
          seen.add(item.id);
        }

        saveSeen(seen);

        baselineDone = true;

        console.log(
          `✅ Baseline saved with ${seen.size} existing item(s).`
        );
      }

      else {
        const newItems =
          items.filter(
            item => !seen.has(item.id)
          );

        if (newItems.length === 0) {
          console.log(
            "No new Drake's listings."
          );
        }

        if (newItems.length > 0) {
          console.log(
            `🚨 ${newItems.length} NEW Drake's listing(s) detected!`
          );

          for (
            const item of [...newItems].reverse()
          ) {
            try {
              await sendListing(item);

              seen.add(item.id);

              saveSeen(seen);

              console.log(
                `✅ Telegram sent for ${item.id}: ${item.title}`
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

      errors = 0;

    } catch (error) {
      errors++;

      console.error(
        "❌ Vinted check failed:",
        error.message
      );
    }

    const delay =
      errors >= 3
        ? 60000
        : Number(
            CHECK_INTERVAL_SECONDS
          ) * 1000;

    await sleep(delay);
  }
}

main().catch(error => {
  console.error(
    "❌ Fatal Vinted monitor error:",
    error
  );

  process.exit(1);
});
