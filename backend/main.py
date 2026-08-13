import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from routers import stocks, alert, auth_router, watchlist

load_dotenv()

app = FastAPI(
    title="ระบบพยากรณ์ราคาหลักทรัพย์",
    description="แสดงราคารายชั่วโมง + พยากรณ์ราคาปิดวันถัดไป",
    version="1.0.0"
)

# โดเมนที่อนุญาตให้เรียก API ได้ คั่นด้วยจุลภาคใน environment variable
# ตอน deploy ให้ตั้ง ALLOWED_ORIGINS เป็นโดเมนของหน้าเว็บบน Cloudflare Pages
# ถ้าไม่ได้ตั้ง จะใช้ค่าเริ่มต้นสำหรับรันที่เครื่องตัวเอง
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


@app.get("/")
def read_root():
    return {"message": "API ทำงานอยู่"}