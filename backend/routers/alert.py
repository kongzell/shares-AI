from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import time
import threading
import yfinance as yf
import pandas as pd

from database import get_db
from auth import get_current_user
import models

router = APIRouter(tags=["แจ้งเตือน"])

# ===== เกณฑ์ตรวจจับการทุ่มตลาด =====
# ตรวจหลายกรอบเวลา เพราะการทุ่มตลาดมีทั้งแบบกระแทกทีเดียวจบ (1 นาที)
# และแบบทยอยเทขายต่อเนื่อง (3-5 นาที) เกณฑ์ % จึงต่างกันตามความยาวกรอบ
DUMP_WINDOWS = {
    1: -0.5,   # ดิ่ง 0.5% ในนาทีเดียว
    2: -0.7,
    3: -0.9,
    4: -1.1,
    5: -1.3,   # ดิ่งสะสม 1.3% ใน 5 นาที
}
DUMP_VOL_MULT = 2.0        # ปริมาณต้องมากกว่าค่าเฉลี่ยกี่เท่าจึงถือว่าเป็นการเทขาย
VOL_BASELINE_BARS = 20     # ฐานเฉลี่ยปริมาณ = 20 แท่งล่าสุด (นาที ไม่ใช่วัน)
MIN_BARS = 25              # ต้องมีแท่งอย่างน้อยเท่านี้จึงประเมินได้
CACHE_TTL_SEC = 20         # กัน yfinance โดนยิงซ้ำเมื่อมีหลายแท็บ/หลายผู้ใช้
MAX_PARALLEL = 8           # จำนวน symbol ที่ดึงพร้อมกันตอนสแกน watchlist

_cache = {}
_cache_lock = threading.Lock()


def flatten_columns(data):
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)
    return data


def load_intraday(symbol: str):
    """
    ดึงข้อมูลระดับนาทีของรอบซื้อขายล่าสุด พร้อม cache อายุสั้น
    ถ้า 1 นาทีไม่พอ (บางตลาด/บางช่วง) จะถอยไปใช้ 5 นาที
    """
    key = symbol.upper()
    now = time.time()

    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_SEC:
            return hit[1]

    # ใช้ 2d ไม่ใช่ 1d เพราะ period="1d" คือย้อนหลัง 24 ชม. จากตอนนี้
    # ตลาดที่เพิ่งเปิดจะได้ข้อมูลว่าง แล้วตกไปใช้แท่ง 5 นาทีทั้งที่ควรได้ 1 นาที
    result = (None, None, None)
    for period, interval, minutes in (("2d", "1m", 1), ("5d", "5m", 5)):
        try:
            data = yf.download(symbol, period=period, interval=interval,
                               auto_adjust=True, progress=False)
        except Exception:
            continue
        if data.empty:
            continue
        # ตัดแท่งที่ยังไม่มีราคาซื้อขายจริงทิ้ง ไม่งั้น NaN จะหลุดไปถึง response
        data = flatten_columns(data).dropna(subset=["Close"])
        if len(data) >= MIN_BARS:
            result = (data, interval, minutes)
            break

    with _cache_lock:
        _cache[key] = (now, result)
    return result


def detect_dump(df, bar_minutes):
    """
    ทุ่มตลาด: ราคาดิ่งแรงภายใน 1-5 นาที พร้อมปริมาณซื้อขายพุ่งผิดปกติ
    ไล่ตรวจทุกกรอบเวลาแล้วเลือกกรอบที่รุนแรงที่สุด (ดิ่งเกินเกณฑ์มากที่สุด)
    """
    best = None

    for window_min, drop_limit in DUMP_WINDOWS.items():
        if window_min < bar_minutes:
            continue                       # กรอบสั้นกว่าความละเอียดข้อมูล ตรวจไม่ได้
        bars = max(1, round(window_min / bar_minutes))
        if len(df) < bars + 1:
            continue

        start = float(df["Close"].iloc[-bars - 1])
        now = float(df["Close"].iloc[-1])
        if start == 0:
            continue
        change = (now - start) / start * 100

        vol_recent = float(df["Volume"].iloc[-bars:].sum())
        vol_baseline = float(df["VolAvg"].iloc[-1]) * bars
        if vol_baseline <= 0 or pd.isna(vol_baseline):
            continue
        vol_ratio = vol_recent / vol_baseline

        if change > drop_limit or vol_ratio < DUMP_VOL_MULT:
            continue

        # ยิ่งดิ่งเกินเกณฑ์มาก ยิ่งถือว่ารุนแรงกว่า
        excess = change - drop_limit
        if best is None or excess < best["excess"]:
            best = {
                "excess": excess,
                "window": window_min,
                "change": change,
                "vol_ratio": vol_ratio,
            }

    if best is None:
        return None

    severe = best["change"] <= best["window"] * -0.8 or best["vol_ratio"] >= 4
    return {
        "method": "ทุ่มตลาด",
        "severity": "high" if severe else "medium",
        "message": (
            f"ราคาดิ่ง {abs(best['change']):.2f}% ใน {best['window']} นาที "
            f"พร้อมปริมาณซื้อขาย {best['vol_ratio']:.1f} เท่าของปกติ"
        ),
        "value": round(best["change"], 2),
        "window_minutes": best["window"],
    }


def analyze(symbol: str):
    """ประเมินหุ้นหนึ่งตัว คืน None ถ้าข้อมูลไม่พอ"""
    data, interval, bar_minutes = load_intraday(symbol)
    if data is None:
        return None

    df = data[["Open", "High", "Low", "Close", "Volume"]].copy()
    df["Return"] = df["Close"].pct_change()
    df["VolAvg"] = df["Volume"].rolling(VOL_BASELINE_BARS).mean()
    df = df.dropna(subset=["Return", "VolAvg"])
    if len(df) < 2:
        return None

    alert = detect_dump(df, bar_minutes)

    last_ts = df.index[-1]
    if last_ts.tz is None:
        last_ts = last_ts.tz_localize("UTC")
    age_minutes = (pd.Timestamp.now(tz="UTC") - last_ts).total_seconds() / 60

    return {
        "symbol": symbol.upper(),
        "has_anomaly": alert is not None,
        "alerts": [alert] if alert else [],
        # ข้อมูลถือว่า "สด" เมื่อแท่งล่าสุดเพิ่งปิดไปไม่นาน
        # ถ้าไม่สด สัญญาณที่เจอคือของอดีต ไม่ใช่สิ่งที่กำลังเกิดขึ้น
        "is_live": age_minutes <= max(15, bar_minutes * 3),
        "interval": interval,
        "last_updated": last_ts.tz_convert("Asia/Bangkok").strftime("%Y-%m-%d %H:%M"),
        "data_age_minutes": round(age_minutes),
        "latest_price": round(float(df["Close"].iloc[-1]), 2),
        "latest_change_percent": round(float(df["Return"].iloc[-1]) * 100, 2),
    }


@router.get("/alert/watchlist")
def check_watchlist(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    เฝ้าระวังการทุ่มตลาดของหุ้นใน watchlist ของผู้ใช้ (เฉพาะของตัวเอง)
    ตรวจทุกตัวพร้อมกันเพื่อให้ตอบเร็วพอสำหรับการเรียกถี่ ๆ
    """
    symbols = [
        item.symbol
        for item in db.query(models.Watchlist)
        .filter(models.Watchlist.user_id == current_user.id)
        .order_by(models.Watchlist.added_at.desc())
        .all()
    ]

    if not symbols:
        return {
            "checked": 0,
            "alert_count": 0,
            "has_anomaly": False,
            "results": [],
            "skipped": [],
        }

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        raw = list(pool.map(analyze, symbols))

    results = [r for r in raw if r]
    skipped = [s for s, r in zip(symbols, raw) if r is None]
    alerting = [r for r in results if r["has_anomaly"]]

    return {
        "checked": len(results),
        "alert_count": sum(len(r["alerts"]) for r in alerting),
        "has_anomaly": len(alerting) > 0,
        "results": results,
        "skipped": skipped,
    }


@router.get("/alert/{symbol}")
def check_alerts(symbol: str):
    """ตรวจหุ้นตัวเดียว (ใช้ทดสอบ / เรียกตรงโดยไม่ต้องล็อกอิน)"""
    result = analyze(symbol)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"ไม่พบข้อมูลระดับนาทีของ {symbol}",
        )
    result["alert_count"] = len(result["alerts"])
    return result
