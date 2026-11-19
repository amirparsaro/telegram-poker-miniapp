import asyncio
import logging
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from engine import Deck, evaluate_hand, card_to_dict

logger = logging.getLogger(__name__)

SMALL_BLIND = 10
BIG_BLIND = 20
RAISE_STEP = 20
STARTING_CHIPS = 1000

@dataclass
class Player:
    user_id: int
    name: str
    avatar: str = ""
    chips: int = STARTING_CHIPS
    hand: List[tuple] = field(default_factory=list)
    current_bet: int = 0
    total_hand_bet: int = 0
    folded: bool = False
    acted_in_round: bool = False
    is_bot: bool = False

    def to_dict(self, show_hand: bool = False):
        return {
            "user_id": self.user_id,
            "name": self.name,
            "avatar": self.avatar,
            "chips": self.chips,
            "current_bet": self.current_bet,
            "total_hand_bet": self.total_hand_bet,
            "folded": self.folded,
            "acted_in_round": self.acted_in_round,
            "is_bot": self.is_bot,
            "hand": [card_to_dict(c) for c in self.hand] if show_hand else [{"hidden": True} for _ in self.hand]
        }

@dataclass
class PokerTable:
    table_id: str
    name: str = "Main Room"
    creator_id: Optional[int] = None
    players: List[Player] = field(default_factory=list)
    in_hand: bool = False
    stage: str = "WAITING"  # WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
    deck: Optional[Deck] = None
    community_cards: List[tuple] = field(default_factory=list)
    pot: int = 0
    dealer_idx: int = 0
    turn_idx: int = 0
    current_highest_bet: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_log: str = ""
    winner_info: Optional[dict] = None

    def active_players(self) -> List[Player]:
        return [p for p in self.players if not p.folded and (p.chips > 0 or p.total_hand_bet > 0)]

    def contenders(self) -> List[Player]:
        return [p for p in self.players if not p.folded]

    def to_state_dict(self, for_user_id: Optional[int] = None) -> dict:
        is_showdown = self.stage == "SHOWDOWN" or not self.in_hand
        players_data = []
        for p in self.players:
            show_hand = is_showdown or (for_user_id is not None and p.user_id == for_user_id)
            players_data.append(p.to_dict(show_hand=show_hand))

        current_player = self.players[self.turn_idx] if (self.in_hand and self.players) else None
        to_call = 0
        if current_player:
            to_call = max(0, self.current_highest_bet - current_player.current_bet)

        return {
            "table_id": self.table_id,
            "name": self.name,
            "creator_id": self.creator_id,
            "in_hand": self.in_hand,
            "stage": self.stage,
            "pot": self.pot,
            "dealer_idx": self.dealer_idx,
            "turn_idx": self.turn_idx,
            "current_highest_bet": self.current_highest_bet,
            "community_cards": [card_to_dict(c) for c in self.community_cards],
            "players": players_data,
            "turn_user_id": current_player.user_id if current_player else None,
            "to_call": to_call,
            "small_blind": SMALL_BLIND,
            "big_blind": BIG_BLIND,
            "raise_step": RAISE_STEP,
            "last_log": self.last_log,
            "winner_info": self.winner_info
        }


class GameManager:
    def __init__(self):
        self.tables: Dict[str, PokerTable] = {}
        # Create default table
        self.create_table("main_room", "Standard Table")

    def create_table(self, table_id: str, name: str = "", creator_id: Optional[int] = None) -> PokerTable:
        if not name:
            name = f"Table {table_id}"
        table = PokerTable(table_id=table_id, name=name, creator_id=creator_id)
        self.tables[table_id] = table
        return table

    def delete_table(self, table_id: str) -> bool:
        if table_id in self.tables:
            del self.tables[table_id]
            return True
        return False

    def list_tables(self) -> List[dict]:
        return [
            {
                "table_id": t.table_id,
                "name": t.name,
                "creator_id": t.creator_id,
                "player_count": len(t.players),
                "in_hand": t.in_hand,
                "stage": t.stage,
                "pot": t.pot,
                "players": [
                    {
                        "user_id": p.user_id,
                        "name": p.name,
                        "avatar": p.avatar,
                        "chips": p.chips,
                        "is_bot": p.is_bot
                    }
                    for p in t.players
                ]
            }
            for t in self.tables.values()
        ]

    def remove_player_from_all_tables(self, user_id: int, except_table_id: Optional[str] = None) -> List[str]:
        """Removes a user from all tables (except optionally one) and returns affected table IDs."""
        affected = []
        for tid, table in list(self.tables.items()):
            if except_table_id and tid == except_table_id:
                continue
            if any(p.user_id == user_id for p in table.players):
                self.remove_player(tid, user_id)
                affected.append(tid)
        return affected

    def get_or_create_table(self, table_id: str) -> PokerTable:
        if table_id not in self.tables:
            self.create_table(table_id)
        return self.tables[table_id]

    def add_player(self, table_id: str, user_id: int, name: str, avatar: str = "", is_bot: bool = False, chips: int = STARTING_CHIPS) -> Player:
        table = self.get_or_create_table(table_id)
        for p in table.players:
            if p.user_id == user_id:
                p.name = name
                if avatar:
                    p.avatar = avatar
                return p
        if len(table.players) >= 6:
            raise ValueError("Table is full (max 6 players)")
        player = Player(user_id=user_id, name=name, avatar=avatar, chips=chips, is_bot=is_bot)
        table.players.append(player)
        table.last_log = f"{name} joined table {table.name}."
        return player

    def remove_player(self, table_id: str, user_id: int) -> Optional[Player]:
        if table_id not in self.tables:
            return None
        table = self.tables[table_id]
        target = next((p for p in table.players if p.user_id == user_id), None)
        if not target:
            return None

        # If in hand and player is in hand, fold them first
        if table.in_hand and not target.folded:
            target.folded = True
            contenders = table.contenders()
            if len(contenders) <= 1:
                if len(contenders) == 1:
                    self.finish_hand_by_fold(table, contenders[0])
                else:
                    self.reset_hand(table)

        table.players = [p for p in table.players if p.user_id != user_id]
        if table.players:
            table.turn_idx = table.turn_idx % len(table.players)
            table.dealer_idx = table.dealer_idx % len(table.players)
        else:
            self.reset_hand(table)

        table.last_log = f"{target.name} was removed from the table."
        return target

    def set_player_chips(self, table_id: str, user_id: int, chips: int) -> bool:
        if table_id not in self.tables:
            return False
        table = self.tables[table_id]
        p = next((p for p in table.players if p.user_id == user_id), None)
        if p:
            p.chips = max(0, chips)
            table.last_log = f"{p.name}'s chips updated to {p.chips}."
            return True
        return False

    def reset_hand(self, table: PokerTable):
        table.in_hand = False
        table.stage = "WAITING"
        table.pot = 0
        table.community_cards = []
        table.current_highest_bet = 0
        table.winner_info = None
        for p in table.players:
            p.current_bet = 0
            p.total_hand_bet = 0
            p.folded = False
            p.acted_in_round = False
            p.hand = []
        table.last_log = "Game was reset by administrator."

    def _post_blind(self, table: PokerTable, player: Player, amount: int):
        paid = min(player.chips, amount)
        player.chips -= paid
        player.current_bet += paid
        player.total_hand_bet += paid
        table.pot += paid

    def _advance_turn(self, table: PokerTable):
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

    def start_hand(self, table: PokerTable) -> bool:
        eligible = [p for p in table.players if p.chips > 0]
        if len(eligible) < 2:
            table.in_hand = False
            table.stage = "WAITING"
            table.last_log = "Need at least 2 players with chips to start."
            return False

        table.players = eligible
        table.in_hand = True
        table.stage = "PREFLOP"
        table.deck = Deck()
        table.community_cards = []
        table.pot = 0
        table.current_highest_bet = 0
        table.winner_info = None
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

        table.turn_idx = (bb_idx + 1) % n
        if table.players[table.turn_idx].folded:
            self._advance_turn(table)

        table.last_log = f"Hand started! Blinds: {SMALL_BLIND}/{BIG_BLIND}. Turn: {table.players[table.turn_idx].name}."
        return True

    def next_stage(self, table: PokerTable):
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
            self.showdown(table)
            return

        n = len(table.players)
        table.turn_idx = table.dealer_idx
        self._advance_turn(table)

        can_act = [p for p in table.players if not p.folded and p.chips > 0]
        if len(can_act) <= 1:
            self.next_stage(table)
            return

        table.last_log = f"Stage: {table.stage}. Turn: {table.players[table.turn_idx].name}."

    def finish_hand_by_fold(self, table: PokerTable, winner: Player):
        winner.chips += table.pot
        won_amount = table.pot
        table.last_log = f"{winner.name} won {won_amount} chips (all other players folded)!"
        table.winner_info = {
            "type": "fold",
            "winners": [winner.name],
            "pot": won_amount,
            "description": "Everyone else folded."
        }
        table.pot = 0
        table.in_hand = False
        table.stage = "WAITING"

    def showdown(self, table: PokerTable):
        contenders = table.contenders()
        scores = []
        for p in contenders:
            all_cards = table.community_cards + p.hand
            rank_type, tiebreakers, desc = evaluate_hand(all_cards)
            scores.append((rank_type, tiebreakers, desc, p))

        scores.sort(key=lambda s: (s[0], s[1]), reverse=True)
        best_score = (scores[0][0], scores[0][1])

        winners = [item[3] for item in scores if (item[0], item[1]) == best_score]
        best_desc = scores[0][2]

        share = table.pot // len(winners)
        remainder = table.pot % len(winners)

        for idx, w in enumerate(winners):
            bonus = share + (1 if idx < remainder else 0)
            w.chips += bonus

        winner_names = ", ".join(w.name for w in winners)
        table.last_log = f"Showdown! {winner_names} won {table.pot} chips with {best_desc}!"
        table.winner_info = {
            "type": "showdown",
            "winners": [w.name for w in winners],
            "pot": table.pot,
            "description": best_desc,
            "hands": [{"name": item[3].name, "desc": item[2]} for item in scores]
        }
        table.pot = 0
        table.in_hand = False
        table.stage = "WAITING"

    def handle_action(self, table: PokerTable, user_id: int, action: str, raise_amount: Optional[int] = None) -> Optional[str]:
        if not table.in_hand:
            return "No hand in progress."

        current_player = table.players[table.turn_idx]
        if current_player.user_id != user_id:
            return f"Not your turn! It's {current_player.name}'s turn."

        to_call = max(0, table.current_highest_bet - current_player.current_bet)

        if action == "fold":
            current_player.folded = True
            current_player.acted_in_round = True
            table.last_log = f"{current_player.name} folded."
        elif action == "call":
            pay = min(to_call, current_player.chips)
            current_player.chips -= pay
            current_player.current_bet += pay
            current_player.total_hand_bet += pay
            table.pot += pay
            current_player.acted_in_round = True
            action_name = "checked" if to_call == 0 else f"called {pay}"
            table.last_log = f"{current_player.name} {action_name}."
        elif action == "raise":
            step = raise_amount if raise_amount and raise_amount >= RAISE_STEP else RAISE_STEP
            target_bet = table.current_highest_bet + step
            needed = max(0, target_bet - current_player.current_bet)
            pay = min(needed, current_player.chips)
            if pay == 0:
                return "Not enough chips to raise."
            current_player.chips -= pay
            current_player.current_bet += pay
            current_player.total_hand_bet += pay
            table.pot += pay
            if current_player.current_bet > table.current_highest_bet:
                table.current_highest_bet = current_player.current_bet
                for p in table.players:
                    if p.user_id != current_player.user_id and not p.folded and p.chips > 0:
                        p.acted_in_round = False
            current_player.acted_in_round = True
            table.last_log = f"{current_player.name} raised to {current_player.current_bet}."

        contenders = table.contenders()
        if len(contenders) == 1:
            self.finish_hand_by_fold(table, contenders[0])
            return None

        if self._is_betting_round_complete(table):
            self.next_stage(table)
            return None

        self._advance_turn(table)
        return None
