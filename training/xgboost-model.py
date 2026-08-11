import yfinance as yf
import pandas as pd
import matplotlib.pyplot as plt
from xgboost import XGBRegressor       # 🔄 เปลี่ยนจาก LinearRegression
import joblib

# ===== 1. รายชื่อหุ้นที่เทรนรวมกัน =====
symbols = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "COIN", "PLTR", "MARA", "BTC-USD"]

all_data = []

# ===== 2. ดึง + เตรียมข้อมูลแต่ละหุ้น =====
for symbol in symbols:
    print(f"กำลังดึง {symbol}...")
    data = yf.download(symbol, start="2022-01-01", end="2026-01-01", auto_adjust=True, progress=False)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)

    df = data[["Close"]].copy()
    df["Return"] = df["Close"].pct_change()
    df["MA7"] = df["Return"].rolling(7).mean()
    df["MA30"] = df["Return"].rolling(30).mean()
    df["Prev_Return"] = df["Return"].shift(1)
    df["Target"] = df["Return"].shift(-1)
    df = df.dropna()
    all_data.append(df)

combined = pd.concat(all_data)
print(f"\nรวมข้อมูล: {len(combined)} แถว")

# ===== 3. Feature + Target =====
X = combined[["Return", "MA7", "MA30", "Prev_Return"]]
y = combined["Target"]

split = int(len(combined) * 0.8)
X_train, X_test = X[:split], X[split:]
y_train, y_test = y[:split], y[split:]

# ===== 4. เทรน XGBoost =====
# 🔄 จุดที่เปลี่ยน: ใช้ XGBRegressor แทน LinearRegression
model = XGBRegressor(
    n_estimators=100,     # จำนวนต้นไม้
    max_depth=5,          # ความลึกของแต่ละต้น
    learning_rate=0.1,    # อัตราการเรียนรู้
    random_state=42
)
model.fit(X_train, y_train)
joblib.dump(model, "xgboost_model.pkl")

# ===== 5. ทำนาย + วัดผล =====
predictions = model.predict(X_test)
mae = (y_test - predictions).abs().mean()

print("\n===== ผลลัพธ์ XGBoost =====")
print(f"MAE: {mae*100:.3f}% (return)")
print("✅ เซฟโมเดลแล้ว → xgboost_model.pkl")

# ===== 6. ดู Feature Importance (จุดเด่นของ XGBoost!) =====
print("\n===== ความสำคัญของแต่ละ Feature =====")
importance = model.feature_importances_
for feat, imp in zip(X.columns, importance):
    print(f"  {feat:12s}: {imp*100:.1f}%")

# ===== 7. วาดกราฟเทียบ return =====
plt.figure(figsize=(14, 6))
plt.plot(y_test.values[:200], label="Actual Return", linewidth=1.5)
plt.plot(predictions[:200], label="Predicted (XGBoost)", linewidth=1.5, linestyle="--")
plt.title("XGBoost Multi-Asset - Return Prediction")
plt.xlabel("Data points")
plt.ylabel("Daily Return")
plt.legend()
plt.grid(True, alpha=0.3)
plt.axhline(y=0, color="gray", linewidth=0.5)
plt.show()