from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db
from auth import get_current_user
import models

router = APIRouter(prefix="/watchlist", tags=["Watchlist"])


class SymbolRequest(BaseModel):
    symbol: str


@router.get("")
def get_watchlist(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """ดูรายการหุ้นที่บันทึกไว้ (เฉพาะของตัวเอง)"""
    items = (
        db.query(models.Watchlist)
        .filter(models.Watchlist.user_id == current_user.id)
        .order_by(models.Watchlist.added_at.desc())
        .all()
    )
    return {
        "username": current_user.username,
        "count": len(items),
        "symbols": [item.symbol for item in items],
    }


@router.post("")
def add_to_watchlist(
    payload: SymbolRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """เพิ่มหุ้นเข้า watchlist"""
    symbol = payload.symbol.upper().strip()

    if not symbol:
        raise HTTPException(status_code=400, detail="กรุณาระบุรหัสหุ้น")

    # เช็คว่ามีอยู่แล้วไหม
    exists = (
        db.query(models.Watchlist)
        .filter(
            models.Watchlist.user_id == current_user.id,
            models.Watchlist.symbol == symbol,
        )
        .first()
    )
    if exists:
        raise HTTPException(status_code=409, detail=f"{symbol} อยู่ใน watchlist แล้ว")

    item = models.Watchlist(user_id=current_user.id, symbol=symbol)
    db.add(item)
    db.commit()

    return {"message": f"เพิ่ม {symbol} เรียบร้อย", "symbol": symbol}


@router.delete("/{symbol}")
def remove_from_watchlist(
    symbol: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """ลบหุ้นออกจาก watchlist"""
    symbol = symbol.upper().strip()

    item = (
        db.query(models.Watchlist)
        .filter(
            models.Watchlist.user_id == current_user.id,
            models.Watchlist.symbol == symbol,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail=f"ไม่พบ {symbol} ใน watchlist")

    db.delete(item)
    db.commit()

    return {"message": f"ลบ {symbol} เรียบร้อย"}