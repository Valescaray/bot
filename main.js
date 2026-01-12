require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { message } = require("telegraf/filters");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.use(express.json());
const bot = new Telegraf(process.env.BOT_TOKEN);

let previousVacancies = [];
let lastUpdateTime = Date.now();
let intervalTime = 40000; // Default interval (47 seconds)
let checkInterval;
let  updatesToday  = 0;

let notificationQueue = [];
let isProcessing = false;

const WEBHOOK_PATH = "/webhook";
const WEBHOOK_URL = `${process.env.APP_URL}${WEBHOOK_PATH}`; // APP_URL must be set in .env

// Store credentials securely (use environment variables)
const credentials = {
  email: process.env.USER_EMAIL,
  password: process.env.USER_PASSWORD,
};

// Telegram configuration for OTP
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

class TokenManager {
  constructor(bot) {
    this.token = null;
    this.expiry = null;
    this.loginUrl = 'https://api.housemanship.mdcn.gov.ng/api/login.php';
    this.otpUrl = 'https://api.housemanship.mdcn.gov.ng/api/verify_otp.php';
    this.bot = bot;
    this.otpPromiseResolve = null;
    
    if (this.bot) {
      this.setupTelegramListeners();
    }
  }

  setupTelegramListeners() {
    // Command: /status
    this.bot.command('status', async (ctx) => {
      if (ctx.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
      await this.sendTokenStatus(ctx);
    });

    // Command: /test
    this.bot.command('test', async (ctx) => {
      if (ctx.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
      await this.runTest(ctx);
    });

    // Command: /refresh
    this.bot.command('refresh', async (ctx) => {
      if (ctx.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
      await this.forceRefreshToken(ctx);
    });

    // Command: /help
    this.bot.command('help', async (ctx) => {
      if (ctx.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
      await this.sendHelpMessage(ctx);
    });

    // Listen for OTP (6-digit numbers)
    this.bot.on('text', async (ctx) => {
      if (ctx.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
      
      const text = ctx.message.text;
      
      // Ignore commands
      if (text.startsWith('/')) return;
      
      // Check if it's a 6-digit OTP
      if (/^\d{6}$/.test(text) && this.otpPromiseResolve) {
        console.log('✅ OTP received from Telegram:', text);
        await ctx.reply('✅ OTP received! Verifying...');
        this.otpPromiseResolve(text);
        this.otpPromiseResolve = null;
      }
    });

    console.log('✅ Telegram bot commands registered');
  }

  async sendHelpMessage(ctx) {
    const message = `
📚 *Available Commands*

*/status* - Check authentication status
- Shows if tokens are valid
- Displays expiry times
- Shows configuration status

*/test* - Test API connection
- Attempts to fetch vacancies
- Shows if authentication works
- Displays sample results

*/refresh* - Force token refresh
- Clears cached token
- Requests new authentication
- May require OTP input

*/help* - Show this help message

*OTP Authentication:*
When OTP is required, I'll send you a message. Simply reply with the 6-digit code.

*Status:*
- ✅ = Working correctly
- ⚠️ = Warning/needs attention
- ❌ = Error/not configured
    `;

    await ctx.replyWithMarkdown(message);
  }

  async sendTokenStatus(ctx) {
    let message = '🔍 *Token Status Check*\n\n';

    // Check TokenManager
    if (credentials.email && credentials.password) {
      message += '✅ *Automatic Authentication*\n';
      message += `   📧 Email: ${credentials.email}\n`;

      if (this.token && this.expiry) {
        const expiresIn = (this.expiry - Date.now()) / 1000 / 60;
        if (expiresIn > 0) {
          const hours = Math.floor(expiresIn / 60);
          const minutes = Math.floor(expiresIn % 60);
          message += `   ✅ Token valid: ${hours}h ${minutes}m remaining\n`;
          message += `   ⏰ Expires: ${new Date(this.expiry).toLocaleString()}\n`;
        } else {
          message += `   ❌ Token expired ${Math.abs(Math.floor(expiresIn))} minutes ago\n`;
        }
      } else {
        message += '   ℹ️ No cached token (will authenticate on next request)\n';
      }

      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        message += '   ✅ Telegram OTP configured\n';
      } else {
        message += '   ⚠️ Telegram OTP NOT configured\n';
      }
    } else {
      message += '⚠️ *Automatic Authentication*: NOT configured\n';
    }

    message += '\n';

    // Check manual token
    if (process.env.JWT_TOKEN) {
      message += '✅ *Manual JWT_TOKEN*: Found\n';
      try {
        const payload = JSON.parse(
          Buffer.from(process.env.JWT_TOKEN.split('.')[1], 'base64')
        );
        const expiresIn = (payload.exp * 1000 - Date.now()) / 1000 / 60;

        if (expiresIn > 0) {
          const hours = Math.floor(expiresIn / 60);
          const minutes = Math.floor(expiresIn % 60);
          message += `   ✅ Valid: ${hours}h ${minutes}m remaining\n`;
        } else {
          message += `   ❌ Expired ${Math.abs(Math.floor(expiresIn))} minutes ago\n`;
        }
      } catch (e) {
        message += '   ⚠️ Could not parse token\n';
      }
    } else {
      message += '⚠️ *Manual JWT_TOKEN*: NOT found\n';
    }

    await ctx.replyWithMarkdown(message);
  }

  async runTest(ctx) {
    await ctx.reply('🧪 Running API test...');

    try {
      const startTime = Date.now();
      const vacancies = await getVacancies();
      const duration = Date.now() - startTime;

      let message = '✅ *Test Successful!*\n\n';
      message += `⏱️ Response time: ${duration}ms\n`;
      message += `📊 Vacancies found: ${vacancies?.length || 0}\n`;

      if (vacancies && vacancies.length > 0) {
        message += '\n📋 *Sample Vacancy:*\n';
        const sample = vacancies[0];
        message += `• Hospital: ${sample.centerName || 'N/A'}\n`;
        message += `• Slots: ${sample.officer_left || 'N/A'}\n`;
        
        if (vacancies.length > 1) {
          message += `\n_...and ${vacancies.length - 1} more_`;
        }
      }

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      let errorMessage = '❌ *Test Failed*\n\n';
      errorMessage += `Error: ${error.message}\n\n`;
      errorMessage += '💡 *Suggestions:*\n';
      errorMessage += '• Check /status for token validity\n';
      errorMessage += '• Try /refresh to get a new token\n';
      errorMessage += '• Ensure credentials are correct\n';

      await ctx.replyWithMarkdown(errorMessage);
    }
  }

  async forceRefreshToken(ctx) {
    await ctx.reply('🔄 Forcing token refresh...');

    try {
      // Clear existing token
      this.token = null;
      this.expiry = null;

      // Request new token
      await this.refreshToken();

      let message = '✅ *Token Refreshed Successfully!*\n\n';
      const expiresIn = (this.expiry - Date.now()) / 1000 / 60;
      const hours = Math.floor(expiresIn / 60);
      const minutes = Math.floor(expiresIn % 60);
      
      message += `⏰ New token valid for: ${hours}h ${minutes}m\n`;
      message += `📅 Expires: ${new Date(this.expiry).toLocaleString()}\n`;

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      await ctx.replyWithMarkdown(
        `❌ *Refresh Failed*\n\nError: ${error.message}`
      );
    }
  }

  async getToken() {
    // Check if current token is still valid (with 1 hour buffer)
    if (this.token && this.expiry - Date.now() > 3600000) {
      return this.token;
    }

    // Token expired or about to expire, get new one
    console.log('Refreshing token...');
    await this.refreshToken();
    return this.token;
  }

  // Extract OTP from message string
  extractOTPFromMessage(message) {
    const match = message.match(/\.(\d{6})$/);
    if (match) {
      return match[1];
    }

    const fallbackMatch = message.match(/(\d{6})/);
    return fallbackMatch ? fallbackMatch[1] : null;
  }

  // Send OTP request to Telegram and wait for response
  async getOTPFromTelegram(message, timeoutMs = 300000) { // 5 minute timeout
    if (!this.bot || !TELEGRAM_CHAT_ID) {
      throw new Error('Telegram bot not configured');
    }

    return new Promise((resolve, reject) => {
      this.otpPromiseResolve = resolve;

      // Send message to user
      const requestMessage = `
🔐 *OTP Required for MDCN Login*

${message}

Please reply with the 6-digit OTP code.
⏱️ You have 5 minutes to respond.
      `;

      this.bot.telegram.sendMessage(TELEGRAM_CHAT_ID, requestMessage, { parse_mode: 'Markdown' })
        .then(() => {
          console.log('📱 OTP request sent to Telegram');
        })
        .catch((error) => {
          console.error('Failed to send Telegram message:', error.message);
          reject(error);
        });

      // Set timeout
      setTimeout(() => {
        if (this.otpPromiseResolve) {
          this.otpPromiseResolve = null;
          this.bot.telegram.sendMessage(TELEGRAM_CHAT_ID, '⏱️ OTP request timed out. Please try again.');
          reject(new Error('OTP request timed out'));
        }
      }, timeoutMs);
    });
  }

  async refreshToken() {
    try {
      // Step 1: Initial login request
      console.log('Sending login request...');
      const loginResponse = await axios.post(this.loginUrl, credentials);

      // Step 2: Check if OTP is required
      if (loginResponse.data.status === 'OTP_REQUIRED') {
        console.log('OTP Required!');
        console.log('Email:', loginResponse.data.email);
        console.log('Message:', loginResponse.data.message);

        let otpCode = null;

        // Step 3: Try to extract OTP from message automatically
        if (loginResponse.data.message) {
          otpCode = this.extractOTPFromMessage(loginResponse.data.message);

          if (otpCode) {
            console.log('✅ OTP extracted automatically:', otpCode);
          } else {
            console.log('⚠️ Could not extract OTP from message');
          }
        }

        // Step 4: Fallback to Telegram if extraction failed
        if (!otpCode) {
          console.log('📱 Requesting OTP via Telegram...');

          try {
            otpCode = await this.getOTPFromTelegram(loginResponse.data.message);
          } catch (telegramError) {
            console.error('Telegram OTP request failed:', telegramError.message);
            throw new Error('Could not get OTP: automatic extraction failed and Telegram request timed out');
          }
        }

        // Step 5: Verify OTP
        console.log('Verifying OTP...');
        const otpResponse = await axios.post(this.otpUrl, {
          email: credentials.email,
          otp_code: otpCode,
        });

        if (otpResponse.data.jwt) {
          this.token = otpResponse.data.jwt;
          console.log('✅ Login successful with OTP!');

          // Send success message to Telegram
          if (this.bot && TELEGRAM_CHAT_ID) {
            await this.bot.telegram.sendMessage(
              TELEGRAM_CHAT_ID,
              '✅ Successfully authenticated! Token will be valid for ~21 hours.'
            );
          }
        } else {
          throw new Error('OTP verification failed: ' + JSON.stringify(otpResponse.data));
        }
      } else if (loginResponse.data.jwt) {
        // No OTP required, got token directly
        this.token = loginResponse.data.jwt;
        console.log('✅ Login successful without OTP!');
      } else {
        throw new Error('Unexpected login response: ' + JSON.stringify(loginResponse.data));
      }

      // Parse expiry from token
      const payload = JSON.parse(
        Buffer.from(this.token.split('.')[1], 'base64')
      );
      this.expiry = payload.exp * 1000;

      console.log('Token expires:', new Date(this.expiry));
    } catch (error) {
      console.error('Failed to refresh token:', error.message);

      // Notify user via Telegram
      if (this.bot && TELEGRAM_CHAT_ID) {
        await this.bot.telegram.sendMessage(
          TELEGRAM_CHAT_ID,
          `❌ Authentication failed: ${error.message}`
        );
      }

      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      throw error;
    }
  }
}

// Initialize TokenManager with the bot
const tokenManager = new TokenManager(bot);

bot.command("vacancies", async (ctx) => {
  try {
    ctx.reply("Fetching available housemanship vacancies...");
    const vacancies = await getVacancies();

    if (!vacancies.length) {
      ctx.reply("No available vacancies found.");
      return;
    }

    let message = "🏥 *Available Housemanship Vacancies:*\n\n";
    vacancies.forEach((vacancy, index) => {
      message += `${index + 1}. *${vacancy.centerName}*\n`;
    });

    ctx.replyWithMarkdown(message);
    previousVacancies = vacancies;
  } catch (error) {
    console.error("Error fetching vacancies:", error);
    ctx.reply("❌ Error fetching vacancies.");
  }
});

bot.command("testperformance", async (ctx) => {
  if (ctx.from.id.toString() !== process.env.TELEGRAM_CHAT_ID) {
    return ctx.reply("⛔ Admin only");
  }

  try {
    ctx.reply("🧪 Testing query performance...");

    const testHospitals = [
      "Federal Medical Centre Asaba",
      "Lagos University Teaching Hospital"
    ];

    // ❌ OLD METHOD: Fetch all users
    const start1 = Date.now();
    const { data: allUsers } = await supabase
      .from("subscription2")
      .select("user_id, hospitals, phone_number");
    const time1 = Date.now() - start1;

    // Filter in JavaScript
    const matchedOld = allUsers?.filter(user => 
      user.hospitals?.some(h => testHospitals.includes(h))
    ) || [];

    // ✅ NEW METHOD: Database-filtered query
    const start2 = Date.now();
    const { data: filteredUsers } = await supabase
      .from("subscription2")
      .select("user_id, hospitals, phone_number")
      .overlaps("hospitals", testHospitals);
    const time2 = Date.now() - start2;

    const improvement = Math.round(((time1 - time2) / time1) * 100);

    ctx.reply(`📊 Performance Test Results:

❌ Old Method (Fetch All):
   • Query time: ${time1}ms
   • Records fetched: ${allUsers?.length || 0}
   • Matched users: ${matchedOld.length}

✅ New Method (DB Filter):
   • Query time: ${time2}ms
   • Records fetched: ${filteredUsers?.length || 0}
   • Matched users: ${filteredUsers?.length || 0}

🚀 Performance: ${improvement}% faster!
💾 Data saved: ${((1 - (filteredUsers?.length || 0) / (allUsers?.length || 1)) * 100).toFixed(1)}% less data transferred`);

  } catch (error) {
    ctx.reply(`❌ Test failed: ${error.message}`);
  }
});

bot.command("queuestatus", async (ctx) => {
  ctx.reply(`📊 Queue Status:

- Pending notifications: ${notificationQueue.length}
- Currently processing: ${isProcessing ? "Yes" : "No"}
- Batch size: 10 users per batch
- Processing interval: Every 3 seconds`);
});

bot.command("start", async (ctx) => {
  const userId = ctx.from.id; // Telegram user ID
  const firstName = ctx.from.first_name || ctx.from.username || "Doctor";

  try {
    // Fetch ALL subscriptions for this user
    const { data: subscriptions, error } = await supabase
      .from("subscription2")
      .select("hospitals, plan, plan_id, phone_number")
      .eq("user_id", userId);

    if (error || !subscriptions?.length) {
      console.error("Error fetching subscriptions:", error);
      return ctx.reply(
        "⚠️ I couldn't find your subscription details. Please subscribe first."
      );
    }

    // Build message for each plan
    let replyText = `👋 Hello Dr. ${firstName}\n\nHere are your active subscriptions:\n\n`;

    subscriptions.forEach((sub) => {
      const hospitals = Array.isArray(sub.hospitals)
        ? sub.hospitals
        : (sub.hospitals || "").split(",");

      const hospitalMessage = hospitals.map((h) => h.trim()).join(" and ");

      replyText +=
        `📦 <b>Plan:</b> ${sub.plan}\n` +
        `🏥 <b>Hospitals:</b> ${hospitalMessage}\n` +
        `🔔 Once your preferred hospitals become available on the portal, I’ll notify you right away.\n\n`;
    });

    replyText +=
      `📝 Hope you’ve clicked on the link to join the Telegram updates group chat for all hospitals.\n\n` +
      `<b>💳 Payment Channel:</b> <a href="https://t.me/RiosReadyBot">Click here to return</a>\n\n` +
      `<b>💬 For complaints?</b> <a href="https://t.me/timewise_agent">Chat with our customer service agent!</a>`;

    await ctx.reply(replyText, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Unexpected error:", err);
    ctx.reply("⚠️ Something went wrong. Please try again later.");
  }
});

bot.on("message", (ctx) => {
  console.log("Chat ID:", ctx.chat.id);
  // ctx.reply(`Your Chat ID is: ${ctx.chat.id}`);
});

// === Vacancy Fetching Function ===
async function getVacancies() {
  try {
    let token;
    let tokenSource = 'unknown';

    // Priority 1: Try TokenManager (automatic with OTP)
    if (process.env.USER_EMAIL && process.env.USER_PASSWORD) {
      try {
        token = await tokenManager.getToken();
        tokenSource = 'TokenManager (Automatic Authentication)';
        // console.log('✅ Using token from TokenManager');
      } catch (error) {
        console.error('⚠️ TokenManager failed:', error.message);
        console.log('Attempting fallback to manual JWT_TOKEN...');
      }
    } else {
      console.log('⚠️ USER_EMAIL or USER_PASSWORD not configured, skipping TokenManager');
    }

    // Priority 2: Fallback to manual JWT_TOKEN
    if (!token && process.env.JWT_TOKEN) {
      token = process.env.JWT_TOKEN;
      tokenSource = 'Manual JWT_TOKEN (Environment Variable)';
      console.log('✅ Using manual JWT_TOKEN from environment');

      // Validate expiry
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64'));
        const expiresIn = (payload.exp * 1000 - Date.now()) / 1000 / 60;

        if (expiresIn < 0) {
          console.warn(`⚠️ Manual JWT_TOKEN is EXPIRED (expired ${Math.abs(Math.floor(expiresIn))} minutes ago)`);
          console.warn('Please update JWT_TOKEN in environment variables or configure automatic authentication');
        } else if (expiresIn < 60) {
          console.warn(`⚠️ Manual JWT_TOKEN expires soon (${Math.floor(expiresIn)} minutes remaining)`);
        } else {
          console.log(`✅ Manual token valid for ${Math.floor(expiresIn)} more minutes`);
        }
      } catch (parseError) {
        console.warn('⚠️ Could not parse manual token expiry:', parseError.message);
      }
    }

    // Priority 3: No token available
    if (!token) {
      const errorMessage =
        'No authentication token available. Please provide either:\n' +
        '1. USER_EMAIL and USER_PASSWORD (+ BOT_TOKEN and TELEGRAM_CHAT_ID) for automatic authentication, or\n' +
        '2. JWT_TOKEN for manual authentication';

      console.error('❌', errorMessage);
      throw new Error(errorMessage);
    }

    // Make API request
    // console.log(`Making API request using ${tokenSource}...`);
    const response = await axios.post(
      process.env.API_URL || 'https://api.housemanship.mdcn.gov.ng/api/availablevacancies.php',
      { jwt: token, tid: 1 },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }
    );

    // console.log(`✅ Request successful using ${tokenSource}`);
    // console.log(`✅ Retrieved ${response.data?.length || 0} vacancies`);
    return response.data;

  } catch (error) {
    console.error('❌ Error fetching vacancies:', error.message);

    if (error.response?.status === 401) {
      console.error('❌ Authentication failed (401 Unauthorized)');
      console.error('Token is invalid or expired.');

      // Clear cached token to force refresh on next call
      tokenManager.token = null;
      tokenManager.expiry = null;

      console.log('💡 Suggestions:');
      console.log('  1. If using manual JWT_TOKEN, update it in environment variables');
      console.log('  2. If using automatic auth, check USER_EMAIL and USER_PASSWORD');
      console.log('  3. Ensure Telegram bot is configured for OTP if needed');
    } else if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }

    return [];
  }
}

function startInterval(time) {
  if (checkInterval) clearInterval(checkInterval);
  checkInterval = setInterval(checkForUpdates, time);
  console.log(
    `🔃 Started checkForUpdates interval: every ${time}s at ${new Date().toLocaleString()}`
  );
}

// Call this when an update happens
function handleUpdateDetected() {
  updatesToday++;

  if (updatesToday === 1 && intervalTime !== 40000) {
    intervalTime = 35000; // First update → 40s
    startInterval(intervalTime);
    console.log("⏱ Changed interval to 40s (first update)");
  } else if (updatesToday === 2 && intervalTime !== 30000) {
    intervalTime = 30000; // Second update → 30s
    startInterval(intervalTime);
    console.log("⏱ Changed interval to 30s (second update)");
  }

  lastUpdateTime = Date.now(); // Reset timer
}

// === Vacancy Check Function ===
async function checkForUpdates() {
  try {
    const newVacancies = await getVacancies();
    if (!newVacancies.length) return;

    const prevNames = new Set(previousVacancies.map((v) => v.centerName));
    const newNames = new Set(newVacancies.map((v) => v.centerName));

    const addedHospitals = newVacancies.filter(
      (v) => !prevNames.has(v.centerName)
    );
    const removedHospitals = previousVacancies.filter(
      (v) => !newNames.has(v.centerName)
    );

    let message = "";

    if (addedHospitals.length) {
      const count = addedHospitals.length;
      const text = count === 1 ? "hospital" : "hospitals";
      message += `*🏥 Housemanship Portal Updated!*\n\n`;
      message += `🆕 *${count} new ${text} added:*\n`;
      addedHospitals.forEach((h) => {
        message += ` ${h.centerName}\n`;
      });
      message += "\n";
    }

    if (removedHospitals.length) {
      const count = removedHospitals.length;
      const text = count === 1 ? "hospital" : "hospitals";
      message += `*🏥 Housemanship Portal Updated!*\n\n`;
      message += `❌ *${count} ${text} removed:*\n`;
      removedHospitals.forEach((h) => {
        message += ` ${h.centerName}\n`;
      });
      message += "\n";
    }

    if (addedHospitals.length || removedHospitals.length) {
      message += "🏥 *Available Housemanship Vacancies:*\n\n";
      newVacancies.forEach((vacancy, index) => {
        const slotText = vacancy.officer_left === "1" ? "slot" : "slots";
        message += `${index + 1}. *${vacancy.centerName} (${
          vacancy.officer_left
        } ${slotText})*\n`;
      });

      // ✅ INSTANT GROUP BROADCAST - Priority #1
      await bot.telegram.sendMessage(process.env.CHAT_ID, message, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔑 Login to portal Now",
                url: "https://www.housemanship.mdcn.gov.ng/login",
              },
            ],
          ],
        },
      });

      handleUpdateDetected();

      // ✅ QUEUE PERSONAL NOTIFICATIONS (non-blocking)
      queuePersonalNotifications(addedHospitals, removedHospitals);
    }

    previousVacancies = newVacancies;
  } catch (error) {
    console.error("Error checking for updates:", error);
  }
}

// ✅ OPTIMIZED: Only fetch users watching specific hospitals
async function queuePersonalNotifications(addedHospitals, removedHospitals) {
  if (addedHospitals.length === 0) return;

  try {
    const hospitalNames = addedHospitals.map(h => h.centerName);
    
    console.log(`🔍 Searching for users watching: ${hospitalNames.join(", ")}`);

    // ✅ Database-level filtering - only fetch matching users
    const { data: users, error } = await supabase
      .from("subscription2")
      .select("phone_number, hospitals, plan, user_id")
      .overlaps("hospitals", hospitalNames);

    if (error) {
      console.error("Database query error:", error);
      return;
    }

    if (!users || users.length === 0) {
      console.log("📭 No users watching these hospitals");
      return;
    }

    console.log(`🎯 Found ${users.length} users (filtered by database)`);

    // Build notification tasks
    const tasks = [];
    
    for (const user of users) {
      if (!user.hospitals || !Array.isArray(user.hospitals)) continue;

      const matchedHospitals = addedHospitals.filter(h =>
        user.hospitals.includes(h.centerName)
      );

      if (matchedHospitals.length > 0) {
        const hospitalList = matchedHospitals
          .map((h, i) => `${i + 1}. ${h.centerName}`)
          .join(". ");

        tasks.push({
          user,
          hospitalList,
          matchedHospitals,
          timestamp: Date.now()
        });
      }
    }

    notificationQueue.push(...tasks);
    console.log(`📬 Queued ${tasks.length} personal notifications`);

  } catch (error) {
    console.error("Error queuing notifications:", error);
  }
}

// ✅ BACKGROUND WORKER: Process notification queue
async function processNotificationQueue() {
  if (isProcessing || notificationQueue.length === 0) return;

  isProcessing = true;
  const BATCH_SIZE = 10;

  try {
    while (notificationQueue.length > 0) {
      const batch = notificationQueue.splice(0, BATCH_SIZE);
      
      console.log(`📤 Processing batch of ${batch.length} notifications...`);

      await Promise.allSettled(
        batch.map(async (task) => {
          const { user, hospitalList } = task;

          const personalMessage = `*🏥 New housemanship slots available!*\n\n${hospitalList}\n\n👉 [Apply now](https://www.housemanship.mdcn.gov.ng/login)`;

          try {
            if (user.plan === "telegram" && user.user_id) {
              await sendTelegramMessage(user.user_id, personalMessage, bot);
            } else if (user.plan === "whatsapp" && user.phone_number) {
              await sendWhatsAppMessage(user.phone_number, hospitalList);
            } else if (user.plan === "bonus") {
              const promises = [];
              if (user.phone_number) {
                promises.push(sendWhatsAppMessage(user.phone_number, hospitalList));
              }
              if (user.user_id) {
                promises.push(sendTelegramMessage(user.user_id, personalMessage, bot));
              }
              await Promise.allSettled(promises);
            }
          } catch (err) {
            console.error(
              `❌ Failed to notify ${user.user_id || user.phone_number}:`,
              err.message
            );
          }
        })
      );

      // Rate limiting between batches
      if (notificationQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log("✅ Notification queue processed");
  } catch (error) {
    console.error("Error processing notification queue:", error);
  } finally {
    isProcessing = false;
  }
}

const [DEVICE_ID, TEMPLATE_ID, TERMII_API_KEY] =
  process.env.TERMII_CONFIG.split("|");

async function sendWhatsAppMessage(phone, message) {
  try {
    const response = await axios.post(
      "https://v3.api.termii.com/api/send/template",
      {
        phone_number: phone, // E.g. "2348012345678"
        device_id: DEVICE_ID, // Use your Termii device ID
        template_id: TEMPLATE_ID,
        api_key: TERMII_API_KEY,
        data: {
          hospitallist: message,
        }, // e.g., { hospitallist: "Citizen Medical Center" }
      }
    );
    console.log("✅ WhatsApp template message sent:", response.data);
  } catch (err) {
    console.error(
      "❌ Failed to send WhatsApp template message:",
      err.response?.data || err.message
    );
  }
}

async function sendTelegramMessage(userId, message, bot) {
  try {
    await bot.telegram.sendMessage(userId, message, { parse_mode: "Markdown" });
    console.log(`✅ Telegram message sent to ${userId}`);
  } catch (err) {
    console.error(
      `❌ Failed to send Telegram message to ${userId}:`,
      err.response?.description || err.message
    );
  }
}

async function notifyIfNoUpdateIn24Hrs() {
  const now = Date.now();
  const hoursSinceLastUpdate = (now - lastUpdateTime) / (1000 * 60 * 60);

  if (hoursSinceLastUpdate >= 24) {
    await bot.telegram.sendMessage(
      process.env.CHAT_ID,
      "Relax, *No New slot* has been added in the portal *within the last 24hrs*; so keep enjoying your day!",
      { parse_mode: "Markdown" }
    );

    if (intervalTime !== 47000) {
      intervalTime = 47000;
      updatesToday = 0; // reset count
      startInterval(intervalTime);
      console.log("Reverted back to default interval (47s)");
    }

    lastUpdateTime = now; // reset timer after sending
  }
}

//=== Launch Bot + Express Server ===
(async () => {
  try {
    app.get("/debug", async (req, res) => {
      try {
        await bot.telegram.sendMessage(
          process.env.CHAT_ID,
          "✅ Debug: Bot is alive!"
        );
        res.send("✅ Message sent to Telegram");
      } catch (err) {
        console.error("Telegram error:", err);
        res.status(500).send("❌ Telegram error: " + err.description);
      }
    });

    app.get("/debug-vars", (req, res) => {
      console.log("🔍 /debug-vars hit");
      res.json({
        BOT_TOKEN: process.env.BOT_TOKEN ? "✅ SET" : "❌ NOT SET",
        CHAT_ID: process.env.CHAT_ID || "❌ NOT SET",
        APP_URL: process.env.APP_URL || "❌ NOT SET",
        API_URL: process.env.API_URL || "❌ NOT SET",
        JWT_TOKEN: process.env.JWT_TOKEN ? "✅ SET" : "❌ NOT SET",
      });
    });

    //app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
    app.use(bot.webhookCallback(WEBHOOK_PATH));

    // Root route for Railway
    app.get("/", (req, res) => {
      res.send("🤖 Bot is running via webhook!");
    });

    // Start Express server (Railway uses dynamic ports)
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });

    console.log("WEBHOOK_URL:", WEBHOOK_URL);
    setTimeout(async () => {
      try {
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log("✅ Webhook set to:", WEBHOOK_URL);
      } catch (err) {
        console.error("❌ Failed to set webhook:", err);
      }
    }, 5000); // wait 5 seconds before setting the webhook

    setInterval(notifyIfNoUpdateIn24Hrs, 60 * 60 * 1000);
    startInterval(intervalTime);
    // setInterval(checkForUpdates); // 47 seconds

    // ✅ START QUEUE PROCESSOR
    setInterval(processNotificationQueue, 3000); // Process queue every 3 seconds

    // ✅ MONITOR QUEUE HEALTH
    setInterval(() => {
      if (notificationQueue.length > 0) {
        console.log(`📊 Queue status: ${notificationQueue.length} pending notifications`);
      }
      if (notificationQueue.length > 500) {
        console.warn(`⚠️ Large queue backlog: ${notificationQueue.length} notifications!`);
      }
    }, 30000); // Check every 30 seconds
  } catch (err) {
    console.error("Failed to launch bot:", err);
  }
})();

