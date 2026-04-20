module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Parse body manually — Vercel doesn't auto-parse
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid JSON body")); }
      });
      req.on("error", reject);
    });

    const { bank, csvData } = body;

    if (!bank || !csvData) {
      return res.status(400).json({ error: "Bank and CSV data are required." });
    }

    let parsed;
    if (bank === "absa") parsed = parseAbsa(csvData);
    else if (bank === "citi") parsed = parseCiti(csvData);
    else return res.status(400).json({ error: `Unsupported bank: ${bank}` });

    if (!parsed) {
      return res.status(422).json({ error: "Could not parse the file." });
    }

    if (parsed.transactions.length === 0 && parsed.openingBalance === 0) {
      return res.status(422).json({ error: "No transactions or balances found. Check you selected the correct bank and uploaded the right file." });
    }

    const xml = buildCamt053(parsed, "MSG" + Date.now(), "STMT" + Date.now());

    return res.status(200).json({
      ok: true, xml,
      txCount: parsed.transactions.length,
      bank: parsed.bank,
      currency: parsed.currency,
      openingBalance: parsed.openingBalance,
      closingBalance: parsed.closingBalance,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Conversion failed." });
  }
};

// ── CSV helpers ───────────────────────────────────────────────────────────────
function splitCsv(line) {
  const cols = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
    else { cur += c; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseAmt(s) {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.abs(n);
}

function parseDt(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function escX(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── ABSA Kenya parser ─────────────────────────────────────────────────────────
function parseAbsa(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const txs = []; let ob = null, cb = null, fd = null, td = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const c = splitCsv(line);
    const ll = line.toLowerCase();
    const dt = parseDt(c[1]);

    if (dt && c[0] && c[0].trim()) {
      const rec = parseAmt(c[4]), pay = parseAmt(c[5]);
      if (rec > 0 || pay > 0) {
        const cr = rec > 0;
        txs.push({
          desc: c[0].trim(), date: dt, valDate: dt,
          amt: cr ? rec : pay, dir: cr ? "CRDT" : "DBIT",
          ref: `ABSA-${(c[3]||"TX").trim()}-${dt.replace(/-/g,"")}-${String(txs.length+1).padStart(4,"0")}`,
        });
        if (!fd || dt < fd) fd = dt;
        if (!td || dt > td) td = dt;
      }
    }

    if (ll.includes("opening balance")) {
      for (let i = c.length-1; i >= 0; i--) { const a = parseAmt(c[i]); if (a > 0) { ob = a; break; } }
    }
    if (ll.includes("ending balance (bank)")) {
      for (let i = c.length-1; i >= 0; i--) { const a = parseAmt(c[i]); if (a > 0) { cb = a; break; } }
    } else if (ll.includes("ending balance calculated") && cb === null) {
      for (let i = c.length-1; i >= 0; i--) { const a = parseAmt(c[i]); if (a > 0) { cb = a; break; } }
    }
  }

  const today = new Date().toISOString().split("T")[0];
  return {
    bank: "ABSA Bank Kenya Limited", bic: "BARCKENXXXX", currency: "KES",
    accountId: "KE12BARC0000000000001", accountName: "ABSA Kenya Account",
    fromDate: fd||today, toDate: td||today,
    openingBalance: ob||0, closingBalance: cb||0, transactions: txs,
  };
}

// ── Citibank Kenya parser ─────────────────────────────────────────────────────
function parseCiti(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 2) return null;

  const hdr = splitCsv(lines[0]);
  const hi = {};
  hdr.forEach((h, i) => { hi[h.trim()] = i; });
  function gc(row, name) { const i = hi[name]; return (i !== undefined && i < row.length) ? row[i] : ""; }

  let acctNum = "", acctNm = "", iban = "", ccy = "USD";
  let ob = null, cb = null, fd = null, td = null;
  const txs = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line.trim()) continue;
    const c = splitCsv(line); if (c.length < 10) continue;

    if (!acctNum) {
      acctNum = gc(c, "Account Number").trim();
      acctNm  = gc(c, "Account Name").trim();
      iban    = gc(c, "IBAN Number").trim();
      ccy     = gc(c, "Account Currency").trim() || "USD";
    }
    if (ob === null) { const a = parseAmt(gc(c, "Opening Ledger Balance")); if (a > 0) ob = a; }
    if (cb === null) { const a = parseAmt(gc(c, "Current / Closing Ledger Balance")); if (a > 0) cb = a; }

    const dt = parseDt(gc(c, "Entry Date").trim());
    const amtStr = gc(c, "Transaction Amount").trim();
    if (!dt || !amtStr) continue;

    const raw = parseFloat(amtStr.replace(/[^0-9.-]/g, ""));
    if (isNaN(raw) || raw === 0) continue;

    const amt  = Math.abs(raw), dir = raw >= 0 ? "CRDT" : "DBIT";
    const desc = gc(c, "Transaction Description").trim() || gc(c, "Product Type").trim() || "TRANSACTION";
    const extra = gc(c, "Extra Information").trim();
    const pay   = gc(c, "Payment Details").trim();
    const vd    = parseDt(gc(c, "Value Date").trim()) || dt;
    const ref   = gc(c, "Bank Reference").trim() || gc(c, "Customer Reference").trim() ||
                  `CITI-${dt.replace(/-/g,"")}-${String(txs.length+1).padStart(4,"0")}`;
    const fullDesc = [desc, extra, pay].filter(Boolean).join(" | ").slice(0, 140);

    txs.push({ desc: fullDesc, date: dt, valDate: vd, amt, dir, ref });
    if (!fd || dt < fd) fd = dt;
    if (!td || dt > td) td = dt;
  }

  const today  = new Date().toISOString().split("T")[0];
  const acctId = iban || (acctNum ? `KE${acctNum}` : "KE00CITI0000000001");
  return {
    bank: "Citibank N.A. Kenya", bic: "CITIKENAXXX", currency: ccy,
    accountId: acctId, accountName: acctNm || "Citibank Kenya Account",
    fromDate: fd||today, toDate: td||today,
    openingBalance: ob||0, closingBalance: cb||0, transactions: txs,
  };
}

// ── Build CAMT.053 XML ────────────────────────────────────────────────────────
function buildCamt053(data, msgId, stmtId) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const entries = data.transactions.map((tx, i) => {
    const ref = escX(tx.ref || `TX${String(i+1).padStart(6,"0")}`);
    return `
    <Ntry>
      <Amt Ccy="${data.currency}">${Number(tx.amt).toFixed(2)}</Amt>
      <CdtDbtInd>${tx.dir}</CdtDbtInd>
      <Sts>BOOK</Sts>
      <BookgDt><Dt>${tx.date}</Dt></BookgDt>
      <ValDt><Dt>${tx.valDate||tx.date}</Dt></ValDt>
      <NtryRef>${ref}</NtryRef>
      <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${tx.dir==="CRDT"?"RCDT":"ICDT"}</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
      <NtryDtls><TxDtls><Refs><EndToEndId>${ref}</EndToEndId></Refs><RmtInf><Ustrd>${escX(tx.desc)}</Ustrd></RmtInf></TxDtls></NtryDtls>
    </Ntry>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${now}</CreDtTm>
      <MsgRcpt><FinInstnId><BIC>${data.bic}</BIC><Nm>${escX(data.bank)}</Nm></FinInstnId></MsgRcpt>
    </GrpHdr>
    <Stmt>
      <Id>${stmtId}</Id>
      <ElctrncSeqNb>1</ElctrncSeqNb>
      <CreDtTm>${now}</CreDtTm>
      <FrToDt><FrDtTm>${data.fromDate}T00:00:00+03:00</FrDtTm><ToDtTm>${data.toDate}T23:59:59+03:00</ToDtTm></FrToDt>
      <Acct>
        <Id><Othr><Id>${escX(data.accountId)}</Id></Othr></Id>
        <Nm>${escX(data.accountName)}</Nm>
        <Ccy>${data.currency}</Ccy>
        <Svcr><FinInstnId><BIC>${data.bic}</BIC><Nm>${escX(data.bank)}</Nm></FinInstnId></Svcr>
      </Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="${data.currency}">${Number(data.openingBalance).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${data.fromDate}</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${data.currency}">${Number(data.closingBalance).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${data.toDate}</Dt></Dt></Bal>${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}
