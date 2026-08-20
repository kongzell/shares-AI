import sys
from getpass import getpass

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import engine, SessionLocal, Base
import models
from auth import hash_password

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

args = [a for a in sys.argv[1:] if a != "--server"]

if "--server" in sys.argv:
    # รับ URL ทาง getpass เพื่อไม่ให้รหัสผ่านใน connection string ขึ้นบนจอ
    # หรือค้างอยู่ใน history ของ shell
    url = getpass("วาง connection string: ").strip()
    if not url:
        sys.exit("ไม่ได้วาง connection string — ยกเลิก")
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    engine = create_engine(url)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# บอกให้เห็นก่อนถามรหัสผ่านว่ากำลังจะเขียนลงฐานข้อมูลไหน จะได้ยกเลิกทัน
# engine.url ไม่แสดงรหัสผ่านออกมา ปลอดภัยที่จะ print
host = engine.url.host or "localhost"
print(f"DATABASE: {host} / {engine.url.database}")
if host in ("localhost", "127.0.0.1"):
    print("  ^ นี่คือฐานข้อมูลในเครื่องนี้ ไม่ใช่ของ server")
    print("    ถ้าต้องการเขียนลง server ให้กด Ctrl+C แล้วรันใหม่โดยใส่ --server ต่อท้าย")

# รายชื่อเริ่มต้น ใช้เมื่อรันโดยไม่ใส่ argument
USERS = [
    ("admin", "admin1234"),
]

if args:
    username = args[0]
    if len(args) >= 2:
        password = args[1]
        print("! รหัสผ่านที่พิมพ์ต่อท้ายคำสั่งจะถูกเก็บไว้ใน history ของ shell")
    else:
        password = getpass("รหัสผ่าน: ")
    if not password:
        sys.exit("รหัสผ่านว่างไม่ได้")
    USERS = [(username, password)]

# สร้างตารางทั้งหมดใน database
Base.metadata.create_all(bind=engine)

db = SessionLocal()

for username, password in USERS:
    exists = db.query(models.User).filter(models.User.username == username).first()
    if exists:
        print(f"ข้าม {username} (มีอยู่แล้ว)")
        continue
    db.add(models.User(username=username, password_hash=hash_password(password)))
    print(f"เพิ่ม {username} สำเร็จ")

db.commit()
db.close()
