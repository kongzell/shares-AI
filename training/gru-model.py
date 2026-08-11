import yfinance as yf
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import GRU, Dense       # 🔄 เปลี่ยน LSTM เป็น GRU

# ===== 1. รายชื่อหุ้นที่เทรนรวมกัน =====
symbols = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "COIN", "PLTR", "MARA", "BTC-USD"]

LOOKBACK = 30
all_X, all_y = [], []

# ===== 2. เตรียมข้อมูลแต่ละหุ้น (แยกกันก่อนรวม) =====
for symbol in symbols:
    print(f"กำลังเตรียม {symbol}...")
    data = yf.download(symbol, start="2022-01-01", end="2026-01-01", auto_adjust=True, progress=False)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)

    if len(data) < LOOKBACK + 10:
        print(f"  ⚠️ ข้าม {symbol} (ข้อมูลน้อย)")
        continue

    returns = data["Close"].pct_change().dropna().values.reshape(-1, 1)

    for i in range(LOOKBACK, len(returns)):
        all_X.append(returns[i-LOOKBACK:i, 0])
        all_y.append(returns[i, 0])

X = np.array(all_X)
y = np.array(all_y)
X = X.reshape(X.shape[0], X.shape[1], 1)
print(f"\nรวมข้อมูล: {len(X)} ตัวอย่าง")

# ===== 3. แบ่ง Train / Test =====
split = int(len(X) * 0.8)
X_train, X_test = X[:split], X[split:]
y_train, y_test = y[:split], y[split:]

# ===== 4. สร้างโมเดล GRU (เปลี่ยนจาก LSTM แค่นี้) =====
model = Sequential([
    GRU(50, return_sequences=True, input_shape=(LOOKBACK, 1)),   # 🔄 GRU
    GRU(50),                                                      # 🔄 GRU
    Dense(1)
])
model.compile(optimizer="adam", loss="mean_squared_error")

# ===== 5. เทรน =====
print("กำลังเทรน GRU... (รอสักครู่)")
model.fit(X_train, y_train, epochs=10, batch_size=32, verbose=1)

model.save("gru_model.keras")
print("✅ เซฟโมเดลแล้ว → gru_model.keras")

# ===== 6. ทำนาย + วัดผล =====
predictions = model.predict(X_test)
mae = np.mean(np.abs(y_test.reshape(-1, 1) - predictions))
print(f"\n===== ผลลัพธ์ GRU Multi-Asset =====")
print(f"MAE: {mae*100:.3f}% (return)")

# ===== 7. วาดกราฟ =====
plt.figure(figsize=(14, 6))
plt.plot(y_test[:200], label="Actual Return", linewidth=1.5)
plt.plot(predictions[:200], label="Predicted (GRU)", linewidth=1.5, linestyle="--")
plt.title("GRU Multi-Asset - Return Prediction")
plt.xlabel("Data points")
plt.ylabel("Daily Return")
plt.legend()
plt.grid(True, alpha=0.3)
plt.axhline(y=0, color="gray", linewidth=0.5)
plt.show()