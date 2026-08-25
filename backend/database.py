from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base
from pathlib import Path

Base = declarative_base()

# Store DB next to the backend (gitignored)
DB_PATH = Path(__file__).resolve().parent / "meetly.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def run_migrations():
    """Lightweight migrations for schema changes that `create_all` can't apply
    to existing tables. Additive columns and nullable-rebuilds live here."""
    insp = inspect(engine)
    if "chat_messages" not in insp.get_table_names():
        return

    cols = {c["name"] for c in insp.get_columns("chat_messages")}
    with engine.begin() as conn:
        # 1) Add sender_name if missing
        if "sender_name" not in cols:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN sender_name VARCHAR"))
            print("migration: added chat_messages.sender_name")

        # 2) user_id must be nullable for guests. SQLite can't ALTER a NOT NULL
        #    column, so rebuild the table preserving existing rows.
        col_info = {c["name"]: c for c in insp.get_columns("chat_messages")}
        # Re-inspect after the ALTER above
        insp2 = inspect(engine)
        col_info = {c["name"]: c for c in insp2.get_columns("chat_messages")}
        user_id_notnull = col_info["user_id"].get("nullable") is False
        if user_id_notnull:
            conn.execute(text("""
                CREATE TABLE chat_messages_new (
                    id INTEGER NOT NULL,
                    room_id INTEGER NOT NULL,
                    user_id INTEGER,
                    sender_name VARCHAR,
                    text TEXT NOT NULL,
                    created_at DATETIME,
                    PRIMARY KEY (id),
                    FOREIGN KEY(room_id) REFERENCES rooms (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
            """))
            conn.execute(text("""
                INSERT INTO chat_messages_new (id, room_id, user_id, sender_name, text, created_at)
                SELECT id, room_id, user_id, sender_name, text, created_at FROM chat_messages
            """))
            conn.execute(text("DROP TABLE chat_messages"))
            conn.execute(text("ALTER TABLE chat_messages_new RENAME TO chat_messages"))
            print("migration: rebuilt chat_messages (user_id nullable, + sender_name)")

        # 3) Direct-message columns (all nullable additive columns; SQLite
        #    allows plain ADD COLUMN for these since no NOT NULL is involved)
        insp3 = inspect(engine)
        cols3 = {c["name"] for c in insp3.get_columns("chat_messages")}
        if "is_private" not in cols3:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN is_private BOOLEAN"))
            print("migration: added chat_messages.is_private")
        if "recipient_user_id" not in cols3:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN recipient_user_id INTEGER"))
            print("migration: added chat_messages.recipient_user_id")
        if "recipient_name" not in cols3:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN recipient_name VARCHAR"))
            print("migration: added chat_messages.recipient_name")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
