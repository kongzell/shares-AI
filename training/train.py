"""
เทรนโมเดลพยากรณ์ผลตอบแทนรายวันทั้ง 4 ตัว (LSTM, GRU, TCN, XGBoost)

รวมมาจากสคริปต์แยก 4 ไฟล์ในโฟลเดอร์นี้ โดยแก้ 3 จุดให้เหมาะกับการเทรนอัตโนมัติ:
  1. ดึงข้อมูลถึงวันปัจจุบันเสมอ (ของเดิมล็อก end="2026-01-01" ไว้ตายตัว
     ทำให้เทรนซ้ำกี่รอบก็ได้ข้อมูลชุดเดิม การ retrain รายสัปดาห์จะไร้ความหมาย)
  2. ดึงข้อมูลรอบเดียวแล้วใช้ร่วมกันทั้ง 4 โมเดล (ของเดิมแยกไฟล์ ดึงซ้ำ 4 รอบ = 36 ครั้ง)
  3. ตั้ง random seed และบันทึกค่าความแม่นลงไฟล์ เพื่อให้ทำซ้ำได้และให้ตัวตรวจคุณภาพเทียบได้

ใช้งาน:
    python training/train.py --out backend/model
    python training/train.py --out backend/model --split by-row   # ใช้วิธีแบ่งแบบสคริปต์เดิม
"""

import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import numpy as np

# ปิด log ของ TensorFlow ให้เหลือเฉพาะ error จริง ๆ (ต้องตั้งก่อน import tensorflow)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import pandas as pd  # noqa: E402
import yfinance as yf  # noqa: E402
import tensorflow as tf  # noqa: E402
from tensorflow.keras.models import Sequential  # noqa: E402
from tensorflow.keras.layers import Input, LSTM, GRU, Dense  # noqa: E402
from tcn import TCN  # noqa: E402
from xgboost import XGBRegressor  # noqa: E402

# ===== ค่าคงที่ ต้องตรงกับที่ backend/routers/stocks.py ใช้ตอนทำนาย =====
SYMBOLS = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "COIN", "PLTR", "MARA", "BTC-USD", "DELTA.BK", "KBANK.BK", 
           "PTT.BK", "AOT.BK", "CPALL.BK", "SCB.BK", "BAM.BK"]
LOOKBACK = 30                 # ต้องเท่ากับ LOOKBACK ใน stocks.py
XGB_FEATURES = ["Return", "MA7", "MA30", "Prev_Return"]
START_DATE = "2022-01-01"
EPOCHS = 10
BATCH_SIZE = 32
SEED = 42


def set_seed(seed: int = SEED):
    """ตรึงค่าสุ่มให้เทรนซ้ำแล้วได้ผลเหมือนเดิม — จำเป็นสำหรับงานวิทยานิพนธ์ที่ต้องทำซ้ำได้"""
    random.seed(seed)
    np.random.seed(seed)
    tf.random.set_seed(seed)


def load_prices(symbols, start, end):
    """ดึงราคาปิดรายวันของทุกหุ้น คืน dict {symbol: DataFrame}"""
    prices = {}
    for symbol in symbols:
        print(f"  ดึง {symbol} ...", flush=True)
        data = yf.download(symbol, start=start, end=end,
                           auto_adjust=True, progress=False)
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)
        if len(data) < LOOKBACK + 10:
            print(f"    ข้าม {symbol} (ข้อมูลน้อยเกินไป: {len(data)} แถว)")
            continue
        prices[symbol] = data
    if not prices:
        raise SystemExit("ไม่ได้ข้อมูลหุ้นเลยสักตัว — หยุดการเทรน")
    return prices


def build_sequences(prices, split_mode):
    """
    สร้างชุดข้อมูลแบบ sequence สำหรับ LSTM / GRU / TCN
    แต่ละตัวอย่าง = return 30 วันย้อนหลัง -> ทำนาย return วันถัดไป

    split_mode:
      by-time = แบ่งตามเวลา ฝึกด้วยอดีต ทดสอบด้วยอนาคต (ตรงกับการใช้งานจริง)
      by-row  = แบ่งตามลำดับแถวแบบสคริปต์เดิม ซึ่งไปตัดกลางรายชื่อหุ้น
                ทำให้ชุดทดสอบเป็น "หุ้นคนละตัว ช่วงเวลาเดียวกัน" ไม่ใช่การทำนายอนาคต
    """
    X_parts, y_parts, date_parts = [], [], []

    for symbol, data in prices.items():
        returns = data["Close"].pct_change().dropna()
        values = returns.values.reshape(-1, 1)
        index = returns.index

        for i in range(LOOKBACK, len(values)):
            X_parts.append(values[i - LOOKBACK:i, 0])
            y_parts.append(values[i, 0])
            date_parts.append(index[i])

    X = np.array(X_parts).reshape(-1, LOOKBACK, 1)
    y = np.array(y_parts)
    dates = pd.DatetimeIndex(date_parts)

    if split_mode == "by-time":
        # เรียงทุกตัวอย่างตามวันที่จริง แล้วตัดที่ 80% ของเส้นเวลา
        order = np.argsort(dates.values)
        X, y, dates = X[order], y[order], dates[order]
        cutoff = dates[int(len(dates) * 0.8)]
        train_mask = dates < cutoff
        return X[train_mask], X[~train_mask], y[train_mask], y[~train_mask], str(cutoff.date())

    split = int(len(X) * 0.8)
    return X[:split], X[split:], y[:split], y[split:], None


def build_tabular(prices, split_mode):
    """สร้างชุดข้อมูลตารางสำหรับ XGBoost — ฟีเจอร์ต้องตรงกับที่ stocks.py ใช้ตอนทำนาย"""
    frames = []
    for symbol, data in prices.items():
        df = data[["Close"]].copy()
        df["Return"] = df["Close"].pct_change()
        df["MA7"] = df["Return"].rolling(7).mean()
        df["MA30"] = df["Return"].rolling(30).mean()
        df["Prev_Return"] = df["Return"].shift(1)
        df["Target"] = df["Return"].shift(-1)      # ผลตอบแทนวันถัดไป = สิ่งที่ต้องทำนาย
        frames.append(df.dropna())

    combined = pd.concat(frames)

    if split_mode == "by-time":
        combined = combined.sort_index()
        cutoff = combined.index[int(len(combined) * 0.8)]
        train, test = combined[combined.index < cutoff], combined[combined.index >= cutoff]
        return (train[XGB_FEATURES], test[XGB_FEATURES],
                train["Target"], test["Target"], str(cutoff.date()))

    split = int(len(combined) * 0.8)
    return (combined[XGB_FEATURES][:split], combined[XGB_FEATURES][split:],
            combined["Target"][:split], combined["Target"][split:], None)


def mae_percent(y_true, y_pred):
    """ค่าความคลาดเคลื่อนเฉลี่ยของ return หน่วยเป็น % — ยิ่งน้อยยิ่งดี"""
    return float(np.mean(np.abs(np.asarray(y_true).ravel() - np.asarray(y_pred).ravel())) * 100)


def direction_accuracy(y_true, y_pred):
    """ทายทิศทางขึ้น/ลงถูกกี่ % — ตัวเลขที่ตีความง่ายกว่า MAE สำหรับการลงทุน"""
    return float(np.mean((np.asarray(y_true).ravel() >= 0) ==
                         (np.asarray(y_pred).ravel() >= 0)) * 100)


def export_onnx(model, onnx_path: Path):
    """
    แปลงโมเดล Keras เป็น ONNX เพื่อให้ฝั่ง deploy รันได้โดยไม่ต้องมี TensorFlow
    (TensorFlow กิน 1.5 GB ซึ่งใหญ่เกินกว่าที่ free tier ส่วนใหญ่จะรับไหว)

    Keras 3 เก็บไฟล์คนละรูปแบบกับเวอร์ชันเก่า tf2onnx จึงอ่าน .keras ตรง ๆ ไม่ได้
    ต้อง export เป็น SavedModel ก่อนแล้วค่อยแปลง — จุดนี้เป็นที่ที่คนติดกันบ่อย
    """
    with tempfile.TemporaryDirectory() as tmp:
        saved = os.path.join(tmp, "sm")
        model.export(saved)
        result = subprocess.run(
            [sys.executable, "-m", "tf2onnx.convert",
             "--saved-model", saved,
             "--output", str(onnx_path),
             "--opset", "17"],
            capture_output=True, text=True,
        )
    if result.returncode != 0:
        raise RuntimeError(f"แปลง ONNX ไม่สำเร็จ: {result.stderr[-500:]}")


def train_sequence_model(name, layers, data, out_dir, filename):
    X_train, X_test, y_train, y_test = data
    print(f"\n=== เทรน {name} ===", flush=True)
    set_seed()

    model = Sequential([Input(shape=(LOOKBACK, 1)), *layers, Dense(1)])
    model.compile(optimizer="adam", loss="mean_squared_error")
    model.fit(X_train, y_train, epochs=EPOCHS, batch_size=BATCH_SIZE, verbose=2)

    path = out_dir / filename
    model.save(path)                       # เก็บต้นฉบับไว้อ้างอิง
    onnx_path = path.with_suffix(".onnx")
    export_onnx(model, onnx_path)          # ตัวที่ backend ใช้จริง

    pred = model.predict(X_test, verbose=0)
    metrics = {"mae_percent": mae_percent(y_test, pred),
               "direction_accuracy": direction_accuracy(y_test, pred)}
    print(f"{name}: MAE {metrics['mae_percent']:.3f}%  "
          f"ทายทิศทางถูก {metrics['direction_accuracy']:.1f}%  "
          f"-> {path.name} + {onnx_path.name}")
    return metrics


def main():
    parser = argparse.ArgumentParser(description="เทรนโมเดลพยากรณ์ราคาหุ้นทั้ง 4 ตัว")
    parser.add_argument("--out", default="backend/model",
                        help="โฟลเดอร์ปลายทางที่จะเซฟโมเดล")
    parser.add_argument("--split", choices=["by-time", "by-row"], default="by-time",
                        help="วิธีแบ่ง train/test (ค่าเริ่มต้น by-time = แบ่งตามเวลา)")
    parser.add_argument("--start", default=START_DATE, help="วันเริ่มต้นของข้อมูล")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ดึงถึงวันพรุ่งนี้เพื่อให้รวมข้อมูลของวันนี้ด้วย (yfinance ไม่นับวันที่เป็น end)
    end = str(date.fromordinal(date.today().toordinal() + 1))
    print(f"ช่วงข้อมูล: {args.start} ถึง {end}   วิธีแบ่ง: {args.split}")
    print(f"หุ้นที่ใช้เทรน {len(SYMBOLS)} ตัว: {', '.join(SYMBOLS)}\n")

    prices = load_prices(SYMBOLS, args.start, end)

    Xtr, Xte, ytr, yte, cutoff = build_sequences(prices, args.split)
    seq_data = (Xtr, Xte, ytr, yte)
    print(f"\nชุด sequence: ฝึก {len(Xtr):,} ตัวอย่าง / ทดสอบ {len(Xte):,} ตัวอย่าง"
          + (f" (แบ่งที่ {cutoff})" if cutoff else ""))

    metrics = {}
    metrics["lstm"] = train_sequence_model(
        "LSTM", [LSTM(50, return_sequences=True), LSTM(50)],
        seq_data, out_dir, "multi_asset_lstm.keras")
    metrics["gru"] = train_sequence_model(
        "GRU", [GRU(50, return_sequences=True), GRU(50)],
        seq_data, out_dir, "gru_model.keras")
    metrics["tcn"] = train_sequence_model(
        "TCN", [TCN(nb_filters=50, kernel_size=3, dilations=[1, 2, 4, 8])],
        seq_data, out_dir, "tcn_model.keras")

    # ===== XGBoost ใช้ฟีเจอร์ตาราง ไม่ใช่ sequence =====
    print("\n=== เทรน XGBoost ===", flush=True)
    Xtr_t, Xte_t, ytr_t, yte_t, _ = build_tabular(prices, args.split)
    xgb = XGBRegressor(n_estimators=100, max_depth=5, learning_rate=0.1,
                       random_state=SEED)
    xgb.fit(Xtr_t, ytr_t)
    # ใช้ save_model ของ XGBoost ไม่ใช่ joblib/pickle
    # เพราะ pickle ของ XGBoost ย้ายข้ามแพลตฟอร์มไม่ได้ โมเดลที่ pickle บน Linux
    # (GitHub Actions) จะโหลดบน Windows ไม่ได้ ขึ้น "input stream corrupted"
    # ส่วนรูปแบบ .json เป็นรูปแบบมาตรฐานของ XGBoost ที่ใช้ข้ามเครื่องได้
    xgb.save_model(out_dir / "xgboost_model.json")

    pred = xgb.predict(Xte_t)
    metrics["xgboost"] = {"mae_percent": mae_percent(yte_t, pred),
                          "direction_accuracy": direction_accuracy(yte_t, pred)}
    print(f"XGBoost: MAE {metrics['xgboost']['mae_percent']:.3f}%  "
          f"ทายทิศทางถูก {metrics['xgboost']['direction_accuracy']:.1f}%  -> xgboost_model.json")

    # บันทึกผลไว้ให้ validate_model.py เทียบว่าโมเดลใหม่ดีขึ้นหรือแย่ลง
    report = {
        "trained_at": date.today().isoformat(),
        "data_start": args.start,
        "data_end": end,
        "split_mode": args.split,
        "split_cutoff": cutoff,
        "symbols": list(prices.keys()),
        "lookback": LOOKBACK,
        "seed": SEED,
        "metrics": metrics,
    }
    (out_dir / "metrics.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n===== สรุป =====")
    for name, m in metrics.items():
        print(f"  {name:8s} MAE {m['mae_percent']:6.3f}%   "
              f"ทิศทางถูก {m['direction_accuracy']:5.1f}%")
    print(f"\nเซฟโมเดลและ metrics.json ไว้ที่ {out_dir}/")


if __name__ == "__main__":
    main()
