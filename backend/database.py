from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

# เผื่อตอน deploy — Render บางทีให้ postgres:// ต้องแปลงก่อน
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """เชื่อม database ในแต่ละ request แล้วปิดเมื่อเสร็จ"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()