// checkProfileAfterLogin.ts
import dotenv from "dotenv";
dotenv.config();

// Import the SDK (CommonJS style import works best for v3)
const { fyersModel: FyersAPI } = require("fyers-api-v3");

// Create instance with optional log path
const fyers = new FyersAPI({ path: "./fyers_logs" });

// Set up your credentials (from .env)
const APP_ID = process.env.FYERS_APP_ID || "R3PYOUE8EO-100";
const REDIRECT_URL =
  process.env.FYERS_REDIRECT_URI || "http://localhost:3000/auth/fyers/callback";
const ACCESS_TOKEN = process.env.FYERS_ACCESS_TOKEN;

// 1️⃣ Required by SDK: App ID & Redirect URL
fyers.setAppId(APP_ID);
fyers.setRedirectUrl(REDIRECT_URL);

// 2️⃣ Set access token from your last login (auth.ts)
fyers.setAccessToken(ACCESS_TOKEN);

// 3️⃣ Fetch profile
fyers
  .get_profile()
  .then((response: any) => {
    console.log("✅ Profile information:\n", JSON.stringify(response, null, 2));
  })
  .catch((error: any) => {
    console.error("❌ Error getting profile:", error);
  });
