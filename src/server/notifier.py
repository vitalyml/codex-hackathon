"""Where events go. The base logs; src/server/telegram adds the chat."""

from typing import Optional

from loguru import logger

from src.server.session import Event, Watch


class Notifier:
    async def notify(
        self, session_id: str, watch: Watch, event: Event, chat_id: Optional[int]
    ) -> None:
        """`chat_id`: the Telegram chat to alert, as worker:record decided."""
        logger.info(
            "EVENT session={} n={} {} ({} bytes)",
            session_id,
            event.n,
            event.text,
            len(event.image),
        )
