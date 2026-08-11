import yfinance as yf
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import Dense
from tcn import TCN                     # 🔄 ใช้ TCN

# ===== 1. รายชื่อหุ้น =====
symbols = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "COIN", "PLTR", "MARA", "BTC-USD"]

LOOKBACK = 30
all_X, all_y = [], []

# ===== 2. เตรียมข้อมูลแต่ละหุ้น =====
for symbol in symbols:
    print(f"กำลังเตรียม {symbol}...")
    data = yf.download(symbol, start="2022-01-01", end="2026-01-01", auto_adjust=True, progress=False)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)

    if len(data) < LOOKBACK + 10:
        print(f"  ⚠️ ข้าม {symbol}")
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

# ===== 4. สร้างโมเดล TCN =====
model = Sequential([
    TCN(
        nb_filters=50,              # จำนวน filter
        kernel_size=3,              # ขนาด kernel
        dilations=[1, 2, 4, 8],     # ระยะการมองย้อน (ขยายทีละเท่า)
        input_shape=(LOOKBACK, 1)
    ),
    Dense(1)
])
model.compile(optimizer="adam", loss="mean_squared_error")

# ===== 5. เทรน =====
print("กำลังเทรน TCN... (รอสักครู่)")
model.fit(X_train, y_train, epochs=10, batch_size=32, verbose=1)

model.save("tcn_model.keras")
print("✅ เซฟโมเดลแล้ว → tcn_model.keras")

# ===== 6. ทำนาย + วัดผล =====
predictions = model.predict(X_test)
mae = np.mean(np.abs(y_test.reshape(-1, 1) - predictions))
print(f"\n===== ผลลัพธ์ TCN Multi-Asset =====")
print(f"MAE: {mae*100:.3f}% (return)")

# ===== 7. วาดกราฟ =====
plt.figure(figsize=(14, 6))
plt.plot(y_test[:200], label="Actual Return", linewidth=1.5)
plt.plot(predictions[:200], label="Predicted (TCN)", linewidth=1.5, linestyle="--")
plt.title("TCN Multi-Asset - Return Prediction")
plt.xlabel("Data points")
plt.ylabel("Daily Return")
plt.legend()
plt.grid(True, alpha=0.3)
plt.axhline(y=0, color="gray", linewidth=0.5)
plt.show()