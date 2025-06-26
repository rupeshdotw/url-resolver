import express from "express";
import puppeteer from "puppeteer-core";
import { config as dotenv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import helmet, { referrerPolicy } from "helmet";
import rateLimit from "express-rate-limit";
import os from 'os';

dotenv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Enhanced middleware stack
app.use(helmet({
  contentSecurityPolicy: false, // Enable and customize as needed
  referrerPolicy : {
    policy: "no-referrer",
  },
})); // Security headers

// CORS (optional if frontend is same origin)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : '*';
console.log('[CORS] Allowed origins:', allowedOrigins);
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json({ limit: '20mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.RATE_LIMIT || 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/resolve', limiter);

// Region to proxy zone mapping
const regionZoneMap = {
  US: process.env.BRIGHTDATA_US_PROXY,
  CA: process.env.BRIGHTDATA_CA_PROXY,
  GB: process.env.BRIGHTDATA_GB_PROXY,
  IN: process.env.BRIGHTDATA_IN_PROXY,
  AU: process.env.BRIGHTDATA_AU_PROXY,
  DE: process.env.BRIGHTDATA_DE_PROXY,
  FR: process.env.BRIGHTDATA_FR_PROXY,
  JP: process.env.BRIGHTDATA_JP_PROXY,
  SG: process.env.BRIGHTDATA_SG_PROXY,
  BR: process.env.BRIGHTDATA_BR_PROXY,
  TW: process.env.BRIGHTDATA_TW_PROXY,
  CZ: process.env.BRIGHTDATA_CZ_PROXY,
  UA: process.env.BRIGHTDATA_UA_PROXY,
  AE: process.env.BRIGHTDATA_AE_PROXY,
  PL: process.env.BRIGHTDATA_PL_PROXY,
  ES: process.env.BRIGHTDATA_ES_PROXY,
  ID: process.env.BRIGHTDATA_ID_PROXY,
  ZA: process.env.BRIGHTDATA_ZA_PROXY,
  MX: process.env.BRIGHTDATA_MX_PROXY,
  MY: process.env.BRIGHTDATA_MY_PROXY,
};

//Make sure all proxy values exist at runtime or fail fast on startup.
Object.entries(regionZoneMap).forEach(([region, zone]) => {
    if (!zone) {
      console.warn(`⚠️ Missing proxy config for region: ${region}`);
    }
});

//Load regions
console.log("Loaded all available proxy regions:", Object.keys(regionZoneMap).filter(r => regionZoneMap[r]));

// Helper to get browser WebSocket endpoint
function getBrowserWss(regionCode) {
  const zone = regionZoneMap[regionCode?.toUpperCase()];
  const password = process.env.BRIGHTDATA_PASSWORD;

  if (!zone || !password) {
    throw new Error(`Missing proxy configuration for region: ${regionCode}`);
  }

  return `wss://${zone}:${password}@brd.superproxy.io:9222`;
}

// Main Puppeteer logic
async function resolveWithBrowserAPI(inputUrl, region = "US") {
  const browserWSEndpoint = getBrowserWss(region);
  const browser = await puppeteer.connect({ browserWSEndpoint });

  try {
    const page = await browser.newPage();

    // ✅ Set custom User-Agent before navigating
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    );

    page.setDefaultNavigationTimeout(30000);

    const timeout = process.env.NAVIGATION_TIMEOUT || 60000;
    console.log(`[INFO] Using navigation timeout: ${timeout} ms`);
    await page.goto(inputUrl, {waitUntil: "domcontentloaded", timeout: timeout });

    // Optional wait
    const newTimeout = process.env.PAGE_WAIT_SELECTOR || 30000;
    console.log(`[INFO] Wait For Selector Timout: ${newTimeout} ms`)
    await page.waitForSelector("body", {timeout: newTimeout});

    // Get resolved final URL
    const finalUrl = page.url();

    // Detect IP info from inside the browser
    const ipData = await page.evaluate(async () => {
      try {
        const res = await fetch("https://ipapi.co/json/");
        return await res.json(); // { ip, country_name, region, city, etc. }
      } catch (e) {
        return { error: "IP lookup failed" };
      }
    });
    return { finalUrl, ipData };
  } finally {
    //await browser.close();
    await browser.disconnect();
  }
}

// API route: /resolve
app.get("/resolve", async (req, res) => {
  const { url: inputUrl, region = "US" } = req.query;

  if (!inputUrl) {
    return res.status(400).json({ error: "Missing URL parameter" });
  }

  try {
    new URL(inputUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  console.log(`🌐 Resolving URL for region [${region}]:`, inputUrl);

  try {
    const { finalUrl, ipData } = await resolveWithBrowserAPI(inputUrl, region);

    console.log("⌛ Requesting new URL")
    console.log(`→ Original URL: ${inputUrl}`);
    console.log(`→ Final URL   : ${finalUrl}`);
    console.log(`→ URLs Resolved with [${region}] Check IP Data ⤵`);
    if (ipData?.ip) {
        console.log(`🌍 IP Info : ${ipData.ip} (${ipData.country_name || "Unknown"} - ${ipData.country_code || "N/A"})`);
        console.log(`🔍 Region Match: ${ipData.country_code?.toUpperCase() === region.toUpperCase() ? '✅ YES' : '❌ NO'}`);
    }

    return res.json({
      originalUrl: inputUrl,
      finalUrl,
      region,
      requestedRegion: region,
      actualRegion: ipData?.country_code?.toUpperCase() || 'Unknown',
      regionMatch: ipData?.country_code?.toUpperCase() === region.toUpperCase(),
      method: "browser-api",
      hasClickId: finalUrl.includes("clickid="),
      hasClickRef: finalUrl.includes("clickref="),
      hasUtmSource: finalUrl.includes("utm_source="),
      hasImRef: finalUrl.includes("im_ref="),
      hasMtkSource: finalUrl.includes("mkt_source="),
      hasTduId: finalUrl.includes("tduid="),
      ipData // Region detection info
    });
  } catch (err) {
    console.error("❌ Resolution failed:", err.stack, err.message);
    return res.status(500).json({ error: "❌ Resolution failed", details: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Regions check
app.get("/regions", (req, res) => {
  res.json(Object.keys(regionZoneMap));
});

app.get("/health-check", (req, res) => {
  const memoryUsage = process.memoryUsage();
  const uptime = process.uptime();
  const loadAverage = os.loadavg();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  const healthCheck = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptime)} seconds`,
    memory: {
      rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`,
    },
    loadAverage: {
      "1m": loadAverage[0].toFixed(2),
      "5m": loadAverage[1].toFixed(2),
      "15m": loadAverage[2].toFixed(2),
    },
    memoryStats: {
      total: `${(totalMemory / 1024 / 1024).toFixed(2)} MB`,
      free: `${(freeMemory / 1024 / 1024).toFixed(2)} MB`,
    },
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0].model,
    },
    healthy: freeMemory / totalMemory > 0.1 && loadAverage[0] < os.cpus().length,
  };

  res.status(200).json(healthCheck);
});

// Fallback for homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Region-aware resolver running at http://localhost:${PORT}`);
});