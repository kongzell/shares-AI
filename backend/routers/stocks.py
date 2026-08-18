from fastapi import APIRouter, HTTPException
from pathlib import Path
import numpy as np
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

def get_currency(symbol: str) -> str:
    """ดึงสกุลเงินของหุ้น (THB, USD, ...)"""
    try:
        info = yf.Ticker(symbol).fast_info
        return info.get("currency", "USD")
    except Exception:
        # fallback: เดาจากนามสกุล
        return "THB" if symbol.upper().endswith(".BK") else "USD"

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
def get_history(symbol: str, days: int = 5, interval: str = "30m"):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"interval ต้องเป็นหนึ่งใน {sorted(ALLOWED_INTERVALS)}",
        )

    is_intraday = interval.endswith(("m", "h"))

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
    if days == 1 and is_intraday:
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


@router.get("/predict/{symbol}")
def predict_stock(symbol: str, model_name: str = "lstm"):
    daily, symbol = download_symbol(symbol, period="60d", interval="1d",
                                    auto_adjust=True)
    if daily is None:
        raise HTTPException(status_code=404, detail=f"ไม่พบข้อมูลหุ้น {symbol}")

    daily = flatten_columns(daily)
    returns = daily["Close"].pct_change().dropna().values
    daily_close = float(daily["Close"].iloc[-1])

    if len(returns) < LOOKBACK:
        raise HTTPException(status_code=400, detail="ข้อมูลไม่พอสำหรับทำนาย")

    # ===== ทำนายราคาปิดของวันทำการถัดไป =====
    pred_return = predict_return(returns, model_name)
    predicted = daily_close * (1 + pred_return)

    result = {
        "symbol": symbol.upper(),
        "model": model_name,
        "last_close": round(daily_close, 2),
        "last_close_date": daily.index[-1].strftime("%Y-%m-%d"),
        "predicted_close_tomorrow": round(predicted, 2),
        "diff_percent": round(pred_return * 100, 3),
        "currency": get_currency(symbol),
    }

    # ===== ย้อนทำนายราคาปิดของวันล่าสุด แล้วเทียบกับราคาจริง =====
    # ใช้ข้อมูลถึงวันก่อนหน้าเท่านั้น (ตัด return ตัวสุดท้ายทิ้ง) โมเดลจึงไม่เห็นเฉลย
    if len(returns) >= LOOKBACK + 1:
        prev_close = float(daily["Close"].iloc[-2])
        today_return = predict_return(returns[:-1], model_name)
        predicted_today = prev_close * (1 + today_return)
        error = (predicted_today - daily_close) / daily_close * 100

        result.update({
            "predicted_close_today": round(predicted_today, 2),
            "actual_close_today": round(daily_close, 2),
            "today_error_percent": round(error, 3),
            "today_direction_correct": (predicted_today >= prev_close) == (daily_close >= prev_close),
        })

    return result