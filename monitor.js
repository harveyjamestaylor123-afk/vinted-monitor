import fs from "fs";
import path from "path";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CHECK_INTERVAL_SECONDS = "10",
  DATA_DIR = "/data"
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing Telegram variables.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const seenFile = path.join(DATA_DIR, "seen_vinted.json");

const BASE_API =
  "https://api.vinted.co.uk/svc-catalogue/items";

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

function buildApiUrl() {
  const url = new URL(BASE_API);

  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", "96");

  /*
   * Fresh timestamp each request.
   */
  url.searchParams.set(
    "time",
    String(Math.floor(Date.now() / 1000))
  );

  url.searchParams.set(
    "search_text",
    "drakes"
  );

  /*
   * Try newest first.
   */
  url.searchParams.set(
    "order",
    "newest_first"
  );

  url.searchParams.set(
    "attribute_ids[brand]",
    "389025"
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

function normaliseItem(item) {
  if (!item?.id) return null;

  const id = String(item.id);

  const relativeUrl =
    item.url ||
    `/items/${id}`;

  const url =
    relativeUrl.startsWith("http")
      ? relativeUrl
      : `https://www.vinted.co.uk${relativeUrl}`;

  const image =
    item.photo?.url ||
    item.photo?.full_size_url ||
    item.photos?.[0]?.url ||
    item.photos?.[0]?.full_size_url ||
    "";

  const price =
    item.price?.amount
      ? `£${item.price.amount}`
      : "";

  const totalPrice =
    item.total_item_price?.amount
      ? `£${item.total_item_price.amount}`
      : "";

  return {
    id,
    title:
      item.title ||
      `Vinted item ${id}`,
    price,
    totalPrice,
    image,
    url,
    seller:
      item.user?.login ||
      "",
    favouriteCount:
      item.favourite_count ?? null,
    promoted:
      item.promoted === true,
    contentSource:
      item.content_source || ""
  };
}

async function sendListing(item) {
  const caption = [
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
  ]
    .filter(Boolean)
    .join("\n");

  if (item.image) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id: TELEGRAM_CHAT_ID,
          photo: item.image,
          caption,
          parse_mode: "HTML"
        }
      );

      return;
    } catch (error) {
      console.log(
        "Photo send failed, using text:",
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

async function fetchListings() {
  const url = buildApiUrl();

  const response =
    await fetch(
      url,
      {
        headers: {
          "Accept":
            "application/json, text/plain, */*",

          "Accept-Language":
            "en-GB,en;q=0.9",

          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",

          "Origin":
            "https://www.vinted.co.uk",

          "Referer":
            "https://www.vinted.co.uk/"
        }
      }
    );

  console.log(
    `Vinted HTTP ${response.status}`
  );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Vinted API returned ${response.status}: ${text.slice(0, 200)}`
    );
  }

  const data =
    await response.json();

  if (!Array.isArray(data.items)) {
    throw new Error(
      "Vinted response contained no items array."
    );
  }

  const items =
    data.items
      .map(normaliseItem)
      .filter(Boolean);

  console.log(
    `API returned ${items.length} item(s).`
  );

  return items;
}

async function main() {
  const seen =
    loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen Vinted item(s).`
  );

  console.log(
    "✅ Direct Vinted API monitor started."
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  let baselineDone =
    seen.size > 0;

  let errors =
    0;

  while (true) {
    try {
      const items =
        await fetchListings();

      if (
        items.length > 0 &&
        !baselineDone
      ) {
        for (const item of items) {
          seen.add(item.id);
        }

        saveSeen(seen);

        baselineDone =
          true;

        console.log(
          `✅ Baseline saved with ${seen.size} existing item(s).`
        );
      }

      else if (baselineDone) {
        const newItems =
          items.filter(
            item =>
              !seen.has(item.id)
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
