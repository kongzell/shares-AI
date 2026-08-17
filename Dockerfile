# Dockerfile สำหรับ deploy backend ขึ้น Google Cloud Run
# build จากรากโปรเจกต์ เพราะต้องใช้ทั้ง backend/ (โค้ด) และ backend/model/ (โมเดล)

FROM python:3.13-slim

# ---- ติดตั้งของที่ระบบต้องใช้ ----
# libgomp1 จำเป็นสำหรับ xgboost และ tensorflow (OpenMP)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# รันด้วยผู้ใช้ธรรมดา ไม่ใช่ root เพื่อความปลอดภัย
RUN useradd -m -u 1000 appuser
USER appuser
ENV PATH="/home/appuser/.local/bin:$PATH" \
    HOME=/home/appuser

WORKDIR /app

# ---- ติดตั้ง dependency ก่อนคัดลอกโค้ด ----
# แยกขั้นตอนเพื่อให้ docker ใช้ cache ได้ เวลาแก้โค้ดจะไม่ต้องติดตั้งใหม่ทั้งหมด
# (tensorflow ใช้เวลาติดตั้งนาน จึงคุ้มมากที่จะแยก)
COPY --chown=appuser backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --user -r requirements.txt

# ---- คัดลอกโค้ดและโมเดล ----
COPY --chown=appuser backend/ ./

# ---- ตั้งค่าตอนรัน ----
# ลดการจองหน่วยความจำของ TensorFlow และปิด log ที่ไม่จำเป็น
# OMP_NUM_THREADS จำกัดเธรดให้พอดีกับ CPU ที่ Cloud Run จัดให้
ENV TF_CPP_MIN_LOG_LEVEL=2 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    PORT=8080

EXPOSE 8080

# Cloud Run ส่งพอร์ตที่ต้องการมาทาง environment variable ชื่อ PORT
# จึงต้องใช้ CMD แบบ shell form เพื่อให้ $PORT ถูกแทนค่า
# (ถ้าใช้ exec form ["uvicorn", ..., "$PORT"] จะได้สตริง "$PORT" ตรง ๆ แล้วพัง)
# ส่วน exec ข้างหน้าทำให้ uvicorn เป็น process หลัก รับสัญญาณปิดจาก Cloud Run ได้ถูกต้อง
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
