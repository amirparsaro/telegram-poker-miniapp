import os
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Default Mini App URL (Replace with your ngrok/localtunnel/VPS HTTPS URL)
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://your-domain.ngrok-free.app")

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat = update.effective_chat
    user = update.effective_user
    table_id = f"room_{abs(chat.id)}"

    # Construct direct webapp URL with table parameter
    url = f"{WEBAPP_URL}?table={table_id}"

    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "🎮 باز کردن مینی اپ پوکر (Open Mini App)",
                web_app=WebAppInfo(url=url)
            )
        ]
    ])

    await update.message.reply_text(
        f"سلام {user.first_name}! ♠️♥️\n\n"
        "برای ورود به میز و بازی بصورت زنده با انیمیشن و ظاهر گرافیکی روی دکمه زیر بزنید:",
        reply_markup=keyboard
    )

def main():
    token = os.environ.get("BOT_TOKEN")
    if not token:
        print("Error: Please set the BOT_TOKEN environment variable.")
        return

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("poker", cmd_start))

    logger.info("Bot is running with Mini App integration...")
    app.run_polling()

if __name__ == "__main__":
    main()
