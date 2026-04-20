# CamtBridge — Online Bank Statement to CAMT.053 Converter

Multi-user web app. Deploy to Vercel in ~3 minutes. No server to manage.

---

## Deploy to Vercel (free, online, multi-user)

### Step 1 — Install Vercel CLI
```bash
npm install -g vercel
```

### Step 2 — Install dependencies
```bash
npm install
```

### Step 3 — Deploy
```bash
vercel
```
Follow the prompts (log in / create a free account if needed).
When asked "Set up and deploy?" → Yes.

### Step 4 — Add your Anthropic API key
In the Vercel dashboard → your project → Settings → Environment Variables:
```
ANTHROPIC_API_KEY = sk-ant-your-key-here
```
Get your key: https://console.anthropic.com

### Step 5 — Redeploy with the key
```bash
vercel --prod
```

You'll get a public URL like: https://camtbridge.vercel.app ✅

---

## ABSA Kenya — Statement Format (implemented)

Columns (CSV):
```
Transaction Descriptions | Trans.date | PM | Bank Trans. Type | Receipts | Payments
```
- Date format: M/D/YYYY (e.g. 2/27/2026)
- Receipts column = credits (CRDT)
- Payments column = debits (DBIT)
- Opening balance: row containing "Opening Balance"
- Closing balance: row containing "Ending balance (BANK)"

---

## Citibank Kenya — Statement Format (to be refined)

Upload a sample Citibank CSV and the parser will be updated with the exact column mapping.
Currently supports auto-detection of common Citi formats:
- Booking Date | Value Date | Description | Reference | Debit | Credit | Balance

---

## Adding More Banks

In `api/convert.js`:

1. Add a parser function `parseBankX(csv)` returning:
```js
{
  bank, bic, bicFi, currency,
  fromDate, toDate,
  openingBalance, closingBalance,
  transactions: [{ description, date, valDate, amount, direction ('CRDT'|'DBIT'), ref }]
}
```

2. Add a case in the handler:
```js
} else if (bank === 'kcb') {
  parsed = parseKcb(fileContent);
}
```

3. Enable the bank tile in `public/index.html` (remove `soon` class).

---

## Project Structure
```
camtbridge-online/
├── api/
│   ├── convert.js     ← Serverless function: parse CSV → CAMT.053 XML
│   └── login.js       ← Auth endpoint (demo mode)
├── public/
│   └── index.html     ← Full frontend (login + converter UI)
├── package.json
├── vercel.json        ← Routing config
└── README.md
```
