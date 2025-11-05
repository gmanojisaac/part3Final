import { fyersModel as FyersAPI } from "fyers-api-v3";
import open from "opn";
import dotenv from "dotenv";
import fs from "fs";
import readline from "readline";

dotenv.config();

const APP_ID = process.env.FYERS_APP_ID || "R3PYOUE8EO-100";
const SECRET_KEY = process.env.FYERS_APP_SECRET || "O785RGL68DDecide";
const REDIRECT_URI =
  process.env.FYERS_REDIRECT_URI ||
  "http://localhost:3000/auth/fyers/callback";
const ENV_PATH = ".env";

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("🔧 Initializing Fyers authentication...");

  const fyers = new FyersAPI({ path: "./fyers_logs" });

  // Step 1: Set app credentials
  fyers.setAppId(APP_ID);
  fyers.setRedirectUrl(REDIRECT_URI);

  // Step 2: Generate the login URL
  const authUrl = fyers.generateAuthCode();
  console.log("\n🌐 Opening Fyers login page...");
  console.log(authUrl);

  // Step 3: Open in browser
  try {
    await open(authUrl);
  } catch (err) {
    console.log("⚠️  Could not open browser automatically. Open manually:");
    console.log(authUrl);
  }

  // Step 4: Prompt user for auth_code
  const auth_code = await promptUser("\n📋 Paste your auth_code from redirect URL: ");

  if (!auth_code) {
    console.error("❌ No auth_code provided. Exiting...");
    process.exit(1);
  }

  // Step 5: Generate access token
  console.log("\n🔑 Generating access token...");
  try {
    const response = await fyers.generate_access_token({
      secret_key: SECRET_KEY,
      auth_code: auth_code,
    });

    if (!response || !response.access_token) {
      console.error("❌ Failed to get access token:", response);
      return;
    }

    const accessToken = response.access_token;
    console.log("✅ Access token generated successfully!");

    // Step 6: Save token to .env
    let envContent = "";
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, "utf8");
      if (envContent.includes("FYERS_ACCESS_TOKEN=")) {
        envContent = envContent.replace(
          /FYERS_ACCESS_TOKEN=.*/g,
          `FYERS_ACCESS_TOKEN=${accessToken}`
        );
      } else {
        envContent += `\nFYERS_ACCESS_TOKEN=${accessToken}\n`;
      }
    } else {
      envContent = `FYERS_ACCESS_TOKEN=${accessToken}\n`;
    }

    fs.writeFileSync(ENV_PATH, envContent);
    console.log(`📝 Access token saved to ${ENV_PATH}`);

  } catch (error: any) {
    console.error("❌ Error generating token:", error.response?.data || error);
  }
}

main();
