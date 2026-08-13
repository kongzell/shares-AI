---
title: Stock Prediction API
emoji: 📈
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# ระบบพยากรณ์ราคาหลักทรัพย์

API สำหรับพยากรณ์ราคาปิดของหลักทรัพย์ พร้อมระบบเฝ้าระวังการทุ่มตลาด

ส่วนหัวแบบ YAML ด้านบนเป็นข้อกำหนดของ Hugging Face Spaces
ใช้บอกว่า Space นี้รันด้วย Docker และแอปฟังที่พอร์ตไหน ห้ามลบออก

## โครงสร้าง

| โฟลเดอร์ | หน้าที่ |
|---|---|
| `backend/` | API (FastAPI) + โมเดลที่เทรนแล้ว — ส่วนที่ deploy ขึ้น Space นี้ |
| `frontend/` | หน้าเว็บ (React + Vite) — deploy แยกที่ Cloudflare Pages |
| `training/` | สคริปต์เทรนโมเดล — รันบน GitHub Actions ทุกสัปดาห์ |

## โมเดลที่ใช้

เทรนด้วยผลตอบแทนรายวันของหลักทรัพย์ 9 ตัว ย้อนหลัง 30 วันเพื่อทำนายวันถัดไป

| โมเดล | ไฟล์ |
|---|---|
| LSTM | `backend/model/multi_asset_lstm.keras` |
| GRU | `backend/model/gru_model.keras` |
| TCN | `backend/model/tcn_model.keras` |
| XGBoost | `backend/model/xgboost_model.pkl` |

ค่าความแม่นล่าสุดดูได้ที่ `backend/model/metrics.json`

## Environment variables ที่ต้องตั้ง

ตั้งเป็น Secrets ในหน้า Settings ของ Space

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `DATABASE_URL` | สตริงเชื่อมต่อ Postgres จาก Neon |
| `SECRET_KEY` | กุญแจสำหรับเซ็น JWT |
| `ALLOWED_ORIGINS` | โดเมนของหน้าเว็บบน Cloudflare Pages |

## การเทรนอัตโนมัติ

GitHub Actions เทรนโมเดลใหม่ทุกเช้าวันจันทร์ ตรวจคุณภาพก่อน
ถ้าแย่ลงเกินเกณฑ์จะไม่นำขึ้นใช้งาน รายละเอียดใน `.github/workflows/retrain.yml`
