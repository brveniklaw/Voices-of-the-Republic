require("dotenv").config();
const express    = require("express");
const { Pool }   = require("pg");
const Stripe     = require("stripe");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const path       = require("path");
const fs         = require("fs");
const cors       = require("cors");

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
const pool   = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TRIAL_DAYS    = parseInt(process.env.TRIAL_DAYS || "7");
const PAID_DATE     = new Date(process.env.PAID_DATE || "2026-07-04");
const CONSUMER_PRICE = 999; // $9.99 in cents

// Is the global paid wall active? (July 4th or later)
const isPaidWallActive = () => new Date() >= PAID_DATE;

// Does a user's 7-day trial still have time?
const isTrialActive = (trialStarted) => {
  if (!trialStarted) return false;
  const expiry = new Date(trialStarted);
  expiry.setDate(expiry.getDate() + TRIAL_DAYS);
  return new Date() < expiry;
};

const trialExpiresAt = (trialStarted) => {
  const expiry = new Date(trialStarted);
  expiry.setDate(expiry.getDate() + TRIAL_DAYS);
  return expiry;
};

// ── EMAIL ─────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) return;
  try {
    await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, html });
  } catch (e) { console.error("Email error:", e.message); }
}

// ── DB INIT ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id               SERIAL PRIMARY KEY,
      name             VARCHAR(255),
      email            VARCHAR(255) UNIQUE NOT NULL,
      access_token     VARCHAR(255) UNIQUE,
      type             VARCHAR(50)  DEFAULT 'trial',
      paid             BOOLEAN      DEFAULT false,
      trial_started_at TIMESTAMP    DEFAULT NOW(),
      stripe_session   VARCHAR(255),
      stripe_customer  VARCHAR(255),
      notified_expiry  BOOLEAN      DEFAULT false,
      notified_paid    BOOLEAN      DEFAULT false,
      created_at       TIMESTAMP    DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_inquiries (
      id             SERIAL PRIMARY KEY,
      contact_name   VARCHAR(255) NOT NULL,
      contact_email  VARCHAR(255) NOT NULL,
      institution    VARCHAR(255),
      inst_type      VARCHAR(50),
      size           INTEGER,
      tier_key       VARCHAR(50),
      annual_fee     DECIMAL(10,2),
      message        TEXT,
      status         VARCHAR(50) DEFAULT 'new',
      created_at     TIMESTAMP   DEFAULT NOW()
    )
  `);
  console.log("✅ Database initialized");
}

// ── STATIC FILE HELPER ────────────────────────────────────────────────────────
function serveFile(filename) {
  return (_, res) => {
    const locations = [
      path.join(__dirname, filename),
      path.join(__dirname, "public", filename),
      path.join(process.cwd(), filename),
      path.join(process.cwd(), "public", filename),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) return res.sendFile(loc);
    }
    res.status(404).send(`
      <html><body style="background:#06091A;color:#F0E8D8;font-family:monospace;padding:40px">
        <h2 style="color:#B8202E">File not found: ${filename}</h2>
        <p>Files in project: ${fs.readdirSync(__dirname).join(", ")}</p>
      </body></html>
    `);
  };
}

// ── STRIPE WEBHOOK (raw body — must be before express.json) ───────────────────
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email   = session.customer_email || session.customer_details?.email;
    const token   = uuidv4();
    try {
      await pool.query(
        `INSERT INTO subscribers (email, access_token, type, paid, stripe_session, stripe_customer)
         VALUES ($1,$2,'paid',true,$3,$4)
         ON CONFLICT (email) DO UPDATE
           SET paid=true, access_token=$2, stripe_session=$3, stripe_customer=$4, type='paid'`,
        [email, token, session.id, session.customer]
      );
      await sendEmail(email, "Welcome to Voices of the Republic 🇺🇸 — Lifetime Access Confirmed", `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#06091A;color:#F0E8D8;padding:48px;border-top:4px solid #B8202E">
          <h1 style="color:#F5EDD8">Welcome, Patriot.</h1>
          <p style="font-size:18px;line-height:1.8;color:rgba(240,232,216,0.85)">Your <strong>lifetime access</strong> to Voices of the Republic is confirmed. Ask any of the six Founding Fathers anything — grounded in primary sources.</p>
          <a href="${process.env.BASE_URL || ""}/app?token=${token}" style="display:inline-block;background:#B8202E;color:#fff;padding:16px 40px;text-decoration:none;font-size:14px;margin-top:24px">Launch the App →</a>
          <p style="font-size:12px;color:rgba(240,232,216,0.3);margin-top:32px">Powered by IntexiaU</p>
        </div>
      `);
    } catch (e) { console.error("Post-payment error:", e.message); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, ".")));

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── API: ACCESS MODE ──────────────────────────────────────────────────────────
app.get("/api/access-mode", (req, res) => {
  res.json({
    paidWallActive: isPaidWallActive(),
    paidDate:       PAID_DATE.toISOString(),
    trialDays:      TRIAL_DAYS,
    price:          CONSUMER_PRICE,
  });
});

// ── API: REGISTER (start 7-day trial) ─────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { name, email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required." });

  const token = uuidv4();
  const now   = new Date();

  try {
    // Check if already registered
    const existing = await pool.query("SELECT * FROM subscribers WHERE email=$1", [email.toLowerCase().trim()]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      // Already paid — just return their token
      if (user.paid) return res.json({ success: true, token: user.access_token, type: "paid" });
      // Trial still active — return existing token
      if (isTrialActive(user.trial_started_at)) {
        const expiry = trialExpiresAt(user.trial_started_at);
        return res.json({ success: true, token: user.access_token, type: "trial", expiresAt: expiry.toISOString() });
      }
      // Trial expired — prompt payment
      return res.json({ success: false, trialExpired: true, email: user.email });
    }

    // New user — start trial
    await pool.query(
      `INSERT INTO subscribers (name, email, access_token, type, paid, trial_started_at)
       VALUES ($1,$2,$3,'trial',false,$4)`,
      [name || null, email.toLowerCase().trim(), token, now]
    );

    const expiry = trialExpiresAt(now);

    // Welcome email
    await sendEmail(email, "🇺🇸 Your 7-Day Free Trial — Voices of the Republic", `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#06091A;color:#F0E8D8;padding:48px;border-top:4px solid #B8202E">
        <h1 style="color:#F5EDD8;font-size:26px">Welcome, ${name || "Patriot"}!</h1>
        <p style="font-size:18px;line-height:1.8;color:rgba(240,232,216,0.85)">
          Your <strong>7-day free trial</strong> of Voices of the Republic has begun — in honor of America's 250th Birthday.
        </p>
        <p style="font-size:16px;color:rgba(240,232,216,0.7)">Trial expires: <strong style="color:#B8202E">${expiry.toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}</strong></p>
        <a href="${process.env.BASE_URL || ""}/app?token=${token}" style="display:inline-block;background:#B8202E;color:#fff;padding:16px 40px;text-decoration:none;font-size:14px;margin-top:24px">Launch the App →</a>
        <p style="font-size:14px;color:rgba(240,232,216,0.5);margin-top:32px">
          ★ After your trial, lifetime access is just <strong>$9.99</strong>. We'll remind you before it ends.
        </p>
        <p style="font-size:12px;color:rgba(240,232,216,0.25);margin-top:24px">Powered by IntexiaU</p>
      </div>
    `);

    res.json({ success: true, token, type: "trial", expiresAt: expiry.toISOString() });
  } catch (e) {
    console.error("Register error:", e.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// ── API: VERIFY TOKEN ─────────────────────────────────────────────────────────
app.post("/api/verify-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ valid: false });
  try {
    const result = await pool.query("SELECT * FROM subscribers WHERE access_token=$1", [token]);
    if (result.rows.length === 0) return res.json({ valid: false });
    const user = result.rows[0];
    if (user.paid) return res.json({ valid: true, type: "paid", name: user.name });
    if (isTrialActive(user.trial_started_at)) {
      const expiry = trialExpiresAt(user.trial_started_at);
      return res.json({ valid: true, type: "trial", name: user.name, expiresAt: expiry.toISOString() });
    }
    // Trial expired
    return res.json({ valid: false, trialExpired: true, email: user.email });
  } catch (e) {
    res.json({ valid: false });
  }
});

// ── API: STRIPE CHECKOUT ──────────────────────────────────────────────────────
app.post("/api/checkout", async (req, res) => {
  const { email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: "Voices of the Republic — Lifetime Access",
            description: "Ask the Founding Fathers anything. All 6 Founders, Federalist Papers + Constitution decoded. Primary sources only.",
          },
          unit_amount: CONSUMER_PRICE,
        },
        quantity: 1,
      }],
      success_url: `${process.env.BASE_URL || ""}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.BASE_URL || ""}/app`,
      metadata:    { product: "voices_republic_lifetime" },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout error:", e.message);
    res.status(500).json({ error: "Payment session failed. Please try again." });
  }
});

// ── API: LICENSE INQUIRY ──────────────────────────────────────────────────────
app.post("/api/license-inquiry", async (req, res) => {
  const { contact_name, contact_email, institution, inst_type, size, tier_key, message } = req.body;
  if (!contact_email || !contact_name) return res.status(400).json({ error: "Name and email required." });
  const TIERS = {
    edu_classroom: 199, edu_school: 799, edu_district: 2499,
    org_small: 299, org_mid: 699, org_large: 1499,
  };
  const annual_fee = TIERS[tier_key] || null;
  try {
    await pool.query(
      `INSERT INTO license_inquiries (contact_name,contact_email,institution,inst_type,size,tier_key,annual_fee,message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [contact_name, contact_email, institution||null, inst_type||null, size||null, tier_key||null, annual_fee, message||null]
    );
    await sendEmail(process.env.FROM_EMAIL || process.env.SMTP_USER, `🏛️ License Inquiry — ${institution || contact_name}`,
      `<div style="font-family:Georgia;padding:32px"><h2>New License Inquiry</h2>
       <p><strong>Contact:</strong> ${contact_name} (${contact_email})</p>
       <p><strong>Institution:</strong> ${institution||"N/A"}</p>
       <p><strong>Tier:</strong> ${tier_key||"N/A"} — ${annual_fee ? "$"+annual_fee+"/yr" : "Custom"}</p>
       <p><strong>Message:</strong> ${message||"None"}</p></div>`
    );
    await sendEmail(contact_email, "We received your license inquiry — Voices of the Republic", `
      <div style="font-family:Georgia;max-width:600px;margin:0 auto;background:#06091A;color:#F0E8D8;padding:48px;border-top:4px solid #B8202E">
        <h1 style="color:#F5EDD8">Thank you, ${contact_name}.</h1>
        <p style="font-size:17px;line-height:1.8;color:rgba(240,232,216,0.8)">We've received your license inquiry and will be in touch within 1–2 business days.</p>
        <p style="font-size:12px;color:rgba(240,232,216,0.3);margin-top:32px">IntexiaU · Voices of the Republic</p>
      </div>
    `);
    res.json({ success: true });
  } catch (e) {
    console.error("License inquiry error:", e.message);
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const [total, paid, trial, licenses] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM subscribers"),
    pool.query("SELECT COUNT(*) FROM subscribers WHERE paid=true"),
    pool.query("SELECT COUNT(*) FROM subscribers WHERE paid=false"),
    pool.query("SELECT COUNT(*) FROM license_inquiries"),
  ]);
  res.json({
    total_subscribers: parseInt(total.rows[0].count),
    paid_users:        parseInt(paid.rows[0].count),
    trial_users:       parseInt(trial.rows[0].count),
    license_inquiries: parseInt(licenses.rows[0].count),
    paid_wall_active:  isPaidWallActive(),
    paid_date:         PAID_DATE.toISOString(),
    trial_days:        TRIAL_DAYS,
  });
});

app.get("/api/admin/subscribers", adminAuth, async (req, res) => {
  const result = await pool.query("SELECT id,name,email,type,paid,trial_started_at,created_at FROM subscribers ORDER BY created_at DESC");
  res.json({ count: result.rows.length, subscribers: result.rows });
});

app.get("/api/admin/licenses", adminAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM license_inquiries ORDER BY created_at DESC");
  res.json({ count: result.rows.length, inquiries: result.rows });
});

app.post("/api/admin/notify-paid-launch", adminAuth, async (req, res) => {
  const result = await pool.query("SELECT email,name FROM subscribers WHERE paid=false AND notified_paid=false");
  let sent = 0;
  for (const user of result.rows) {
    await sendEmail(user.email, "🇺🇸 Voices of the Republic — Get Lifetime Access for $9.99", `
      <div style="font-family:Georgia;max-width:600px;margin:0 auto;background:#06091A;color:#F0E8D8;padding:48px;border-top:4px solid #B8202E">
        <h1 style="color:#F5EDD8">The 250th Anniversary is Here.</h1>
        <p style="font-size:17px;line-height:1.8;color:rgba(240,232,216,0.85)">Dear ${user.name||"Patriot"},<br/><br/>
        Lock in <strong>lifetime access</strong> to Voices of the Republic for just <strong>$9.99</strong>.</p>
        <a href="${process.env.BASE_URL||""}/app" style="display:inline-block;background:#B8202E;color:#fff;padding:18px 48px;text-decoration:none;font-size:14px;margin-top:24px">Get Lifetime Access — $9.99 →</a>
        <p style="font-size:12px;color:rgba(240,232,216,0.3);margin-top:32px">IntexiaU</p>
      </div>
    `);
    await pool.query("UPDATE subscribers SET notified_paid=true WHERE email=$1", [user.email]);
    sent++;
  }
  res.json({ success: true, sent });
});

// ── PAGES ─────────────────────────────────────────────────────────────────────
app.get("/",        serveFile("index.html"));
app.get("/app",     serveFile("app.html"));
app.get("/pricing", serveFile("pricing.html"));
app.get("/success", serveFile("success.html"));
app.get("/admin",   serveFile("admin.html"));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🇺🇸 Voices of the Republic running on port ${PORT}`));
}).catch(err => { console.error("DB init failed:", err); process.exit(1); });
