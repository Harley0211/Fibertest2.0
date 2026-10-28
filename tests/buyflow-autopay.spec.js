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

// Google Sheet logging (set in your .env file)
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const SHEET_SECRET = process.env.SHEET_SECRET;
const CSV_PATH = "account-log.csv";

// Fixed test data
const PHONE = "555-555-5555";
const DOB = "01/01/2001";
const PIN = "123654";
const PLAN_NAME = "Fiber 1 Gig (1000 Mbps)";

// Debit card that QUALIFIES for the AutoPay discount
const CARD = {
  name: "test",
  number: "4132340000000003",
  exp: "12/32",
  cvv: "123",
};

// Green used by the success banner (#E6FCE8) and the check icon (#008110)
const GREEN_BG = "rgb(230, 252, 232)";
const GREEN_ICON = "#008110";

// ---------- helpers ----------
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
// "Used" = any qatest.autoNNNN email found in the Google Sheet or in the
// local account-log.csv backup. Picks the lowest number not used yet.
async function getNextEmail(request) {
  const used = new Set();
  const collect = (text) => {
    for (const m of text.matchAll(/qatest\.auto(\d+)@lotusflare\.com/gi)) {
      used.add(Number(m[1]));
    }
  };

  if (SHEET_WEBHOOK_URL) {
    try {
      const res = await request.post(SHEET_WEBHOOK_URL, {
        data: { secret: SHEET_SECRET, action: "listEmails" },
      });
      const body = await res.json();
      if (body.ok) {
        collect(body.emails.join("\n"));
        console.log(`Emails already used in the sheet: ${body.emails.length}`);
      } else {
        console.warn("Could not read emails from the sheet:", body.error);
      }
    } catch (err) {
      console.warn("Could not read emails from the sheet:", err.message);
    }
  } else {
    console.warn("SHEET_WEBHOOK_URL not set - checking local CSV only.");
  }

  if (fs.existsSync(CSV_PATH)) collect(fs.readFileSync(CSV_PATH, "utf8"));

  let n = 1;
  while (used.has(n)) n++;
  return `qatest.auto${String(n).padStart(4, "0")}@lotusflare.com`;
}

// Success banner must be visible and green (soft: records a failure, keeps going)
async function expectGreenBanner(banner, label) {
  const shown = await banner.waitFor({ state: "visible", timeout: 10000 }).then(
    () => true,
    () => false,
  );
  expect.soft(shown, `${label}: green banner should be visible`).toBe(true);
  if (!shown) return;

  const bg = await banner.evaluate((el) => {
    const isSet = (c) => c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
    // element itself, then its children, then its parent
    for (const node of [el, ...el.querySelectorAll("*"), el.parentElement]) {
      if (node && isSet(getComputedStyle(node).backgroundColor)) {
        return getComputedStyle(node).backgroundColor;
      }
    }
    return "transparent";
  });
  expect.soft(bg, `${label}: banner background should be green`).toBe(GREEN_BG);
}

// Same order-summary layout is used on /review and /confirmation.
// Soft assertions: every mismatch is reported, not just the first.
async function verifyOrderDetails(page, d, totalTodayLabel) {
  const t = (id) => page.getByTestId(id);

  // Plan: list price struck through + discounted price
  await expect.soft(t("faco-name-and-speed")).toContainText(PLAN_NAME);
  await expect.soft(t("faco-old-price")).toHaveText(d.listPrice);
  await expect.soft(t("faco-new-price")).toHaveText(`${d.discountedPrice}/mo`);

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
  await expect.soft(t("facc-number")).toContainText(CARD.number.slice(-4));
  await expect.soft(t("facc-exp")).toHaveText(`Exp ${CARD.exp}`);

  // Totals: Total today + Due Monthly (list price struck, promo price)
  await expect.soft(t("ftic-deposit")).toContainText(totalTodayLabel);
  await expect.soft(t("ftic-deposit")).toContainText("$0");
  await expect.soft(t("ftic-period-0")).toContainText("Due Monthly");
  await expect.soft(t("ftic-price-0")).toContainText(`${d.listPrice}/mo`);
  await expect.soft(t("ftic-price-0")).toContainText(`${d.discountedPrice}/mo`);
}

// "Payment qualifies for ... discount." message with its green check icon.
// The exact text differs per page, so it is passed in:
//   /review        -> "Payment qualifies for AutoPay discount."
//   /confirmation  -> "Payment qualifies for Autopay discount."
async function verifyAutopayPaymentMessage(page, label, expectedText) {
  await expect
    .soft(page.getByTestId("facp-autopay-message"), `${label}: AutoPay message`)
    .toContainText(expectedText);

  const icon = page.getByTestId("facp-autopay-icon");
  await expect
    .soft(icon, `${label}: check icon should be visible`)
    .toBeVisible();
  await expect
    .soft(icon.locator("path").first(), `${label}: check icon should be green`)
    .toHaveAttribute("fill", GREEN_ICON);
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
  const csvLine = SHEET_COLUMNS.map(
    (c) => `"${String(record[c]).replace(/"/g, '""')}"`,
  ).join(",");
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, SHEET_COLUMNS.join(",") + "\n");
  }
  fs.appendFileSync(CSV_PATH, csvLine + "\n");
  console.log("Saved to", CSV_PATH);

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

test("unassisted buyflow - AutoPay", async ({ page, request }) => {
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

  // AutoPay flow: the 1 Gig card WITH pricing rules (old price + AutoPay price)
  const card = page
    .locator(".fiber-offer-card-container")
    .filter({
      has: page
        .getByTestId("fiber-offer-card-banner-message")
        .filter({ hasText: /^Fiber 1 Gig$/ }),
    })
    .filter({ has: page.getByTestId("offer-card-pricing-rule") });

  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();

  // e.g. "$85$75/month" -> list price "$85", discounted price "$75"
  const priceText = await card.getByTestId("offer-card-price").textContent();
  const prices = priceText.match(/\$\d+(\.\d+)?/g) || [];
  expect(prices, "offer card should show old + discounted price").toHaveLength(
    2,
  );
  const listPrice = prices[0];
  const discountedPrice = prices[prices.length - 1];
  console.log(`Offer card: list ${listPrice}, with AutoPay ${discountedPrice}`);

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

  // Card details (AutoPay-eligible debit card)
  await page.locator("#cardHolderName").fill(CARD.name);
  await page
    .locator("#cardnumber")
    .pressSequentially(CARD.number, { delay: 30 });
  await page.locator("#expiration").pressSequentially(CARD.exp, { delay: 30 });
  await expect(page.locator("#expiration")).toHaveValue(CARD.exp);
  await page.locator("#cvv").pressSequentially(CARD.cvv, { delay: 30 });
  await page.keyboard.press("Tab"); // blur CVV so validation runs

  // AutoPay toggle is on, and below it: green check icon + qualifies message
  await expect(page.locator("#autopayToggleSwitch")).toBeChecked();

  const eligible = page.locator("#autoPay_Eligible");
  await expect(eligible).toBeVisible();
  await expect(eligible.locator("svg")).toBeVisible(); // check icon
  await expect(eligible.locator("svg path")).toHaveAttribute(
    "fill",
    GREEN_ICON,
  );
  await expect(eligible).toContainText(
    /Payment qualifies for Autopay discount/i,
  );
  await expect(page.locator("#autoPay_not_Eligible")).toBeHidden();

  // The message sits BELOW the "Enroll in AutoPay" toggle
  const toggleBox = await page.locator("#toggleLabel").boundingBox();
  const messageBox = await eligible.boundingBox();
  expect(messageBox.y, "message should be below the toggle").toBeGreaterThan(
    toggleBox.y,
  );

  // For the sheet
  const autopay = "Yes";

  // Agree and continue (button stays disabled until the form is valid)
  const agreeBtn = page.locator("#paymentCollection_btnContinue");
  await expect(agreeBtn).toBeEnabled();
  await agreeBtn.click();

  // ---------- review ----------
  await page.waitForURL(/\/review/);
  await expect(page.getByTestId("prev-container")).toBeVisible();

  // Green banner at the top with the AutoPay text (check right away: it can be dismissed)
  const reviewBanner = page.getByTestId("fpe-notification-banner-page");
  await expectGreenBanner(reviewBanner, "Review");
  await expect
    .soft(page.getByTestId("fpe-notification-banner-page-title"))
    .toContainText(/AutoPay discount has been applied/i);
  await expect
    .soft(page.getByTestId("fpe-notification-banner-page-icon"))
    .toHaveAttribute("color", GREEN_ICON);

  // Plan section: AutoPay enabled + the $10 AutoPay discount rule
  await expect
    .soft(page.getByTestId("prev-offer-info"))
    .toHaveAttribute("isautopayenabled", "true");
  await expect
    .soft(page.getByTestId("review-rule-item-0"))
    .toContainText("$10 discount when you sign up with Fiber AutoPay");

  // Payment info section: billed with AutoPay + qualifies message
  await expect
    .soft(page.getByTestId("summary-modal-fees-card"))
    .toContainText("Billed monthly with AutoPay");
  await verifyAutopayPaymentMessage(
    page,
    "Review",
    "Payment qualifies for AutoPay discount.",
  );

  const details = {
    listPrice,
    discountedPrice,
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
  expect.soft(orderNumber).toMatch(/^TMO/);

  // Same order summary as the review page, but the label is "Total paid today"
  await verifyOrderDetails(page, details, "Total paid today");

  // AutoPay: "Payment qualifies for Autopay discount." with the green check
  // (there is no green banner on the confirmation page)
  await verifyAutopayPaymentMessage(
    page,
    "Confirmation",
    "Payment qualifies for Autopay discount.",
  );

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
    "Plan Selected": `${PLAN_NAME} - ${discountedPrice}/mo`,
    Autopay: autopay,
    "Order Number": orderNumber,
    Timestamp: new Date().toLocaleString(),
  });

  // Set PAUSE=1 to keep the browser open for inspection
  if (process.env.PAUSE) await page.pause();
});
