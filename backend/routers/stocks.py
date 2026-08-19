from fastapi import APIRouter, HTTPException
from pathlib import Path
import numpy as np
import threading
import time
import yfinance as yf
import pandas as pd
import onnxruntime as ort
import xgboost as xgb

router = APIRouter(tags=["หุ้น"])

# ===== path ถอยออกจาก routers/ มาที่ backend/ =====
BASE_DIR = Path(__file__).parent.parent
MODEL_DIR = BASE_DIR / "model"

# โหลดโมเดลผ่าน ONNX Runtime
models = {
    "lstm": ort.InferenceSession(str(MODEL_DIR / "multi_asset_lstm.onnx"),
                                 providers=["CPUExecutionProvider"]),
    "gru": ort.InferenceSession(str(MODEL_DIR / "gru_model.onnx"),
                                providers=["CPUExecutionProvider"]),
    "tcn": ort.InferenceSession(str(MODEL_DIR / "tcn_model.onnx"),
                                providers=["CPUExecutionProvider"]),
}

xgb_model = xgb.Booster()
xgb_model.load_model(str(MODEL_DIR / "xgboost_model.json"))
LOOKBACK = 30

# ===== แถบพยากรณ์และประวัติย้อนหลัง =====
# แถบสร้างด้วย split conformal: เอา residual จากการย้อนทำนายในอดีตมาหา quantile
CAL_WINDOW = 120           # จำนวน residual ที่ใช้สร้างแถบ
MIN_CAL_WINDOW = 40        # ต่ำกว่านี้ quantile แกว่งจนแถบเชื่อไม่ได้ ให้ซ่อนแถบแทน
HISTORY_DAYS = 21          # 1 เดือน ≈ 21 วันทำการ
BAND_LEVELS = {80: (10, 90), 90: (5, 95)}
BACKTEST_TTL_SEC = 60 * 60  # แท่งรายวันเปลี่ยนวันละครั้ง ไม่ต้องคำนวณใหม่ทุก request

_backtest_cache = {}
_backtest_lock = threading.Lock()

_currency_cache = {}


def get_currency(symbol: str) -> str:
    """ดึงสกุลเงินของหุ้น (THB, USD, ...) — จำไว้เพราะไม่เปลี่ยนและต้องยิง yfinance"""
    key = symbol.upper()
    if key in _currency_cache:
        return _currency_cache[key]
    try:
        info = yf.Ticker(symbol).fast_info
        currency = info.get("currency", "USD")
    except Exception:
        # fallback: เดาจากนามสกุล
        currency = "THB" if key.endswith(".BK") else "USD"
    _currency_cache[key] = currency
    return currency

def to_thai_time(data):
    """แปลง index เป็นเวลาไทย (กันกรณีไม่มี timezone)"""
    if data.index.tz is None:
        data.index = data.index.tz_localize("UTC")
    data.index = data.index.tz_convert("Asia/Bangkok")
    return data

def flatten_columns(data):
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)
    return data


def download_symbol(symbol: str, **kwargs):
    """
    ดึงข้อมูลจาก yfinance พร้อมเดานามสกุลตลาดไทยให้อัตโนมัติ
    จึงลองตามที่พิมพ์ก่อน ถ้าไม่เจอค่อยลองเติม .BK ให้
    คืน (ข้อมูล, ticker ที่ใช้ได้จริง) — ถ้าไม่เจอเลยคืน (None, ตามที่พิมพ์)
    """
    typed = symbol.strip().upper()
    candidates = [typed]
    # ถ้ามีจุดแสดงว่าระบุตลาดมาแล้ว ถ้ามีขีดมักเป็นคู่เงิน/คริปโต (BTC-USD)
    if "." not in typed and "-" not in typed:
        candidates.append(f"{typed}.BK")

    for candidate in candidates:
        data = yf.download(candidate, progress=False, **kwargs)
        if data.empty:
            continue

        # yfinance แถมแถวของวันที่ยังไม่มีการซื้อขายจริงมาด้วย มีแต่ volume
        # ส่วนราคาเป็น NaN ทั้งแถว ถ้าปล่อยผ่านไปจะกลายเป็น NaN ในผลลัพธ์
        # แล้วพังตอนแปลงเป็น JSON เพราะ Starlette ตั้ง allow_nan=False
        data = flatten_columns(data).dropna(subset=["Close"])
        if not data.empty:
            return data, candidate

    return None, typed


@router.get("/stock/{symbol}")
def get_stock(symbol: str):
    data, symbol = download_symbol(symbol, period="5d", interval="1h",
                                   auto_adjust=True)
    if data is None:
        raise HTTPException(status_code=404, detail=f"ไม่พบข้อมูลหุ้น {symbol}")

    data = flatten_columns(data)
    data = to_thai_time(data)
    latest = float(data["Close"].iloc[-1])
    prev = float(data["Close"].iloc[-2])
    change = latest - prev
     # ===== volume =====
    volume = int(data["Volume"].iloc[-1])
    avg_volume = data["Volume"].rolling(20).mean().iloc[-1]
    avg_volume = int(avg_volume) if not pd.isna(avg_volume) else None

    data.index = data.index.tz_convert("Asia/Bangkok")

    return {
        "symbol": symbol.upper(),
        "latest_price": round(latest, 2),
        "change": round(change, 2),
        "change_percent": round((change / prev) * 100, 2),
        "updated_at": data.index[-1].strftime("%Y-%m-%d %H:%M"),
        "currency": get_currency(symbol),
        "volume": volume,
        "avg_volume": avg_volume,
        "volume_ratio": round(volume / avg_volume, 2) if avg_volume else None
    }


# ความละเอียดของแท่งที่รองรับ ต้องเป็นค่าที่ yfinance รู้จัก
ALLOWED_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "1wk"}

# ความละเอียดที่สูงขึ้นถัดไป ใช้ตอนรอบซื้อขายเพิ่งเริ่มจนแท่งน้อยเกินกว่าจะดูรูปทรงได้
FINER_INTERVAL = {"1h": "15m", "60m": "15m", "30m": "5m", "15m": "5m", "5m": "1m"}
MIN_SESSION_BARS = 10


def latest_session_only(data):
    """ตัดให้เหลือเฉพาะรอบซื้อขายล่าสุด (ใช้วันที่ตามเวลาตลาดต้นทาง)"""
    return data[data.index.date == data.index[-1].date()]


@router.get("/stock/{symbol}/history")
def get_history(symbol: str, days: int = 5, interval: str = "30m",
                start: str | None = None, end: str | None = None):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"interval ต้องเป็นหนึ่งใน {sorted(ALLOWED_INTERVALS)}",
        )

    is_intraday = interval.endswith(("m", "h"))

    if start:
        # โหมดเลือกช่วงวันที่ (ใช้กับมุมมองรายเดือน)
        # yfinance เก็บแท่งย่อยได้จำกัด: 30m ~60 วัน, 1h ~2 ปี ส่วน 1d ย้อนได้ไกล
        # เดือนที่เก่าเกินกว่านั้นจะได้ข้อมูลว่าง จึงถอยไปใช้แท่งรายวันแทน
        data, symbol = download_symbol(symbol, start=start, end=end,
                                       interval=interval, auto_adjust=True)
        if data is None and interval != "1d":
            interval = "1d"
            is_intraday = False
            data, symbol = download_symbol(symbol, start=start, end=end,
                                           interval="1d", auto_adjust=True)
        if data is None:
            raise HTTPException(status_code=404,
                                detail=f"ไม่มีข้อมูล {symbol} ในช่วงที่ขอ")
        data = flatten_columns(data)
    else:
        # yfinance นับ period="1d" เป็น "ย้อนหลัง 24 ชั่วโมงจากตอนนี้" ไม่ใช่ "วันทำการล่าสุด"
        # ตลาดที่เพิ่งเปิด (เช่น SET ตอนเช้า) จึงได้ข้อมูลว่างเปล่า
        fetch_days = max(days, 2)
        data, symbol = download_symbol(symbol, period=f"{fetch_days}d", interval=interval,
                                       auto_adjust=True)
        if data is None:
            raise HTTPException(status_code=404, detail=f"ไม่พบข้อมูลหุ้น {symbol}")

        data = flatten_columns(data)

    # ตัดให้เหลือรอบซื้อขายล่าสุด โดยใช้วันที่ตาม "เวลาตลาดต้นทาง" ที่ yfinance ส่งมา
    # ต้องทำก่อนแปลงเป็นเวลาไทย เพราะรอบของตลาดสหรัฐคาบเกี่ยวเที่ยงคืนตามเวลาไทย
    if not start and days == 1 and is_intraday:
        data = latest_session_only(data)

        # ต้นรอบซื้อขาย (ยิ่งเจอ yfinance ที่ดีเลย์ 15-30 นาที) จะได้แท่งน้อยมาก
        # ไล่ขอความละเอียดสูงขึ้นเพื่อแสดงเท่าที่มีข้อมูลจริงให้มากที่สุด
        while len(data) < MIN_SESSION_BARS and interval in FINER_INTERVAL:
            finer = FINER_INTERVAL[interval]
            finer_data, _ = download_symbol(symbol, period=f"{fetch_days}d",
                                            interval=finer, auto_adjust=True)
            if finer_data is None:
                break
            interval = finer
            data = latest_session_only(flatten_columns(finer_data))

    if is_intraday:
        data = to_thai_time(data)
        fmt = "%Y-%m-%d %H:%M"
    else:
        fmt = "%Y-%m-%d"   # แท่งรายวันไม่มีเวลา แปลง timezone แล้วจะทำให้วันที่เพี้ยน

    history = [
        {
            "datetime": idx.strftime(fmt),
            "open": round(float(row["Open"]), 2),
            "high": round(float(row["High"]), 2),
            "low": round(float(row["Low"]), 2),
            "close": round(float(row["Close"]), 2),
            "volume": int(row["Volume"]),
        }
        for idx, row in data.iterrows()
    ]

    # อายุของแท่งล่าสุด คำนวณฝั่ง server เพื่อไม่ให้ผิดพลาดจาก timezone ของเครื่องผู้ใช้
    last_ts = data.index[-1]
    if last_ts.tz is None:
        last_ts = last_ts.tz_localize("UTC")
    age_minutes = (pd.Timestamp.now(tz="UTC") - last_ts).total_seconds() / 60

    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "history": history,
        "last_updated": history[-1]["datetime"] if history else None,
        "data_age_minutes": round(age_minutes),
        "is_intraday": is_intraday,
    }


def predict_return(returns, model_name: str) -> float:
    """
    ทำนาย return ของวันถัดจากลำดับ return ที่ให้มา
    แยกเป็นฟังก์ชันเพื่อเรียกซ้ำได้ ทั้งการทำนายวันถัดไปและการย้อนทำนายวันล่าสุด
    """
    if model_name in models:
        # ONNX Runtime รับ float32 เท่านั้น ต่างจาก Keras ที่แปลงให้เอง
        last_seq = returns[-LOOKBACK:].reshape(1, LOOKBACK, 1).astype("float32")
        session = models[model_name]
        input_name = session.get_inputs()[0].name
        return float(session.run(None, {input_name: last_seq})[0][0][0])

    if model_name == "xgboost":
        ret_series = pd.Series(returns)
        features = pd.DataFrame({
            "Return": [ret_series.iloc[-1]],
            "MA7": [ret_series.rolling(7).mean().iloc[-1]],
            "MA30": [ret_series.rolling(30).mean().iloc[-1]],
            "Prev_Return": [ret_series.iloc[-2]],
        })
        # Booster รับ DMatrix ไม่ใช่ DataFrame ตรง ๆ เหมือน XGBRegressor
        return float(xgb_model.predict(xgb.DMatrix(features))[0])

    raise HTTPException(status_code=400,
                        detail="model_name ต้องเป็น lstm, gru, tcn หรือ xgboost")


def run_backtest(symbol: str, model_name: str):
    """
    ย้อนทำนายราคาปิดของทุกวันที่ทำได้ในข้อมูล 1 ปี แล้วเก็บ residual ไว้

    วันที่ i ใช้ข้อมูลถึง returns[:i] เท่านั้น (ราคาปิดล่าสุดที่รู้คือ closes[i])
    ทำนายราคาปิดของวัน i+1 โมเดลจึงไม่เคยเห็นเฉลยของวันที่กำลังทำนาย

    ผลลัพธ์ใช้ร่วมกันทั้งแถบพยากรณ์และประวัติย้อนหลัง จึงคำนวณครั้งเดียวแล้ว cache
    คืน None ถ้าหาหุ้นไม่เจอ
    """
    key = (symbol.strip().upper(), model_name)
    now = time.time()
    with _backtest_lock:
        hit = _backtest_cache.get(key)
        if hit and now - hit[0] < BACKTEST_TTL_SEC:
            return hit[1]

    daily, resolved = download_symbol(symbol, period="1y", interval="1d",
                                      auto_adjust=True)
    if daily is None:
        return None

    daily = flatten_columns(daily)
    closes = daily["Close"].values
    returns = daily["Close"].pct_change().dropna().values
    if len(returns) < LOOKBACK:
        return None

    dates, predicted, actual, residuals = [], [], [], []
    for i in range(LOOKBACK, len(returns)):
        # แปลงเป็น float ของ python ตรงนี้เลย ไม่งั้น np.float64 จะลาม
        # ไปทำให้ผลเปรียบเทียบกลายเป็น np.bool_ ซึ่ง JSON แปลงไม่ได้
        pred = float(closes[i] * (1 + predict_return(returns[:i], model_name)))
        dates.append(daily.index[i + 1].strftime("%Y-%m-%d"))
        predicted.append(pred)
        actual.append(float(closes[i + 1]))
        residuals.append((pred - closes[i + 1]) / closes[i + 1] * 100)

    result = {
        "symbol": resolved.upper(),
        "dates": dates,
        "predicted": predicted,
        "actual": actual,
        "residuals": np.array(residuals),
        "closes": closes,
        "returns": returns,
        "last_date": daily.index[-1].strftime("%Y-%m-%d"),
    }

    with _backtest_lock:
        _backtest_cache[key] = (now, result)
    return result


def make_band(residuals, predicted, level: int):
    """
    แปลง residual ในอดีตเป็นช่วงราคารอบค่าที่ทำนาย

    residual = (ทำนาย - จริง) / จริง ดังนั้น จริง = ทำนาย / (1 + residual/100)
    quantile บนของ residual (ทำนายเกินมากสุด) จึงให้ขอบล่างของราคา และกลับกัน
    คืน None ถ้า residual น้อยเกินกว่าจะหา quantile ได้อย่างมีความหมาย
    """
    if len(residuals) < MIN_CAL_WINDOW:
        return None
    lo_q, hi_q = BAND_LEVELS[level]
    lo_res, hi_res = np.percentile(residuals, [lo_q, hi_q])
    return {
        "low": round(float(predicted / (1 + hi_res / 100)), 2),
        "high": round(float(predicted / (1 + lo_res / 100)), 2),
    }


@router.get("/predict/history/{symbol}")
def predict_history(symbol: str, model_name: str = "lstm", days: int = HISTORY_DAYS):
    """ประวัติการทำนายย้อนหลัง พร้อมสรุปว่าที่ผ่านมาแม่นแค่ไหน"""
    days = max(5, min(days, 60))
    data = run_backtest(symbol, model_name)
    if data is None:
        raise HTTPException(status_code=404, detail=f"ไม่พบข้อมูลหุ้น {symbol}")

    residuals = data["residuals"]
    total = len(residuals)
    if total <= 1:
        raise HTTPException(status_code=400, detail="ข้อมูลไม่พอสำหรับสร้างประวัติ")

    days = min(days, total)
    # แถบของแต่ละวันต้องสร้างจาก residual ที่เกิดก่อนวันนั้นเท่านั้น ไม่งั้นเป็นการมองอนาคต
    cal = min(CAL_WINDOW, total - days)

    rows = []
    for t in range(total - days, total):
        band = make_band(residuals[max(0, t - cal):t], data["predicted"][t], 80)
        pred, act = data["predicted"][t], data["actual"][t]
        # ราคาปิดของวันก่อนหน้า = ฐานที่ใช้ตัดสินว่าทายขึ้นหรือลง
        base = float(data["closes"][t + LOOKBACK])
        row = {
            "date": data["dates"][t],
            "predicted": round(pred, 2),
            "actual": round(act, 2),
            "error_percent": round((pred - act) / act * 100, 2),
            "direction_correct": bool((pred >= base) == (act >= base)),
        }
        if band:
            row.update({"band_low": band["low"], "band_high": band["high"],
                        "in_band": bool(band["low"] <= act <= band["high"])})
        rows.append(row)

    scored = [r for r in rows if "in_band" in r]
    summary = {
        "count": len(rows),
        "mae_percent": round(float(np.mean([abs(r["error_percent"]) for r in rows])), 2),
        "direction_correct": int(sum(r["direction_correct"] for r in rows)),
        "direction_accuracy": round(
            sum(r["direction_correct"] for r in rows) / len(rows) * 100, 1),
        "band_level": 80,
        "in_band": int(sum(r["in_band"] for r in scored)) if scored else None,
        "band_coverage": round(sum(r["in_band"] for r in scored) / len(scored) * 100, 1)
        if scored else None,
        "calibration_days": cal if scored else None,
    }

    return {
        "symbol": data["symbol"],
        "model": model_name,
        "currency": get_currency(data["symbol"]),
        "rows": rows,
        "summary": summary,
    }


@router.get("/predict/{symbol}")
def predict_stock(symbol: str, model_name: str = "lstm"):
    # ใช้ผลย้อนทำนายชุดเดียวกับประวัติ จะได้ไม่ต้องโหลดและคำนวณซ้ำ
    data = run_backtest(symbol, model_name)
    if data is None:
        raise HTTPException(status_code=404, detail=f"ไม่พบข้อมูลหุ้น {symbol}")

    closes, returns = data["closes"], data["returns"]
    daily_close = float(closes[-1])

    if len(returns) < LOOKBACK:
        raise HTTPException(status_code=400, detail="ข้อมูลไม่พอสำหรับทำนาย")

    # ===== ทำนายราคาปิดของวันทำการถัดไป =====
    pred_return = predict_return(returns, model_name)
    predicted = daily_close * (1 + pred_return)

    result = {
        "symbol": data["symbol"],
        "model": model_name,
        "last_close": round(daily_close, 2),
        "last_close_date": data["last_date"],
        "predicted_close_tomorrow": round(predicted, 2),
        "diff_percent": round(pred_return * 100, 3),
        "currency": get_currency(data["symbol"]),
    }

    # ===== แถบพยากรณ์จาก residual ล่าสุด =====
    recent = data["residuals"][-CAL_WINDOW:]
    bands = {level: make_band(recent, predicted, level) for level in BAND_LEVELS}
    if bands[80]:
        result["band"] = {str(level): b for level, b in bands.items() if b}
        result["band_basis_days"] = len(recent)

    # ===== ย้อนทำนายราคาปิดของวันล่าสุด แล้วเทียบกับราคาจริง =====
    # ค่านี้มาจาก run_backtest ซึ่งใช้ข้อมูลถึงวันก่อนหน้าเท่านั้น โมเดลจึงไม่เห็นเฉลย
    if data["predicted"]:
        predicted_today = data["predicted"][-1]
        prev_close = float(closes[-2])
        error = (predicted_today - daily_close) / daily_close * 100

        result.update({
            "predicted_close_today": round(predicted_today, 2),
            "actual_close_today": round(daily_close, 2),
            "today_error_percent": round(error, 3),
            "today_direction_correct": bool((predicted_today >= prev_close) == (daily_close >= prev_close)),
        })

        # แถบของวันล่าสุด ต้องตัด residual ของวันนั้นเองออกก่อน
        # ไม่งั้นเป็นการเอาความผิดพลาดของวันที่กำลังตรวจมาสร้างแถบให้ตัวเอง
        past = data["residuals"][:-1][-CAL_WINDOW:]
        band_today = {level: make_band(past, predicted_today, level) for level in BAND_LEVELS}
        if band_today[80]:
            result["band_today"] = {str(l): b for l, b in band_today.items() if b}
            result["today_in_band"] = bool(
                band_today[80]["low"] <= daily_close <= band_today[80]["high"])

    return result