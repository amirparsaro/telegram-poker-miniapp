import asyncio
import logging
import os
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)
from treys import Card, Deck, Evaluator

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

SMALL_BLIND = 10
BIG_BLIND = 20
RAISE_STEP = 20
STARTING_CHIPS = 1000


@dataclass
class Player:
    user_id: int
    name: str
    chips: int = STARTING_CHIPS
    hand: List[int] = field(default_factory=list)
    current_bet: int = 0
    total_hand_bet: int = 0
    folded: bool = False
    acted_in_round: bool = False


@dataclass
class PokerTable:
    chat_id: int
    players: List[Player] = field(default_factory=list)
    in_hand: bool = False
    stage: str = "WAITING"  # WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
    deck: Optional[Deck] = None
    community_cards: List[int] = field(default_factory=list)
    pot: int = 0
    dealer_idx: int = 0
    turn_idx: int = 0
    current_highest_bet: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def active_players(self) -> List[Player]:
        return [p for p in self.players if not p.folded and p.chips > 0 or (not p.folded and p.total_hand_bet > 0)]

    def contenders(self) -> List[Player]:
        return [p for p in self.players if not p.folded]


class PokerManager:
    def __init__(self) -> None:
        self.tables: Dict[int, PokerTable] = {}
        self.evaluator = Evaluator()

    def get_or_create_table(self, chat_id: int) -> PokerTable:
        if chat_id not in self.tables:
            self.tables[chat_id] = PokerTable(chat_id=chat_id)
        return self.tables[chat_id]

    @staticmethod
    def format_cards(cards: List[int]) -> str:
        if not cards:
            return "—"
        return " ".join(Card.int_to_pretty_str(c) for c in cards)

    def table_status_text(self, table: PokerTable) -> str:
        lines = [f"🃏 **میز پوکر تگزاس هولدم** | مرحله: `{table.stage}`"]
        lines.append(f"💰 **پات (Pot):** {table.pot} چیپ")
        lines.append(f"🂠 **کارت‌های مشترک:** {self.format_cards(table.community_cards)}")
        lines.append("\n**بازیکنان:**")
        for idx, p in enumerate(table.players):
            turn_mark = " 👉 **نوبت**" if (table.in_hand and idx == table.turn_idx and not p.folded) else ""
            dealer_mark = " 🔘(D)" if (table.in_hand and idx == table.dealer_idx) else ""
            status = " ❌ فولد" if p.folded else f" | شرط این راند: {p.current_bet}"
            lines.append(f"• {p.name}{dealer_mark}: {p.chips} چیپ{status}{turn_mark}")
        return "\n".join(lines)

    async def start_new_hand(self, table: PokerTable, context: ContextTypes.DEFAULT_TYPE) -> None:
        eligible = [p for p in table.players if p.chips > 0]
        if len(eligible) < 2:
            table.in_hand = False
            table.stage = "WAITING"
            await context.bot.send_message(
                table.chat_id,
                "⚠️ برای شروع دست جدید حداقل ۲ بازیکن با موجودی مثبت لازم است.",
            )
            return

        table.players = eligible
        table.in_hand = True
        table.stage = "PREFLOP"
        table.deck = Deck()
        table.community_cards = []
        table.pot = 0
        table.current_highest_bet = 0
        table.dealer_idx = (table.dealer_idx + 1) % len(table.players)

        for p in table.players:
            p.hand = table.deck.draw(2)
            p.current_bet = 0
            p.total_hand_bet = 0
            p.folded = False
            p.acted_in_round = False

        n = len(table.players)
        sb_idx = (table.dealer_idx + 1) % n
        bb_idx = (table.dealer_idx + 2) % n if n > 2 else table.dealer_idx

        self._post_blind(table, table.players[sb_idx], SMALL_BLIND)
        self._post_blind(table, table.players[bb_idx], BIG_BLIND)
        table.current_highest_bet = BIG_BLIND

        # اولین نفر بعد از Big Blind شروع می‌کند
        table.turn_idx = (bb_idx + 1) % n
        if table.players[table.turn_idx].folded:
            self._advance_turn(table)

        # ارسال کارت‌های مخفی به PV هر بازیکن
        for p in table.players:
            try:
                await context.bot.send_message(
                    chat_id=p.user_id,
                    text=f"🃏 کارت‌های دست شما:\n{self.format_cards(p.hand)}",
                    parse_mode="Markdown",
                )
            except Exception as e:
                logger.warning("Could not DM player %s: %s", p.user_id, e)
                await context.bot.send_message(
                    table.chat_id,
                    f"⚠️ نتونستم کارت‌ها رو برای **{p.name}** بفرستم. لطفاً اول در PV به ربات `/start` بزنید!",
                    parse_mode="Markdown",
                )

        await self.send_turn_prompt(table, context)

    @staticmethod
    def _post_blind(table: PokerTable, player: Player, amount: int) -> None:
        paid = min(player.chips, amount)
        player.chips -= paid
        player.current_bet += paid
        player.total_hand_bet += paid
        table.pot += paid

    def _advance_turn(self, table: PokerTable) -> None:
        n = len(table.players)
        for _ in range(n):
            table.turn_idx = (table.turn_idx + 1) % n
            candidate = table.players[table.turn_idx]
            if not candidate.folded and candidate.chips > 0:
                return

    def _is_betting_round_complete(self, table: PokerTable) -> bool:
        active_can_act = [p for p in table.players if not p.folded and p.chips > 0]
        if len(active_can_act) <= 1:
            return True
        for p in active_can_act:
            if not p.acted_in_round:
                return False
            if p.current_bet < table.current_highest_bet:
                return False
        return True

    async def send_turn_prompt(self, table: PokerTable, context: ContextTypes.DEFAULT_TYPE) -> None:
        contenders = table.contenders()
        if len(contenders) == 1:
            await self.finish_hand_by_fold(table, contenders[0], context)
            return

        if self._is_betting_round_complete(table):
            await self.next_stage(table, context)
            return

        current_player = table.players[table.turn_idx]
        to_call = max(0, table.current_highest_bet - current_player.current_bet)

        call_label = "Check" if to_call == 0 else f"Call ({min(to_call, current_player.chips)})"
        keyboard = InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("❌ Fold", callback_data=f"act:{table.chat_id}:fold"),
                    InlineKeyboardButton(f"✅ {call_label}", callback_data=f"act:{table.chat_id}:call"),
                ],
                [
                    InlineKeyboardButton(
                        f"⬆️ Raise (+{RAISE_STEP})",
                        callback_data=f"act:{table.chat_id}:raise",
                    )
                ],
            ]
        )

        text = (
            f"{self.table_status_text(table)}\n\n"
            f"🎯 نوبت **{current_player.name}** است (برای Call نیاز به **{to_call}** چیپ اضافی دارید):"
        )
        await context.bot.send_message(
            chat_id=table.chat_id,
            text=text,
            reply_markup=keyboard,
            parse_mode="Markdown",
        )

    async def next_stage(self, table: PokerTable, context: ContextTypes.DEFAULT_TYPE) -> None:
        for p in table.players:
            p.current_bet = 0
            p.acted_in_round = False
        table.current_highest_bet = 0

        if table.stage == "PREFLOP":
            table.stage = "FLOP"
            table.community_cards.extend(table.deck.draw(3))
        elif table.stage == "FLOP":
            table.stage = "TURN"
            table.community_cards.extend(table.deck.draw(1))
        elif table.stage == "TURN":
            table.stage = "RIVER"
            table.community_cards.extend(table.deck.draw(1))
        elif table.stage == "RIVER":
            await self.showdown(table, context)
            return

        # تعیین اولین بازیکن فعال بعد از دیلر
        n = len(table.players)
        table.turn_idx = table.dealer_idx
        self._advance_turn(table)

        # اگر هیچ‌کس چیپ برای اکشن ندارد، مستقیم به مرحله بعد برو
        can_act = [p for p in table.players if not p.folded and p.chips > 0]
        if len(can_act) <= 1:
            await self.next_stage(table, context)
            return

        await self.send_turn_prompt(table, context)

    async def finish_hand_by_fold(
        self, table: PokerTable, winner: Player, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        winner.chips += table.pot
        won_amount = table.pot
        table.pot = 0
        table.in_hand = False
        table.stage = "WAITING"

        await context.bot.send_message(
            chat_id=table.chat_id,
            text=(
                f"🏆 بقیه بازیکنان فولد کردند!\n"
                f"**{winner.name}** برنده **{won_amount}** چیپ شد (موجودی جدید: {winner.chips}).\n"
                f"برای دست بعدی `/startgame` بزنید."
            ),
            parse_mode="Markdown",
        )

    async def showdown(self, table: PokerTable, context: ContextTypes.DEFAULT_TYPE) -> None:
        contenders = table.contenders()
        scores = []
        reveal_lines = ["🃏 **نتیجه Showdown:**"]

        for p in contenders:
            score = self.evaluator.evaluate(table.community_cards, p.hand)
            rank_class = self.evaluator.class_to_string(self.evaluator.get_rank_class(score))
            scores.append((score, p))
            reveal_lines.append(
                f"• **{p.name}**: {self.format_cards(p.hand)} → *{rank_class}*"
            )

        # در treys امتیاز کمتر یعنی دست قوی‌تر (۱ بهترین دست ممکن است)
        best_score = min(item[0] for item in scores)
        winners = [p for score, p in scores if score == best_score]
        share = table.pot // len(winners)
        remainder = table.pot % len(winners)

        for idx, w in enumerate(winners):
            bonus = share + (1 if idx < remainder else 0)
            w.chips += bonus

        winner_names = "، ".join(w.name for w in winners)
        reveal_lines.append(f"\n🏆 **برنده پات ({table.pot} چیپ):** {winner_names}!")
        reveal_lines.append("برای دست بعدی `/startgame` بزنید.")

        table.pot = 0
        table.in_hand = False
        table.stage = "WAITING"

        await context.bot.send_message(
            chat_id=table.chat_id,
            text="\n".join(reveal_lines),
            parse_mode="Markdown",
        )

    async def handle_action(
        self, table: PokerTable, user_id: int, action: str, context: ContextTypes.DEFAULT_TYPE
    ) -> Optional[str]:
        if not table.in_hand:
            return "در حال حاضر دستی در جریان نیست."

        current_player = table.players[table.turn_idx]
        if current_player.user_id != user_id:
            return f"الان نوبت شما نیست! نوبت {current_player.name} است."

        to_call = max(0, table.current_highest_bet - current_player.current_bet)

        if action == "fold":
            current_player.folded = True
            current_player.acted_in_round = True
        elif action == "call":
            pay = min(to_call, current_player.chips)
            current_player.chips -= pay
            current_player.current_bet += pay
            current_player.total_hand_bet += pay
            table.pot += pay
            current_player.acted_in_round = True
        elif action == "raise":
            target_bet = table.current_highest_bet + RAISE_STEP
            needed = max(0, target_bet - current_player.current_bet)
            pay = min(needed, current_player.chips)
            if pay == 0:
                return "چیپ کافی برای Raise ندارید."
            current_player.chips -= pay
            current_player.current_bet += pay
            current_player.total_hand_bet += pay
            table.pot += pay
            if current_player.current_bet > table.current_highest_bet:
                table.current_highest_bet = current_player.current_bet
                # بقیه بازیکنان باید به Raise جدید واکنش بدهند
                for p in table.players:
                    if p.user_id != current_player.user_id and not p.folded and p.chips > 0:
                        p.acted_in_round = False
            current_player.acted_in_round = True

        self._advance_turn(table)
        await self.send_turn_prompt(table, context)
        return None


manager = PokerManager()


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "سلام! به ربات **پوکر تگزاس هولدم** خوش آمدید.\n\n"
        "دستورات در گروه:\n"
        "• `/newtable` — ساخت میز جدید\n"
        "• `/join` — ورود به میز (با 1000 چیپ اولیه)\n"
        "• `/startgame` — شروع یک دست جدید\n\n"
        "⚠️ حتماً یک بار در **پیام خصوصی (PV)** به من `/start` بزنید تا بتوانم کارت‌های دستتان را برایتان بفرستم.",
        parse_mode="Markdown",
    )


async def cmd_newtable(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    if chat.type == "private":
        await update.message.reply_text("این دستور را داخل یک **گروه** بفرستید تا میز ساخته شود.")
        return

    table = PokerTable(chat_id=chat.id)
    manager.tables[chat.id] = table
    await update.message.reply_text(
        "🎲 میز جدید پوکر ساخته شد! بازیکنان با `/join` وارد شوند و سپس `/startgame` بزنید."
    )


async def cmd_join(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    user = update.effective_user
    if chat.type == "private":
        await update.message.reply_text("برای ورود به میز، در گروه `/join` را بزنید.")
        return

    table = manager.get_or_create_table(chat.id)
    if table.in_hand:
        await update.message.reply_text("دست فعلی در حال اجراست؛ صبر کنید تا دست تمام شود.")
        return

    if any(p.user_id == user.id for p in table.players):
        await update.message.reply_text("شما همین الان هم در میز هستید!")
        return

    if len(table.players) >= 6:
        await update.message.reply_text("ظرفیت میز (۶ نفر) پر است.")
        return

    name = user.first_name or user.username or str(user.id)
    table.players.append(Player(user_id=user.id, name=name, chips=STARTING_CHIPS))
    await update.message.reply_text(
        f"✅ **{name}** به میز پیوست! (تعداد بازیکنان: {len(table.players)})",
        parse_mode="Markdown",
    )


async def cmd_startgame(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    if chat.type == "private":
        await update.message.reply_text("شروع بازی باید داخل گروه انجام شود.")
        return

    table = manager.get_or_create_table(chat.id)
    async with table.lock:
        if table.in_hand:
            await update.message.reply_text("هم‌اکنون یک دست در جریان است.")
            return
        await manager.start_new_hand(table, context)


async def on_button_click(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    user = update.effective_user
    data = query.data or ""

    parts = data.split(":")
    if len(parts) != 3 or parts[0] != "act":
        await query.answer()
        return

    chat_id = int(parts[1])
    action = parts[2]
    table = manager.tables.get(chat_id)
    if not table:
        await query.answer("میز پیدا نشد.", show_alert=True)
        return

    async with table.lock:
        error_msg = await manager.handle_action(table, user.id, action, context)
        if error_msg:
            await query.answer(error_msg, show_alert=True)
        else:
            await query.answer("اکشن ثبت شد.")


def main() -> None:
    token = os.environ.get("BOT_TOKEN")
    if not token:
        raise RuntimeError("متغیر محیطی BOT_TOKEN تنظیم نشده است.")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("newtable", cmd_newtable))
    app.add_handler(CommandHandler("join", cmd_join))
    app.add_handler(CommandHandler("startgame", cmd_startgame))
    app.add_handler(CallbackQueryHandler(on_button_click))

    logger.info("Poker bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()