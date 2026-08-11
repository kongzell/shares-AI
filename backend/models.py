from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    watchlist = relationship("Watchlist", back_populates="owner", cascade="all, delete")


class Watchlist(Base):
    __tablename__ = "watchlist"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    symbol = Column(String(20), nullable=False)
    added_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="watchlist")

    # กันเพิ่มหุ้นซ้ำในคนเดียวกัน
    __table_args__ = (UniqueConstraint("user_id", "symbol", name="uq_user_symbol"),)