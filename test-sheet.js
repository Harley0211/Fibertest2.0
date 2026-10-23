const fs = require("fs");
try {
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    });
} catch {
  // no .env file - that's fine
}

const url = process.env.SHEET_WEBHOOK_URL;
const secret = process.env.SHEET_SECRET;

if (!url || !secret) {
  console.error("Set SHEET_WEBHOOK_URL and SHEET_SECRET first.");
  process.exit(1);
}

const record = {
  Environment: "test",
  "First Name": "Connection",
  "Last Name": "Check",
  Phone: "555-555-5555",
  DOB: "01/01/2001",
  PIN: "123654",
  Email: "qatest.auto0000@lotusflare.com",
  Address: "TEST ROW - safe to delete",
  "Plan Selected": "-",
  Autopay: "No",
  "Order Number": "-",
  Timestamp: new Date().toLocaleString(),
};

fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret, record }),
})
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((err) => console.error("Request failed:", err.message));
