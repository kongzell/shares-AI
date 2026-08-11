"""
ตรวจว่าโมเดลที่เพิ่งเทรนใช้งานได้จริงและไม่แย่ลงกว่าของเดิม

ทำหน้าที่เป็นด่านสุดท้ายก่อน commit โมเดลขึ้น git ถ้าไม่ผ่านจะ exit 1
ทำให้ GitHub Actions หยุดทันที ไม่ทับของเดิม เว็บที่ deploy อยู่จึงยังใช้โมเดลตัวเก่าต่อไป

จำเป็นเพราะการเทรนอัตโนมัติไม่มีคนคอยดูทุกสัปดาห์
ถ้าข้อมูลช่วงนั้นผิดปกติจนโมเดลเพี้ยน มันจะขึ้นเว็บทันทีโดยไม่มีใครรู้

ใช้งาน:
    python training/validate_model.py --model-dir backend/model
    python training/validate_model.py --model-dir backend/model --max-worse 25
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import joblib  # noqa: E402
import pandas as pd  # noqa: E402
from tensorflow.keras.models import load_model  # noqa: E402
from tcn import TCN  # noqa: E402

LOOKBACK = 30
XGB_FEATURES = ["Return", "MA7", "MA30", "Prev_Return"]
KERAS_MODELS = {
    "lstm": "multi_asset_lstm.keras",
    "gru": "gru_model.keras",
    "tcn": "tcn_model.keras",
}
# เพดานความคลาดเคลื่อนสัมบูรณ์ — ผลตอบแทนรายวันปกติไม่ควรเกินระดับนี้
# ถ้าโมเดลทำนายเกินนี้แปลว่าเพี้ยนหนัก ไม่ใช่แค่แม่นน้อยลง
SANITY_MAE_LIMIT = 10.0


def fail(message):
    print(f"ไม่ผ่าน: {message}")
    sys.exit(1)


def load_previous_metrics(model_dir: Path):
    """
    อ่าน metrics.json เวอร์ชันก่อนหน้าจาก git เพื่อใช้เทียบ
    ถ้าเป็นการเทรนครั้งแรกหรือไม่มีประวัติ จะคืน None แล้วข้ามการเทียบไป
    """
    target = f"HEAD:{(model_dir / 'metrics.json').as_posix()}"
    try:
        raw = subprocess.run(["git", "show", target],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if raw.returncode != 0 or not raw.stdout.strip():
        return None
    try:
        return json.loads(raw.stdout)
    except json.JSONDecodeError:
        return None


def check_files_loadable(model_dir: Path):
    """โหลดโมเดลจริงและลองทำนายด้วยข้อมูลปลอม เพื่อยืนยันว่าไฟล์ไม่เสียและรูปร่าง input ตรง"""
    dummy_seq = np.zeros((1, LOOKBACK, 1), dtype="float32")

    for name, filename in KERAS_MODELS.items():
        path = model_dir / filename
        if not path.exists():
            fail(f"ไม่พบไฟล์โมเดล {filename}")
        try:
            model = load_model(path, custom_objects={"TCN": TCN})
            out = model.predict(dummy_seq, verbose=0)
        except Exception as exc:
            fail(f"โหลด {filename} ไม่ได้ หรือทำนายไม่ผ่าน: {exc}")
        if np.shape(out) != (1, 1):
            fail(f"{filename} คืนค่ารูปร่าง {np.shape(out)} ควรเป็น (1, 1)")
        if not np.isfinite(out).all():
            fail(f"{filename} ทำนายออกมาเป็น NaN หรือ inf")
        print(f"  {name:8s} โหลดได้ ทำนายได้ปกติ")

    path = model_dir / "xgboost_model.pkl"
    if not path.exists():
        fail("ไม่พบไฟล์ xgboost_model.pkl")
    try:
        xgb = joblib.load(path)
        out = xgb.predict(pd.DataFrame([[0.0, 0.0, 0.0, 0.0]], columns=XGB_FEATURES))
    except Exception as exc:
        fail(f"โหลด xgboost_model.pkl ไม่ได้ หรือทำนายไม่ผ่าน: {exc}")
    if not np.isfinite(out).all():
        fail("xgboost ทำนายออกมาเป็น NaN หรือ inf")
    print("  xgboost  โหลดได้ ทำนายได้ปกติ")


def check_metrics(model_dir: Path, max_worse_percent: float):
    metrics_path = model_dir / "metrics.json"
    if not metrics_path.exists():
        fail("ไม่พบ metrics.json — train.py อาจทำงานไม่สำเร็จ")

    new = json.loads(metrics_path.read_text(encoding="utf-8"))
    new_metrics = new.get("metrics", {})

    # ด่านที่ 1 ค่าต้องอยู่ในวิสัยที่เป็นไปได้
    for name, m in new_metrics.items():
        mae = m.get("mae_percent")
        if mae is None or not np.isfinite(mae):
            fail(f"{name}: ค่า MAE ใช้ไม่ได้ ({mae})")
        if mae > SANITY_MAE_LIMIT:
            fail(f"{name}: MAE {mae:.3f}% สูงเกินเกณฑ์ {SANITY_MAE_LIMIT}% — โมเดลน่าจะเพี้ยน")

    # ด่านที่ 2 เทียบกับรอบก่อนหน้า
    old = load_previous_metrics(model_dir)
    if old is None:
        print("\nไม่มีผลรอบก่อนให้เทียบ (เทรนครั้งแรก) — ข้ามการเปรียบเทียบ")
        return

    old_metrics = old.get("metrics", {})
    print(f"\nเทียบกับรอบก่อนหน้า (เทรนเมื่อ {old.get('trained_at', 'ไม่ทราบ')}):")

    regressions = []
    for name, m in new_metrics.items():
        if name not in old_metrics:
            continue
        new_mae = m["mae_percent"]
        old_mae = old_metrics[name]["mae_percent"]
        if old_mae <= 0:
            continue
        change = (new_mae - old_mae) / old_mae * 100
        mark = "แย่ลง" if change > 0 else "ดีขึ้น"
        print(f"  {name:8s} {old_mae:6.3f}% -> {new_mae:6.3f}%  ({mark} {abs(change):.1f}%)")
        if change > max_worse_percent:
            regressions.append(f"{name} แย่ลง {change:.1f}%")

    if regressions:
        fail("โมเดลใหม่แย่กว่าเดิมเกินเกณฑ์ที่ยอมรับได้ "
             f"({max_worse_percent}%): " + ", ".join(regressions))


def main():
    parser = argparse.ArgumentParser(description="ตรวจคุณภาพโมเดลก่อนนำไป deploy")
    parser.add_argument("--model-dir", default="backend/model")
    parser.add_argument("--max-worse", type=float, default=15.0,
                        help="ยอมให้ MAE แย่ลงได้กี่ %% เทียบกับรอบก่อน (ค่าเริ่มต้น 15)")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    if not model_dir.is_dir():
        fail(f"ไม่พบโฟลเดอร์ {model_dir}")

    print("ตรวจว่าไฟล์โมเดลโหลดและทำนายได้:")
    check_files_loadable(model_dir)

    check_metrics(model_dir, args.max_worse)

    print("\nผ่านทุกด่าน — โมเดลพร้อมนำไปใช้")


if __name__ == "__main__":
    main()
