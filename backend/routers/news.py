from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import threading
import time
import yfinance as yf

from database import get_db
from auth import get_current_user
import models

router = APIRouter(prefix="/news", tags=["ข่าว"])

MAX_AGE_DAYS = 7       # เอาเฉพาะข่าวภายใน 1 สัปดาห์
MAX_PER_SYMBOL = 8     # กันไม่ให้หุ้นตัวเดียวกินพื้นที่แถบข่าวทั้งหมด
MAX_TOTAL = 40         # แถบวิ่งยาวเกินนี้ผู้ใช้ก็รอดูไม่ไหว
CACHE_TTL_SEC = 600    # ข่าวไม่ได้ออกทุกนาที ดึงใหม่ทุก 10 นาทีพอ
MAX_PARALLEL = 8

_cache = {}
_cache_lock = threading.Lock()


def _parse_time(value):
    """pubDate จาก yfinance มาเป็น ISO ลงท้ายด้วย Z ซึ่ง fromisoformat เก่าอ่านไม่ได้"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def load_news(symbol: str):
    """ดึงข่าวของหุ้นตัวเดียว พร้อม cache กัน yfinance โดนยิงซ้ำจากหลายผู้ใช้"""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(symbol)
        if hit and now - hit[0] < CACHE_TTL_SEC:
            return hit[1]

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    items = []
    try:
        raw = yf.Ticker(symbol).news or []
    except Exception:
        raw = []

    for entry in raw:
        # yfinance รุ่นใหม่ห่อเนื้อหาไว้ใน key "content" รุ่นเก่าวางไว้ชั้นบนสุด
        content = entry.get("content") or entry
        published = _parse_time(content.get("pubDate") or content.get("displayTime"))
        if not published or published < cutoff:
            continue

        title = (content.get("title") or "").strip()
        if not title:
            continue

        link = ""
        for key in ("clickThroughUrl", "canonicalUrl"):
            target = content.get(key)
            if isinstance(target, dict) and target.get("url"):
                link = target["url"]
                break

        provider = content.get("provider")
        publisher = provider.get("displayName", "") if isinstance(provider, dict) else ""

        items.append({
            "id": str(content.get("id") or link or title),
            "symbol": symbol,
            "title": title,
            "publisher": publisher,
            "link": link,
            "published_at": published.isoformat(),
            "age_hours": round((datetime.now(timezone.utc) - published).total_seconds() / 3600, 1),
        })

    items.sort(key=lambda x: x["published_at"], reverse=True)
    items = items[:MAX_PER_SYMBOL]

    with _cache_lock:
        _cache[symbol] = (now, items)
    return items


@router.get("/watchlist")
def watchlist_news(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """ข่าวภายใน 1 สัปดาห์ของหุ้นใน watchlist ตัวเอง เรียงใหม่สุดขึ้นก่อน"""
    symbols = [
        item.symbol
        for item in db.query(models.Watchlist)
        .filter(models.Watchlist.user_id == current_user.id)
        .all()
    ]

    if not symbols:
        return {"count": 0, "days": MAX_AGE_DAYS, "items": []}

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        batches = list(pool.map(load_news, symbols))

    # ข่าวชิ้นเดียวกันโผล่ได้หลายหุ้น (เช่นข่าวอุตสาหกรรม) จึงตัดซ้ำด้วย id
    seen = set()
    items = []
    for batch in batches:
        for item in batch:
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            items.append(item)

    items.sort(key=lambda x: x["published_at"], reverse=True)
    items = items[:MAX_TOTAL]

    return {"count": len(items), "days": MAX_AGE_DAYS, "items": items}
