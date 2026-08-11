from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import stocks, alert
from routers import stocks, alert, auth_router
from routers import stocks, alert, auth_router, watchlist

app = FastAPI(
    title="ระบบพยากรณ์ราคาหลักทรัพย์",
    description="แสดงราคารายชั่วโมง + พยากรณ์ราคาปิดวันถัดไป",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
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