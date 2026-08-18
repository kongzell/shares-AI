from database import engine, SessionLocal, Base
import models
from auth import hash_password

# สร้างตารางทั้งหมดใน database
Base.metadata.create_all(bind=engine)

db = SessionLocal()

USERS = [
    ("admin", "admin1234"),
    ("student", "student1234"),
]

for username, password in USERS:
    exists = db.query(models.User).filter(models.User.username == username).first()
    if exists:
        continue
    db.add(models.User(username=username, password_hash=hash_password(password)))

db.commit()
db.close()