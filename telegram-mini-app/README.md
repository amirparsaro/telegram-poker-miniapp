# Telegram Poker Mini App (TMA) ♠️♥️♦️♣️

This project is a full-featured **Telegram Mini App (Web App)** for Texas Hold'em Poker created right alongside the original bot (`poker_bot.py`), without modifying your original files.

---

## 🌟 Key Features

1. **Interactive Real-Time Poker Table:**
   - Oval green felt table with 6 realistic seats.
   - Live Pot display, community cards (Flop, Turn, River), and dealer button (`D`).
   - Private hole cards rendered directly for the player in the Mini App interface (no more DM spam needed).
   - Card ranking & showdown evaluator supporting all standard Texas Hold'em combinations (High Card to Royal Flush).
2. **WebSocket Real-Time Sync:**
   - Multi-player state synchronisation with live turns, bet chips, folding, and showdown payouts.
   - Telegram WebApp SDK integration for native user names and avatars.
3. **Bot AI & Solitary Play Testing:**
   - Includes a "+ Add Bot" button to test and play full hands immediately with simulated AI players even if you are alone.
4. **Standalone or Integrated:**
   - Can run as a standalone browser app or as a Telegram Web App inside Telegram groups or direct messages.

---

## 📁 Project Structure

```
c:\poker\
├── poker_bot.py               # (Unchanged) Your original bot
└── telegram-mini-app\         # New Mini App Project
    ├── engine.py              # Pure Python deck & 7-card poker hand evaluator
    ├── game_manager.py        # Table, Player, betting, blinds & turn logic
    ├── server.py              # Tornado WebSocket & HTTP web server (port 8080)
    ├── bot.py                 # Telegram Bot launcher with WebApp button
    ├── requirements.txt       # Dependencies
    ├── static\
    │   ├── index.html         # Mini App HTML with Telegram SDK
    │   ├── css\style.css      # Casino dark-theme styles, cards & table
    │   └── js\app.js          # WebSocket client, sound & action controls
    └── README.md
```

---

## 🚀 Quick Start & Testing

### 1. Run the Web Server (Locally)
In PowerShell / Terminal:
```powershell
cd c:\poker\telegram-mini-app
python server.py
```
Open **[http://localhost:8080](http://localhost:8080)** in your browser!
- Click **"+ Add Bot"** to add 1 or more bots.
- Click **"Deal New Hand"** to start playing Texas Hold'em immediately!
- Test Check / Call / Raise / Fold directly.

---

## 📱 Connecting to Telegram Mini App

Telegram requires **HTTPS** for Web Apps.

### Step 1: Expose local server or deploy
You can use free tunnels like `ngrok` or `localtunnel`:
```bash
ngrok http 8080
```
This gives you an HTTPS URL, for example: `https://abcd-1234.ngrok-free.app`.

### Step 2: Configure with Telegram @BotFather
1. Open `@BotFather` on Telegram.
2. Send `/newapp` (or configure an existing bot with `/mybots` -> Select Bot -> **Bot Settings** -> **Menu Button** or **Configure Mini App**).
3. Set the Web App URL to your HTTPS URL:
   `https://abcd-1234.ngrok-free.app`
4. Set short name: `poker`.

### Step 3: Run the Mini App Bot (Optional)
```powershell
$env:BOT_TOKEN="your_telegram_bot_token"
$env:WEBAPP_URL="https://abcd-1234.ngrok-free.app"
python bot.py
```
Users typing `/start` will receive an inline button that opens the poker table inside Telegram!
