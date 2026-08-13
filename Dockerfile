# Dockerfile สำหรับ deploy backend ขึ้น Hugging Face Spaces
# build จากรากโปรเจกต์ เพราะต้องใช้ทั้ง backend/ (โค้ด) และ backend/model/ (โมเดล)

FROM python:3.13-slim

# ---- ติดตั้งของที่ระบบต้องใช้ ----
# libgomp1 จำเป็นสำหรับ xgboost และ tensorflow (OpenMP)
# curl ใช้สำหรับ healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face รัน container ด้วย user id 1000 ไม่ใช่ root
# ถ้าไม่สร้าง user นี้ไว้ จะเขียนไฟล์ชั่วคราวไม่ได้ตอนรัน
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH" \
    HOME=/home/user

WORKDIR /app

# ---- ติดตั้ง dependency ก่อนคัดลอกโค้ด ----
# แยกขั้นตอนเพื่อให้ docker ใช้ cache ได้ เวลาแก้โค้ดจะไม่ต้องติดตั้งใหม่ทั้งหมด
# (tensorflow ใช้เวลาติดตั้งนาน จึงคุ้มมากที่จะแยก)
COPY --chown=user backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --user -r requirements.txt

# ---- คัดลอกโค้ดและโมเดล ----
COPY --chown=user backend/ ./

# ---- ตั้งค่าตอนรัน ----
# ลดการจองหน่วยความจำของ TensorFlow และปิด log ที่ไม่จำเป็น
ENV TF_CPP_MIN_LOG_LEVEL=2 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2

# Hugging Face Spaces กำหนดให้แอปฟังที่พอร์ต 7860 เท่านั้น
EXPOSE 7860

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s \
    CMD curl -f http://localhost:7860/ || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
