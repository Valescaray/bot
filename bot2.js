require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const axios = require("axios");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// === Webhook Setup ===
const WEBHOOK_PATH = `/bot${process.env.BOT_TOKEN}`;
const WEBHOOK_URL = `${process.env.APP_URL}${WEBHOOK_PATH}`; // APP_URL must be set in .env, e.g. https://your-app.up.railway.app

bot.telegram.setWebhook(WEBHOOK_URL);
app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

// Optional: Root route for debugging
app.get("/", (req, res) => {
  res.send("🤖 Housemanship bot is running via webhook!");
});

let previousVacancies = [];

// Function to fetch available vacancies
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
    } else {
      return;
    }

    if (message) {
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
    }

    previousVacancies = newVacancies;
  } catch (error) {
    console.error("Error checking for updates:", error);
  }
}

// Manual command
bot.command("vacancies", async (ctx) => {
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
});

bot.on("message", (ctx) => {
  console.log("Chat ID:", ctx.chat.id);
  // ctx.reply(`Your Chat ID is: ${ctx.chat.id}`);
});

// Interval (e.g., every 10 minutes)
setInterval(() => {
  checkForUpdates();
}, 10 * 60 * 1000); // 10 minutes

// Start Express server
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
