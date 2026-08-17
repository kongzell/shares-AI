# ระบบพยากรณ์ราคาหลักทรัพย์

ระบบพยากรณ์ราคาปิดของหลักทรัพย์ด้วยโมเดล LSTM, GRU, TCN และ XGBoost
พร้อมระบบเฝ้าระวังการทุ่มตลาดของหุ้นใน watchlist

## โครงสร้าง

| โฟลเดอร์ | หน้าที่ | deploy ที่ไหน |
|---|---|---|
| `backend/` | API (FastAPI) + โมเดลที่เทรนแล้ว | Google Cloud Run |
| `frontend/` | หน้าเว็บ (React + Vite) | Cloudflare Pages |
| `training/` | สคริปต์เทรนโมเดล | GitHub Actions (รันสัปดาห์ละครั้ง) |

ฐานข้อมูลผู้ใช้และ watchlist ใช้ PostgreSQL บน Neon

## โมเดล

เทรนจากผลตอบแทนรายวันของหลักทรัพย์ 9 ตัว ใช้ข้อมูลย้อนหลัง 30 วันทำนายวันถัดไป

| โมเดล | ไฟล์ |
|---|---|
| LSTM | `backend/model/multi_asset_lstm.keras` |
| GRU | `backend/model/gru_model.keras` |
| TCN | `backend/model/tcn_model.keras` |
| XGBoost | `backend/model/xgboost_model.json` |

ค่าความแม่นล่าสุดอยู่ใน `backend/model/metrics.json`

## Environment variables

ตั้งใน Cloud Run ที่ Variables & Secrets

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `DATABASE_URL` | สตริงเชื่อมต่อ Postgres จาก Neon |
| `SECRET_KEY` | กุญแจสำหรับเซ็น JWT |
| `ALLOWED_ORIGINS` | โดเมนของหน้าเว็บบน Cloudflare Pages |

ฝั่ง frontend ตั้ง `VITE_API_URL` ตอน build ให้ชี้ไปที่ URL ของ Cloud Run

## การเทรนอัตโนมัติ

GitHub Actions เทรนโมเดลใหม่ทุกเช้าวันจันทร์ ตรวจคุณภาพก่อน
ถ้าค่าความคลาดเคลื่อนแย่ลงเกินเกณฑ์จะไม่นำขึ้นใช้งาน
รายละเอียดใน `.github/workflows/retrain.yml`

## รันบนเครื่องตัวเอง

```bash
# backend
cd backend
.\venv\Scripts\python.exe -m uvicorn main:app --reload

# frontend
cd frontend
npm run dev
```

หมายเหตุ: ต้องใช้ python ของ venv เท่านั้น เพราะ python ตัวระบบมี bcrypt
เวอร์ชันที่เข้ากับ passlib ไม่ได้
