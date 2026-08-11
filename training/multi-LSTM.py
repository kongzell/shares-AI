import yfinance as yf
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense
import joblib

# ===== 1. รายชื่อหุ้นที่จะเทรนรวมกัน =====
symbols = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "COIN", "PLTR", "MARA", "BTC-USD"]

LOOKBACK = 30   # ใช้ return 30 วันย้อนหลัง ทำนายวันถัดไป

all_X, all_y = [], []

# ===== 2. เตรียมข้อมูลแต่ละหุ้น (แยกกันก่อนรวม!) =====
for symbol in symbols:
    print(f"กำลังเตรียม {symbol}...")
    data = yf.download(symbol, start="2022-01-01", end="2026-01-01", auto_adjust=True, progress=False)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)

    if len(data) < LOOKBACK + 10:   # ข้ามถ้าข้อมูลน้อยเกิน
        print(f"  ⚠️ ข้าม {symbol} (ข้อมูลน้อย)")
        continue

    # 🔑 ใช้ % return แทนราคาดิบ (สเกลเท่ากันทุกหุ้น)
    returns = data["Close"].pct_change().dropna().values.reshape(-1, 1)

    # สร้าง sequence แยกในแต่ละหุ้น (ไม่ให้ข้ามหุ้น)
    for i in range(LOOKBACK, len(returns)):
        all_X.append(returns[i-LOOKBACK:i, 0])   # 30 วันก่อนหน้า
        all_y.append(returns[i, 0])              # วันถัดไป

# ===== 3. รวมเป็น array เดียว =====
X = np.array(all_X)
y = np.array(all_y)
X = X.reshape(X.shape[0], X.shape[1], 1)   # LSTM ต้องการ 3 มิติ

print(f"\nรวมข้อมูลทั้งหมด: {len(X)} ตัวอย่าง จาก {len(symbols)} หุ้น")

# ===== 4. แบ่ง Train / Test =====
split = int(len(X) * 0.8)
X_train, X_test = X[:split], X[split:]
y_train, y_test = y[:split], y[split:]

# ===== 5. สร้างโมเดล LSTM =====
model = Sequential([
    LSTM(50, return_sequences=True, input_shape=(LOOKBACK, 1)),
    LSTM(50),
    Dense(1)
])
model.compile(optimizer="adam", loss="mean_squared_error")

# ===== 6. เทรน (ข้อมูลเยอะ อาจนาน 3-5 นาที) =====
print("กำลังเทรน LSTM multi-asset... (รอสักครู่)")
model.fit(X_train, y_train, epochs=10, batch_size=32, verbose=1)

model.save("multi_asset_lstm.keras")
print("✅ เซฟโมเดลแล้ว → multi_asset_lstm.keras")

# ===== 7. ทำนาย + วัดผล =====
predictions = model.predict(X_test)
mae = np.mean(np.abs(y_test.reshape(-1, 1) - predictions))
print(f"\n===== ผลลัพธ์ LSTM Multi-Asset =====")
print(f"MAE: {mae*100:.3f}% (return)")

# ===== 8. วาดกราฟเทียบ return (200 จุดแรก) =====
plt.figure(figsize=(14, 6))
plt.plot(y_test[:200], label="Actual Return", linewidth=1.5)
plt.plot(predictions[:200], label="Predicted Return", linewidth=1.5, linestyle="--")
plt.title("LSTM Multi-Asset - Return Prediction")
plt.xlabel("Data points")
plt.ylabel("Daily Return")
plt.legend()
plt.grid(True, alpha=0.3)
plt.axhline(y=0, color="gray", linewidth=0.5)
plt.show()