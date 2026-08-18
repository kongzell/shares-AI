import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from routers import stocks, alert, auth_router, watchlist, news

load_dotenv()

app = FastAPI(
    title="ระบบพยากรณ์ราคาหลักทรัพย์",
    description="แสดงราคารายชั่วโมง + พยากรณ์ราคาปิดวันถัดไป",
    version="1.0.0"
)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== รวม router =====
app.include_router(stocks.router)
app.include_router(alert.router)
app.include_router(auth_router.router)
app.include_router(watchlist.router)
app.include_router(news.router)


@app.get("/")
def read_root():
    return {"message": "API ทำงานอยู่"}