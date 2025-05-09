require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");

const bot = new Telegraf(process.env.BOT_TOKEN);

let previousVacancies = []; // Store previous vacancies

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

    return response.data; // Return the data
  } catch (error) {
    console.error("Error fetching vacancies:", error.message);
    return [];
  }
}

async function checkForUpdates(ctx) {
  try {
    const newVacancies = await getVacancies();

    if (!newVacancies.length) return; // No data, do nothing

    // Extract hospital names for comparison
    const prevNames = new Set(previousVacancies.map((v) => v.centerName));
    const newNames = new Set(newVacancies.map((v) => v.centerName));

    // Find new hospitals added
    const addedHospitals = newVacancies.filter(
      (v) => !prevNames.has(v.centerName)
    );

    // Find removed hospitals
    const removedHospitals = previousVacancies.filter(
      (v) => !newNames.has(v.centerName)
    );

    let message = "";

    if (addedHospitals.length) {
      const hospitalCount = addedHospitals.length;
      const hospitalText = hospitalCount === 1 ? "hospital" : "hospitals";

      message += `*🏥 Housemanship Portal Updated!*\n\n`;
      message += `🆕 *${hospitalCount} new ${hospitalText} added:*\n`;

      addedHospitals.forEach((h) => {
        message += ` ${h.centerName}\n`;
      });

      message += "\n";
    }

    if (removedHospitals.length) {
      const hospitalCount = removedHospitals.length;
      const hospitalText = hospitalCount === 1 ? "hospital" : "hospitals";

      message += `*🏥 Housemanship Portal Updated!*\n\n`;
      message += `❌ *${hospitalCount} ${hospitalText} removed:*\n`;

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

    // Send updates only if there are changes
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

    // Update the previous vacancies list
    previousVacancies = newVacancies;
  } catch (error) {
    console.error("Error fetching vacancies:", error);
    await ctx.reply(
      "An error occurred while checking for updates. Please try again later."
    );
  }
}

// Command to manually check vacancies
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

  // Update the stored vacancies after manual fetch
  previousVacancies = vacancies;
});

bot.on("message", (ctx) => {
  console.log("Chat ID:", ctx.chat.id);
  //ctx.reply(`Your Chat ID is: ${ctx.chat.id}`);
});

// Set an interval to check for updates every 10 minutes
setInterval(() => {
  checkForUpdates(bot.telegram);
}, 60000);

// Start the bot
(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log("🤖 Bot is running with polling...");
  } catch (error) {
    console.error("Failed to launch bot:", error);
  }
})();

//bot.launch();
//console.log("🤖 Bot is running...");
