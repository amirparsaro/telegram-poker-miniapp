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
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")
ADMIN_IDS = [int(x.strip()) for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip().isdigit()]

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

async def broadcast_all_tables():
    """Broadcasts table lists to all connected clients."""
    table_list = game_manager.list_tables()
    msg = json.dumps({"type": "tables_list", "tables": table_list})
    for conns in table_connections.values():
        for ws in list(conns):
            try:
                ws.write_message(msg)
            except Exception:
                pass

async def check_bot_turn(table: PokerTable):
    """If the current turn belongs to a bot, take an automated decision after a short delay."""
    while table.in_hand:
        current_player = table.players[table.turn_idx]
        if not current_player.is_bot:
            break

        await asyncio.sleep(1.2)
        to_call = max(0, table.current_highest_bet - current_player.current_bet)
        
        if to_call == 0:
            action = "call"
        elif to_call <= current_player.chips * 0.2:
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
        self.is_admin = False

        # Check if user matches admin criteria
        admin_token = self.get_argument("admin_token", "")
        if (admin_token and admin_token == ADMIN_SECRET) or (self.user_id in ADMIN_IDS):
            self.is_admin = True

        if self.table_id not in table_connections:
            table_connections[self.table_id] = set()
        table_connections[self.table_id].add(self)

        # Ensure user is removed from any previous table they were at
        affected_old_tables = game_manager.remove_player_from_all_tables(self.user_id, except_table_id=self.table_id)
        for old_tid in affected_old_tables:
            old_table = game_manager.tables.get(old_tid)
            if old_table:
                asyncio.create_task(broadcast_table_state(old_table))

        table = game_manager.get_or_create_table(self.table_id)
        try:
            game_manager.add_player(
                table_id=self.table_id,
                user_id=self.user_id,
                name=self.user_name,
                avatar=self.user_avatar
            )
        except Exception as e:
            logger.warning("Could not add player: %s", e)

        logger.info(f"Client {self.user_name} ({self.user_id}, Admin={self.is_admin}) joined table {self.table_id}")
        
        # Send initial confirmation including admin status
        self.write_message(json.dumps({
            "type": "init",
            "is_admin": self.is_admin,
            "user_id": self.user_id,
            "tables": game_manager.list_tables()
        }))

        asyncio.create_task(broadcast_table_state(table))
        asyncio.create_task(broadcast_all_tables())

    async def on_message(self, message):
        try:
            payload = json.loads(message)
            msg_type = payload.get("type")
            table = game_manager.get_or_create_table(self.table_id)

            # Player Actions
            if msg_type == "start_game":
                # Check permission: Only table creator or admin can start the game
                can_start = self.is_admin or (table.creator_id is not None and table.creator_id == self.user_id) or (table.creator_id is None and self.is_admin)
                if not can_start:
                    return self.write_message(json.dumps({
                        "type": "error", 
                        "message": "Only the room creator or an admin can start the game."
                    }))

                async with table.lock:
                    if not table.in_hand:
                        started = game_manager.start_hand(table)
                        if not started:
                            self.write_message(json.dumps({
                                "type": "error",
                                "message": table.last_log or "Cannot start game yet (need at least 2 players)."
                            }))
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
                bot_names = ["PokerBot Alex", "Card Shark Sam", "Bluff Master Leo", "Lucky Daisy", "Ace Hunter", "Chip King"]
                existing_names = [p.name for p in table.players]
                available = [n for n in bot_names if n not in existing_names]
                bot_name = available[0] if available else f"Bot_{len(table.players)}"
                bot_id = random.randint(900000, 999999)
                try:
                    game_manager.add_player(self.table_id, bot_id, bot_name, is_bot=True)
                    await broadcast_table_state(table)
                    await broadcast_all_tables()
                except Exception as e:
                    self.write_message(json.dumps({"type": "error", "message": str(e)}))

            # --- ROOM MANAGEMENT ---
            elif msg_type == "create_room":
                room_name = payload.get("name", "").strip()
                if not room_name:
                    return self.write_message(json.dumps({"type": "error", "message": "Room name cannot be empty."}))
                new_table_id = f"room_{random.randint(100, 9999)}"
                game_manager.create_table(new_table_id, name=room_name, creator_id=self.user_id)
                await broadcast_all_tables()
                self.write_message(json.dumps({"type": "room_created", "table_id": new_table_id}))

            elif msg_type == "delete_room":
                del_id = payload.get("table_id")
                target_table = game_manager.tables.get(del_id)
                if not target_table:
                    return self.write_message(json.dumps({"type": "error", "message": "Room not found."}))
                
                # Check permission: Only creator or admin can delete
                can_delete = self.is_admin or (target_table.creator_id is not None and target_table.creator_id == self.user_id)
                if not can_delete:
                    return self.write_message(json.dumps({"type": "error", "message": "Only the room creator or an admin can delete this room."}))
                
                if del_id == self.table_id:
                    return self.write_message(json.dumps({"type": "error", "message": "Cannot delete active table while connected to it."}))

                game_manager.delete_table(del_id)
                await broadcast_all_tables()

            # --- ADMIN COMMANDS ---
            elif msg_type == "admin_auth":
                token = payload.get("token")
                if token and ADMIN_SECRET and token == ADMIN_SECRET:
                    self.is_admin = True
                    self.write_message(json.dumps({"type": "admin_auth_success"}))
                else:
                    self.write_message(json.dumps({"type": "error", "message": "Invalid Admin Password"}))

            elif msg_type == "admin_logout":
                self.is_admin = False
                self.write_message(json.dumps({"type": "admin_logout_success"}))

            elif msg_type == "admin_create_table":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                new_table_id = payload.get("table_id") or f"table_{random.randint(100, 999)}"
                new_name = payload.get("name") or f"Table {new_table_id}"
                game_manager.create_table(new_table_id, new_name)
                await broadcast_all_tables()

            elif msg_type == "admin_delete_table":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                del_id = payload.get("table_id")
                if del_id == self.table_id:
                    return self.write_message(json.dumps({"type": "error", "message": "Cannot delete active table while connected to it."}))
                game_manager.delete_table(del_id)
                await broadcast_all_tables()

            elif msg_type == "admin_remove_player":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                target_user_id = int(payload.get("user_id"))
                async with table.lock:
                    game_manager.remove_player(self.table_id, target_user_id)
                    await broadcast_table_state(table)
                    await broadcast_all_tables()

            elif msg_type == "admin_set_chips":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                target_user_id = int(payload.get("user_id"))
                new_chips = int(payload.get("chips", 1000))
                async with table.lock:
                    game_manager.set_player_chips(self.table_id, target_user_id, new_chips)
                    await broadcast_table_state(table)

            elif msg_type == "admin_reset_hand":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                async with table.lock:
                    game_manager.reset_hand(table)
                    await broadcast_table_state(table)

            elif msg_type == "admin_force_start":
                if not self.is_admin:
                    return self.write_message(json.dumps({"type": "error", "message": "Admin privileges required"}))
                async with table.lock:
                    game_manager.start_hand(table)
                    await broadcast_table_state(table)
                asyncio.create_task(check_bot_turn(table))

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
    logger.info(f"Poker Mini App Server with Admin Features running at http://0.0.0.0:{PORT}")
    tornado.ioloop.IOLoop.current().start()
