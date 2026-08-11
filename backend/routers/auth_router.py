from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db
from auth import verify_password, create_token, get_current_user
import models

router = APIRouter(tags=["ผู้ใช้"])


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == payload.username).first()

    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
        )

    return {
        "access_token": create_token(user.username),
        "token_type": "bearer",
        "username": user.username,
    }


@router.get("/me")
def read_me(current_user: models.User = Depends(get_current_user)):
    """เช็คว่า login อยู่ไหม (ต้องส่ง token มาด้วย)"""
    return {
        "id": current_user.id,
        "username": current_user.username,
    }