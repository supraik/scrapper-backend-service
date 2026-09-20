# Frontend Integration Guide

> Everything you need to call the backend. You never need to look at backend code.

---

## Base URL

```
const BASE_URL = "http://localhost:8000";
```

---

## Identity & Auth — How Users Work

There is **no login system**. The backend treats each browser as a unique user.

- On the very first request, if no `authorization` header is sent, the backend **auto-generates a new user ID** and returns it in the **response header** `userid`.
- You save that ID to `localStorage` and send it on every subsequent request.
- That's it — same browser = same user, every time.

---

## `callBackend(url)` — The One Function for All API Calls

Write this once, use it everywhere.

```js
async function callBackend(url) {
  const headers = {};

  // Attach saved user ID if we have one
  const savedId = localStorage.getItem("userid");
  if (savedId) {
    headers["authorization"] = savedId;
  }

  const response = await fetch(BASE_URL + url, { headers });

  // Always save the returned user ID (first-time or refreshed)
  const returnedId = response.headers.get("userid");
  if (returnedId) {
    localStorage.setItem("userid", returnedId);
  }

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}
```

**All API calls go through this.** You get back `{ ok, status, data }`.

> **Show a loader before every `callBackend` call. Hide it when the promise resolves.** These hit a real server and can take a moment.

---

## API Reference

---

### 1. Search Products

Search the product catalog by name, brand, or category.

**Route:** `GET /search`

**Query Params:**

| Param    | Type   | Required | Default | Description                        |
|----------|--------|----------|---------|------------------------------------|
| `q`      | string | ✅       | —       | The search term typed by the user  |
| `limit`  | number | ❌       | `20`    | How many results to return         |
| `offset` | number | ❌       | `1`     | Page number (1 = first page)       |

**Example Call:**
```js
const { ok, data } = await callBackend(`/search?q=laptop&limit=20&offset=1`);
```

**Success Response (`200`):**
```json
{
  "success": true,
  "data": [
    {
      "id": 734,
      "name": "Dell XPS 15",
      "brand": "Dell",
      "category": "Laptops",
      "url": "https://demo.inelabteamdev.com/product/734",
      "usersSubscribed": 12,
      "currentPrice": 1299.99,
      "stockStatus": "In Stock",
      "lastFetchedAt": "2025-09-18T14:22:00.000Z"
    }
  ],
  "meta": {
    "count": 1,
    "query": "laptop"
  }
}
```

**Notes:**
- `currentPrice` can be `null` if the scraper hasn't run yet for that product.
- `lastFetchedAt` can be `null` for the same reason.
- `stockStatus` defaults to `"Unknown"` if not yet scraped.
- Results are sorted by popularity (`usersSubscribed`) first, then alphabetically.
- Implement debounce on the search input — don't fire on every keystroke.

**Error (`400`):**
```json
{ "success": false, "message": "Query param \"q\" is required." }
```

---

### 2. Add to Watchlist (Subscribe)

Subscribe the current user to a product. Starts tracking it.

**Route:** `GET /add`

**Query Params:**

| Param       | Type   | Required | Description            |
|-------------|--------|----------|------------------------|
| `productId` | number | ✅       | The ID of the product  |

**Example Call:**
```js
const { ok, data } = await callBackend(`/add?productId=734`);
```

**Success Response (`200`):**
```json
{
  "success": true,
  "message": "Subscribed successfully.",
  "data": {
    "productId": 734,
    "userId": "usr_abc123"
  }
}
```

**Already Subscribed Response (`200`):**
```json
{
  "success": true,
  "message": "Already subscribed.",
  "data": { "productId": 734, "userId": "usr_abc123" }
}
```

**Notes:**
- Safe to call even if already subscribed — won't double-count.
- Use the response `message` field to show a toast if you want.

---

### 3. Remove from Watchlist (Unsubscribe)

Remove the current user's subscription to a product.

**Route:** `GET /remove`

**Query Params:**

| Param       | Type   | Required | Description            |
|-------------|--------|----------|------------------------|
| `productId` | number | ✅       | The ID of the product  |

**Example Call:**
```js
const { ok, data } = await callBackend(`/remove?productId=734`);
```

**Success Response (`200`):**
```json
{
  "success": true,
  "message": "Unsubscribed successfully.",
  "data": {
    "productId": 734,
    "userId": "usr_abc123"
  }
}
```

**Error — Not in Watchlist (`404`):**
```json
{ "success": false, "message": "Product was not in your watchlist." }
```

**Notes:**
- If this product hits **zero subscribers** across all users, its price history is automatically deleted by the backend. This is intentional — no action needed on your end.

---

### 4. Dashboard (My Watchlist)

Get all products the current user is subscribed to, with latest price data.

**Route:** `GET /dashboard`

**No query params needed.** User ID comes from the `authorization` header automatically via `callBackend`.

**Example Call:**
```js
const { ok, data } = await callBackend(`/dashboard`);
```

**Success Response (`200`):**
```json
{
  "success": true,
  "data": [
    {
      "id": 734,
      "name": "Dell XPS 15",
      "brand": "Dell",
      "category": "Laptops",
      "url": "https://demo.inelabteamdev.com/product/734",
      "usersSubscribed": 12,
      "currentPrice": 1299.99,
      "stockStatus": "In Stock",
      "lastFetchedAt": "2025-09-18T14:22:00.000Z"
    },
    {
      "id": 566,
      "name": "Sony WH-1000XM5",
      "brand": "Sony",
      "category": "Headphones",
      "url": "https://demo.inelabteamdev.com/product/566",
      "usersSubscribed": 5,
      "currentPrice": null,
      "stockStatus": "Unknown",
      "lastFetchedAt": null
    }
  ],
  "meta": { "count": 2 }
}
```

**Empty Watchlist (`200`):**
```json
{ "success": true, "data": [], "meta": { "count": 0 } }
```

**Notes:**
- Call this on every dashboard page load.
- If `data` is empty, show an empty state: "You're not tracking any products yet."
- `currentPrice: null` means the scraper hasn't fetched this product yet. Show a placeholder like `—` or `Price pending`.

---

### 5. Product Price History

Get the full price history for a specific product. Use this for charts or a detail view.

**Route:** `GET /history`

**Query Params:**

| Param       | Type   | Required | Description            |
|-------------|--------|----------|------------------------|
| `productId` | number | ✅       | The ID of the product  |

**Example Call:**
```js
const { ok, data } = await callBackend(`/history?productId=734`);
```

**Success Response (`200`):**
```json
{
  "success": true,
  "data": {
    "productId": 734,
    "history": [
      {
        "price": 1399.99,
        "stockStatus": "In Stock",
        "timestamp": "2025-09-10T08:00:00.000Z"
      },
      {
        "price": 1349.99,
        "stockStatus": "In Stock",
        "timestamp": "2025-09-14T08:00:00.000Z"
      },
      {
        "price": 1299.99,
        "stockStatus": "In Stock",
        "timestamp": "2025-09-18T14:22:00.000Z"
      }
    ]
  },
  "meta": { "dataPoints": 3 }
}
```

**Error — No History Yet (`404`):**
```json
{ "success": false, "message": "No history found for this product." }
```

**Notes:**
- `history` is ordered oldest → newest. The **last entry is the most recent price**.
- `price` can be `null` in an entry if the scraper failed that run.
- `meta.dataPoints` tells you how many entries there are — useful to conditionally show a chart vs. "not enough data yet".
- The scraper runs on a schedule (cron). History grows over time automatically.

---

## Data Types Quick Reference

```
Product {
  id            : number
  name          : string
  brand         : string | null
  category      : string           // defaults to "Uncategorized"
  url           : string           // direct link to product page
  usersSubscribed: number
  currentPrice  : number | null    // float, e.g. 1299.99
  stockStatus   : string           // "In Stock" | "Out of Stock" | "Unknown"
  lastFetchedAt : string | null    // ISO 8601 timestamp
}

HistoryEntry {
  price       : number | null
  stockStatus : string
  timestamp   : string | null      // ISO 8601
}
```

---

## Error Handling

All errors follow the same shape:

```json
{ "success": false, "message": "Human readable reason" }
```

Recommended pattern:

```js
const { ok, status, data } = await callBackend(`/dashboard`);

if (!ok) {
  console.error(`API error ${status}:`, data.message);
  showErrorToast(data.message);
  return;
}

// safe to use data.data here
```

---

## Loader Checklist

Every API call can take time. Always show a loading state:

| Route       | When to show loader                                 |
|-------------|-----------------------------------------------------|
| `/search`   | As soon as user starts typing (after debounce fires)|
| `/add`      | On button click, until response comes back          |
| `/remove`   | On button click, until response comes back          |
| `/dashboard`| Full page load / spinner over the product list      |
| `/history`  | While the chart/detail panel is opening             |

Disable the Add/Remove button while its request is in flight to prevent double-clicks.