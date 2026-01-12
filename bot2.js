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
  if (ctx.from.id.toString() !== process.env.ADMIN_USER_ID) {
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
      .from("subscriptions")
      .select("user_id, hospitals, phone_number");
    const time1 = Date.now() - start1;

    // Filter in JavaScript
    const matchedOld = allUsers?.filter(user => 
      user.hospitals?.some(h => testHospitals.includes(h))
    ) || [];

    // ✅ NEW METHOD: Database-filtered query
    const start2 = Date.now();
    const { data: filteredUsers } = await supabase
      .from("subscriptions")
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
      .from("subscriptions")
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
    const response = await axios.post(
      process.env.API_URL,
      {
        jwt: process.env.JWT_TOKEN,
        tid: 1,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.JWT_TOKEN}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error fetching vacancies:", error.message);
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
      .from("subscriptions")
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