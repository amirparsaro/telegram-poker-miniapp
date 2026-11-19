import os
import json
import logging
import asyncio
import random
from typing import Dict, Set
import tornado.ioloop
import tornado.web
import tornado.websocket

from game_manager import GameManager, PokerTable

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

game_manager = GameManager()

# Table subscribers: table_id -> Set[PokerWebSocketHandler]
table_connections: Dict[str, Set["PokerWebSocketHandler"]] = {}

async def broadcast_table_state(table: PokerTable):
    connections = table_connections.get(table.table_id, set())
    for ws in list(connections):
        try:
            state = table.to_state_dict(for_user_id=ws.user_id)
            ws.write_message(json.dumps({"type": "state", "data": state}))
        except Exception as e:
            logger.warning("Error sending state to client: %s", e)

async def check_bot_turn(table: PokerTable):
    """If the current turn belongs to a bot, take an automated decision after a short delay."""
    while table.in_hand:
        current_player = table.players[table.turn_idx]
        if not current_player.is_bot:
            break

        await asyncio.sleep(1.2)  # Simulated human thinking time
        to_call = max(0, table.current_highest_bet - current_player.current_bet)
        
        # Simple Bot AI: Check if free, otherwise call or fold
        if to_call == 0:
            action = "call"  # Check
        elif to_call <= current_player.chips * 0.2:
            # 80% call, 20% fold/raise
            dice = random.random()
            if dice < 0.75:
                action = "call"
            elif dice < 0.9 and current_player.chips >= to_call + 20:
                action = "raise"
            else:
                action = "fold"
        else:
            dice = random.random()
            action = "call" if dice < 0.4 else "fold"

        async with table.lock:
            game_manager.handle_action(table, current_player.user_id, action)
            await broadcast_table_state(table)


class IndexHandler(tornado.web.RequestHandler):
    def get(self):
        self.render(os.path.join(STATIC_DIR, "index.html"))


class PokerWebSocketHandler(tornado.websocket.WebSocketHandler):
    def check_origin(self, origin):
        return True

    def open(self):
        self.table_id = self.get_argument("table_id", "main_room")
        self.user_id = int(self.get_argument("user_id", random.randint(1000, 9999)))
        self.user_name = self.get_argument("name", f"Player_{self.user_id}")
        self.user_avatar = self.get_argument("avatar", "")

        if self.table_id not in table_connections:
            table_connections[self.table_id] = set()
        table_connections[self.table_id].add(self)

        table = game_manager.get_or_create_table(self.table_id)
        # Register user as a player
        try:
            game_manager.add_player(
                table_id=self.table_id,
                user_id=self.user_id,
                name=self.user_name,
                avatar=self.user_avatar
            )
        except Exception as e:
            logger.warning("Could not add player: %s", e)

        logger.info(f"Client {self.user_name} ({self.user_id}) joined table {self.table_id}")
        asyncio.create_task(broadcast_table_state(table))

    async def on_message(self, message):
        try:
            payload = json.loads(message)
            msg_type = payload.get("type")
            table = game_manager.get_or_create_table(self.table_id)

            if msg_type == "start_game":
                async with table.lock:
                    if not table.in_hand:
                        game_manager.start_hand(table)
                        await broadcast_table_state(table)
                asyncio.create_task(check_bot_turn(table))

            elif msg_type == "action":
                action = payload.get("action")
                raise_amount = payload.get("raise_amount")
                async with table.lock:
                    err = game_manager.handle_action(table, self.user_id, action, raise_amount)
                    if err:
                        self.write_message(json.dumps({"type": "error", "message": err}))
                    await broadcast_table_state(table)
                asyncio.create_task(check_bot_turn(table))

            elif msg_type == "add_bot":
                bot_names = ["PokerBot Alex", "Card Shark Sam", "Bluff Master Leo", "Lucky Daisy"]
                existing_names = [p.name for p in table.players]
                available = [n for n in bot_names if n not in existing_names]
                bot_name = available[0] if available else f"Bot_{len(table.players)}"
                bot_id = random.randint(900000, 999999)
                try:
                    game_manager.add_player(self.table_id, bot_id, bot_name, is_bot=True)
                    await broadcast_table_state(table)
                except Exception as e:
                    self.write_message(json.dumps({"type": "error", "message": str(e)}))

        except Exception as e:
            logger.error("Error processing websocket message: %s", e)

    def on_close(self):
        if self.table_id in table_connections:
            table_connections[self.table_id].discard(self)
        logger.info(f"Client {self.user_id} disconnected from table {self.table_id}")


def make_app():
    return tornado.web.Application([
        (r"/", IndexHandler),
        (r"/ws", PokerWebSocketHandler),
        (r"/static/(.*)", tornado.web.StaticFileHandler, {"path": STATIC_DIR}),
    ])


if __name__ == "__main__":
    app = make_app()
    app.listen(PORT)
    logger.info(f"Poker Mini App Server running at http://localhost:{PORT}")
    tornado.ioloop.IOLoop.current().start()
