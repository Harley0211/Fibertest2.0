const { test, expect } = require("@playwright/test");
const fs = require("fs");

// Load SHEET_* values from a .env file in the project folder (no extra
// packages needed). Real environment variables still win if both exist.
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

const BASE_URL = "https://qlab03.fiber.t-mobile.com";
const ENVIRONMENT = new URL(BASE_URL).hostname.split(".")[0]; // e.g. "qlab03"

// Google Sheet logging: set these as environment variables (see setup steps)
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const SHEET_SECRET = process.env.SHEET_SECRET;

// Fixed test data
const PHONE = "555-555-5555";
const DOB = "01/01/2001";
const PIN = "123654";
const PLAN_NAME = "Fiber 1 Gig (1000 Mbps)";

// ---------- helpers ----------
const randomDigits = (len) =>
  Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");

const randomIndex = (count) => Math.floor(Math.random() * count);

// Letters only, capitalized, 8-10 characters (meets the 8 char minimum)
const randomName = (min = 8, max = 10) => {
  const len = min + Math.floor(Math.random() * (max - min + 1));
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const word = Array.from(
    { length: len },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");
  return word.charAt(0).toUpperCase() + word.slice(1);
};

// Next free email: qatest.auto0001@lotusflare.com, 0002, 0003, ...
// "Used" = any qatest.autoNNNN email found in the Google Sheet or in the local
// account-log.csv. Picks the lowest number that is not used yet.
// If the sheet is configured but cannot be read, the test STOPS instead of
// guessing an email that might already exist.
async function getNextEmail(request) {
  const used = new Set();
  const collect = (text) => {
    for (const m of text.matchAll(/qatest\.auto(\d+)@lotusflare\.com/gi)) {
      used.add(Number(m[1]));
    }
  };

  if (SHEET_WEBHOOK_URL) {
    const res = await request.post(SHEET_WEBHOOK_URL, {
      data: { secret: SHEET_SECRET, action: "listEmails" },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok() || !body || body.ok !== true || !Array.isArray(body.emails)) {
      throw new Error(
        `Could not read the used emails from the Google Sheet (HTTP ${res.status()}). ` +
          "Stopping so a duplicate email is not created.",
      );
    }
    collect(body.emails.join("\n"));
    console.log(`Emails already used in the sheet: ${body.emails.length}`);
  } else {
    console.warn("SHEET_WEBHOOK_URL not set - checking local CSV only.");
  }

  if (fs.existsSync("account-log.csv")) {
    collect(fs.readFileSync("account-log.csv", "utf8"));
  }

  let n = 1;
  while (used.has(n)) n++;
  return `qatest.auto${String(n).padStart(4, "0")}@lotusflare.com`;
}

// Same order-summary layout is used on /review and /confirmation.
// Soft assertions: every mismatch is reported, not just the first.
async function verifyOrderDetails(page, d, totalTodayLabel) {
  const t = (id) => page.getByTestId(id);

  // Plan (non-AutoPay card -> undiscounted price)
  await expect.soft(t("faco-name-and-speed")).toContainText(PLAN_NAME);
  await expect.soft(t("faco-price")).toHaveText(`${d.price}/mo`);

  // Equipment
  await expect.soft(t("equipment-card-0")).toContainText("Wi-Fi router");
  await expect
    .soft(t("equipment-card-1"))
    .toContainText("Wi-Fi mesh access point");

  // Service address (same lines we saw on get-started)
  for (let i = 0; i < d.serviceAddress.length; i++) {
    await expect
      .soft(t(`fpe-review-address-line-${i}`))
      .toHaveText(d.serviceAddress[i]);
  }

  // Contact info
  await expect.soft(t("facci-name")).toHaveText(d.name);
  await expect.soft(t("facci-email")).toHaveText(d.email);
  await expect.soft(t("facci-phone")).toHaveText(d.phone);

  // Installation details
  await expect.soft(t("faai-date")).toHaveText(d.installDate);
  await expect.soft(t("faai-time")).toHaveText(d.installTime);

  // Payment info (card number is masked: check last 4 + expiry)
  await expect.soft(t("facc-image")).toHaveClass(/visa/);
  await expect.soft(t("facc-number")).toContainText("0006");
  await expect.soft(t("facc-exp")).toHaveText("Exp 12/32");

  // Totals
  await expect.soft(t("ftic-deposit")).toContainText(totalTodayLabel);
  await expect.soft(t("ftic-deposit")).toContainText("$0");
  await expect.soft(t("ftic-total")).toContainText("Due Monthly");
  await expect.soft(t("ftic-total")).toContainText(`${d.price}/mo`);
}

const SHEET_COLUMNS = [
  "Environment",
  "First Name",
  "Last Name",
  "Phone",
  "DOB",
  "PIN",
  "Email",
  "Address",
  "Plan Selected",
  "Autopay",
  "Order Number",
  "Timestamp",
];

// Saves one row to a local CSV (backup) and to the Google Sheet (via Apps Script)
async function saveRecord(request, record) {
  const csvPath = "account-log.csv";
  const csvLine = SHEET_COLUMNS.map(
    (c) => `"${String(record[c]).replace(/"/g, '""')}"`,
  ).join(",");
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, SHEET_COLUMNS.join(",") + "\n");
  }
  fs.appendFileSync(csvPath, csvLine + "\n");
  console.log("Saved to", csvPath);

  if (!SHEET_WEBHOOK_URL) {
    console.warn("SHEET_WEBHOOK_URL not set - skipped Google Sheet.");
    return;
  }
  try {
    const res = await request.post(SHEET_WEBHOOK_URL, {
      data: { secret: SHEET_SECRET, record },
    });
    const body = await res.text();
    if (res.ok() && body.includes('"ok":true')) {
      console.log("Saved to Google Sheet");
    } else {
      console.warn(
        "Google Sheet save failed:",
        res.status(),
        body.slice(0, 200),
      );
    }
  } catch (err) {
    console.warn("Google Sheet save error:", err.message);
  }
}

const ADDRESS = "61 DELANCEY ST, NEW";
const PILOT_ADDRESSES = ["61 DELANCEY ST, NEW"];

test("unassisted buyflow", async ({ page, request }) => {
  test.setTimeout(180000); // full flow is long; don't let the default 30s kill it

  // ---------- check-address ----------
  await page.goto(`${BASE_URL}/check-address`);

  const title = page.getByTestId("pca-title");
  const description = page.getByTestId("pca-description");
  await expect(title).toBeVisible();
  await expect(description).toBeVisible();
  console.log("Title:", await title.textContent());
  console.log("Description:", await description.textContent());

  const addressInput = page.getByTestId("fpe-fiber-input");
  await addressInput.click();
  await addressInput.pressSequentially(ADDRESS, { delay: 50 });

  const suggestions = page.locator("#address-dropdown-suggestions-list");
  await expect(suggestions.first()).toBeVisible();
  await suggestions.first().click();
  await expect(addressInput).toHaveValue(/61 DELANCEY/i);

  await page.locator("#fca-unit").click();
  await page.locator("#fca-unit-0").click();

  await page.getByRole("button", { name: "Next" }).click();

  // ---------- offering ----------
  await page.waitForURL(/\/offering/);

  const isPilot = PILOT_ADDRESSES.includes(ADDRESS);

  const oneGigCards = page.locator(".fiber-offer-card-container").filter({
    has: page
      .getByTestId("fiber-offer-card-banner-message")
      .filter({ hasText: /^Fiber 1 Gig$/ }),
  });

  const pricingRule = page.getByTestId("offer-card-pricing-rule");

  const card = isPilot
    ? oneGigCards.filter({ has: pricingRule })
    : oneGigCards.filter({ hasNot: pricingRule });

  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  console.log(
    "Selected card price:",
    await card.getByTestId("offer-card-price").textContent(),
  );

  // We pay with a NON-AutoPay card, so the review/confirmation pages should
  // show the undiscounted price: the struck-through old price if the card has
  // one (e.g. $85), otherwise the regular price (e.g. $100).
  const hasOldPrice =
    (await card.getByTestId("offer-card-old-price").count()) > 0;
  const priceSource = hasOldPrice ? "offer-card-old-price" : "offer-card-price";
  const expectedPrice = (
    await card.getByTestId(priceSource).textContent()
  ).match(/\$\d+(\.\d+)?/)[0];
  console.log("Expected monthly price:", expectedPrice);

  await card.getByTestId("offer-card-button").click();

  // ---------- get-started ----------
  await page.waitForURL(/\/get-started/);
  await expect(page.getByTestId("pgs-title")).toBeVisible();
  await expect(page.getByTestId("fgs-address-line-0")).toHaveText(
    /61 DELANCEY ST/i,
  );

  // Remember the service address lines (street, unit, city/state/zip)
  const serviceAddress = [];
  for (let i = 0; i < 3; i++) {
    serviceAddress.push(
      (await page.getByTestId(`fgs-address-line-${i}`).textContent()).trim(),
    );
  }
  console.log("Service address:", serviceAddress.join(" | "));

  const firstName = randomName();
  const lastName = randomName();
  const email = await getNextEmail(request); // next free qatest.autoNNNN
  console.log("Using:", firstName, lastName, email);

  await page.locator("#first-name").fill(firstName);
  await page.locator("#last-name").fill(lastName);

  await page.locator("#phone").pressSequentially(PHONE, { delay: 30 });
  await expect(page.locator("#phone")).toHaveValue(PHONE);

  await page.locator("#email").fill(email);

  await page.locator("#date-of-birth").pressSequentially(DOB, { delay: 30 });
  await expect(page.locator("#date-of-birth")).toHaveValue(DOB);
  await page.keyboard.press("Escape");

  await page.locator("#pin").fill(PIN);

  await page.getByTestId("pgs-submit-button").click();

  // ---------- verification-sent ----------
  await page.waitForURL(/\/verification-sent/);
  await expect(page.getByTestId("pvs-title")).toBeVisible();
  await expect(page.getByTestId("fvs-email-card")).toContainText(email);

  await page.locator("#fvs-email-code-input").fill("111111");
  await page.getByTestId("fvs-button").click();

  // Loading page: "email verified" message, then redirect to scheduling
  await expect(page.getByText(/email verified/i).first()).toBeVisible();
  await page.waitForURL(/\/scheduling/);

  // ---------- scheduling ----------
  await expect(page.getByTestId("psch-title")).toBeVisible();

  // Pick a random AVAILABLE day (skips greyed-out/disabled days, days from
  // adjacent months, and the day that is already selected)
  await page.locator("#appointment-date").click();
  const availableDays = page.locator(
    ".dp__menu .dp__cell_inner:not(.dp__cell_disabled):not(.dp__cell_offset):not(.dp__active_date)",
  );
  await expect(availableDays.first()).toBeVisible();
  const dayCount = await availableDays.count();
  console.log("Available days in this month:", dayCount);
  const dayCell = availableDays.nth(randomIndex(dayCount));
  const dayLabel = (await dayCell.textContent()).trim(); // e.g. "29"
  await dayCell.click();

  // The calendar popup can stay open and cover the time slots. In a failed run it
  // covered the "1 - 3 p.m." slot ("dp__calendar ... intercepts pointer events").
  // Close it and wait until it is gone before touching the time slots.
  const calendar = page.getByRole("dialog", { name: "Datepicker menu" });
  if (await calendar.isVisible()) await page.keyboard.press("Escape");
  if (await calendar.isVisible()) await page.getByTestId("psch-title").click(); // click outside closes it
  await expect(calendar).toBeHidden();

  await expect(page.locator("#appointment-date")).not.toHaveValue("");
  const installDate = await page.locator("#appointment-date").inputValue();
  // Report (without stopping the test) if the date shown is not the day we clicked
  expect
    .soft(installDate, `install date should be the clicked day (${dayLabel})`)
    .toMatch(new RegExp(`\\b${dayLabel},`));
  console.log("Selected install date:", installDate);

  // Pick a random AVAILABLE time slot
  const timeSlots = page
    .getByTestId("fpe-scheduling-time-selection")
    .locator("label.fpe-selection-button")
    .filter({ has: page.locator("input:not([disabled])") });
  await expect(timeSlots.first()).toBeVisible();
  const slot = timeSlots.nth(randomIndex(await timeSlots.count()));
  const installTime = (await slot.textContent()).trim();
  console.log("Selected time slot:", installTime);
  await slot.click();
  await expect(slot.locator("input")).toBeChecked();

  await page.getByTestId("psch-submit-button").click();

  // ---------- payment ----------
  await page.waitForURL(/\/payment\/enter/);
  await expect(page.locator("#fiber_heading_header")).toHaveText(
    /Enter your payment info/i,
  );
  // Payment address defaults to the service address
  await expect(page.locator("#paymentAddress_content")).toContainText(
    /61 DELANCEY ST/i,
  );

  // Card details (non-AutoPay card)
  await page.locator("#cardHolderName").fill("Test");
  await page
    .locator("#cardnumber")
    .pressSequentially("4642340000000006", { delay: 30 });
  await page.locator("#expiration").pressSequentially("12/32", { delay: 30 });
  await expect(page.locator("#expiration")).toHaveValue("12/32");
  await page.locator("#cvv").pressSequentially("123", { delay: 30 });
  await page.keyboard.press("Tab"); // blur CVV so validation runs

  // Banner: this card does NOT qualify for the AutoPay discount
  const notEligible = page.locator("#autoPay_not_Eligible");
  await expect(notEligible).toBeVisible();
  await expect(notEligible).toContainText(
    /Payment does not qualify for\s*AutoPay discount/i,
  );
  await expect(page.locator("#autoPay_Eligible")).toBeHidden();

  // For the sheet: does this payment qualify for AutoPay? (Yes/No)
  const autopay = (await page.locator("#autoPay_Eligible").isVisible())
    ? "Yes"
    : "No";

  // Agree and continue (button stays disabled until the form is valid)
  const agreeBtn = page.locator("#paymentCollection_btnContinue");
  await expect(agreeBtn).toBeEnabled();
  await agreeBtn.click();

  // ---------- review ----------
  await page.waitForURL(/\/review/);
  await expect(page.getByTestId("prev-container")).toBeVisible();

  const details = {
    price: expectedPrice,
    serviceAddress,
    name: `${firstName} ${lastName}`,
    email,
    phone: PHONE,
    installDate,
    installTime,
  };

  await verifyOrderDetails(page, details, "Total Today");

  // Agreement checkbox -> Submit order
  // The label also contains a "terms" link button, so click the label's far
  // left edge (where the box is) to avoid opening the terms instead.
  const agree = page.locator("#fpe-review-agreement-checkbox");
  const agreeLabel = page.getByTestId("fpe-review-agreement-checkbox");
  await agreeLabel.scrollIntoViewIfNeeded();
  await agreeLabel.click({ position: { x: 8, y: 8 } });
  if (!(await agree.isChecked())) {
    // Fallback: click the input itself via the DOM
    await agree.evaluate((el) => el.click());
  }
  await expect(agree).toBeChecked();

  const submit = page.getByTestId("prev-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  // ---------- confirmation ----------
  await page.waitForURL(/\/confirmation/, { timeout: 60000 });
  await expect(
    page.getByTestId("fpe-confirmation-congratulation-title"),
  ).toContainText("Thanks for your order");
  await expect
    .soft(page.getByTestId("fpe-confirmation-congratulation-description"))
    .toContainText(email);

  const orderText = await page
    .getByTestId("fpe-confirmation-order-download-title")
    .textContent();
  const orderNumber =
    (orderText.match(/Order number:\s*(\S+)/i) || [])[1] || "";
  console.log("Order number:", orderNumber);
  expect(orderNumber).toMatch(/^TMO/);

  // Same order summary as the review page, but the label is "Total paid today"
  await verifyOrderDetails(page, details, "Total paid today");

  // ---------- save test data ----------
  await saveRecord(request, {
    Environment: ENVIRONMENT,
    "First Name": firstName,
    "Last Name": lastName,
    Phone: PHONE,
    DOB,
    PIN,
    Email: email,
    Address: serviceAddress.join(", "),
    "Plan Selected": `${PLAN_NAME} - ${expectedPrice}/mo`,
    Autopay: autopay,
    "Order Number": orderNumber,
    Timestamp: new Date().toLocaleString(),
  });

  // Set PAUSE=1 to keep the browser open for inspection
  if (process.env.PAUSE) await page.pause();
});
