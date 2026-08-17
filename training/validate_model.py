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

import pandas as pd  # noqa: E402
import onnxruntime as ort  # noqa: E402
from xgboost import XGBRegressor  # noqa: E402
from tensorflow.keras.models import load_model  # noqa: E402
from tcn import TCN  # noqa: E402

LOOKBACK = 30
XGB_FEATURES = ["Return", "MA7", "MA30", "Prev_Return"]
# ตรวจทั้งคู่: .keras คือต้นฉบับ ส่วน .onnx คือตัวที่ backend ใช้จริง
# ต้องเทียบกันด้วยเพื่อจับกรณีที่แปลงแล้วผลเพี้ยน
SEQ_MODELS = {
    "lstm": "multi_asset_lstm",
    "gru": "gru_model",
    "tcn": "tcn_model",
}
# ผลจาก ONNX ต้องต่างจากต้นฉบับไม่เกินค่านี้ (วัดจริงตอนทดสอบได้ราว 3.7e-08)
ONNX_TOLERANCE = 1e-4
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

    # ใช้ข้อมูลสุ่มที่มีสเกลใกล้เคียง return จริง แทนที่จะเป็นศูนย์ล้วน
    # เพราะ input ศูนย์อาจบังผลเพี้ยนบางแบบไว้
    rng = np.random.default_rng(0)
    probe = rng.normal(0, 0.02, size=(8, LOOKBACK, 1)).astype("float32")

    for name, stem in SEQ_MODELS.items():
        keras_path = model_dir / f"{stem}.keras"
        onnx_path = model_dir / f"{stem}.onnx"

        if not onnx_path.exists():
            fail(f"ไม่พบไฟล์ {onnx_path.name} — backend ใช้ไฟล์นี้ในการทำนาย")

        # ตัวที่ backend ใช้จริงต้องโหลดได้และให้ค่าที่สมเหตุสมผล
        try:
            sess = ort.InferenceSession(str(onnx_path),
                                        providers=["CPUExecutionProvider"])
            out = sess.run(None, {sess.get_inputs()[0].name: probe})[0]
        except Exception as exc:
            fail(f"โหลด {onnx_path.name} ไม่ได้ หรือทำนายไม่ผ่าน: {exc}")
        if np.shape(out) != (len(probe), 1):
            fail(f"{onnx_path.name} คืนค่ารูปร่าง {np.shape(out)} "
                 f"ควรเป็น ({len(probe)}, 1)")
        if not np.isfinite(out).all():
            fail(f"{onnx_path.name} ทำนายออกมาเป็น NaN หรือ inf")

        # ถ้ามีต้นฉบับ ให้เทียบว่าแปลงแล้วผลยังตรงกัน
        # จับกรณีที่แปลงสำเร็จแต่ได้โมเดลที่คำนวณผิด ซึ่งอันตรายกว่าแปลงไม่ผ่าน
        if keras_path.exists():
            try:
                kmodel = load_model(keras_path, custom_objects={"TCN": TCN})
                kout = kmodel.predict(probe, verbose=0)
            except Exception as exc:
                fail(f"โหลดต้นฉบับ {keras_path.name} ไม่ได้: {exc}")
            gap = float(np.max(np.abs(kout - out)))
            if gap > ONNX_TOLERANCE:
                fail(f"{name}: ผล ONNX ต่างจากต้นฉบับ {gap:.2e} "
                     f"เกินเกณฑ์ {ONNX_TOLERANCE:.0e}")
            print(f"  {name:8s} onnx โหลดได้ ตรงกับต้นฉบับ (ต่าง {gap:.1e})")
        else:
            print(f"  {name:8s} onnx โหลดได้ (ไม่มีต้นฉบับให้เทียบ)")

    path = model_dir / "xgboost_model.json"
    if not path.exists():
        fail("ไม่พบไฟล์ xgboost_model.json")
    try:
        xgb = XGBRegressor()
        xgb.load_model(path)
        out = xgb.predict(pd.DataFrame([[0.0, 0.0, 0.0, 0.0]], columns=XGB_FEATURES))
    except Exception as exc:
        fail(f"โหลด xgboost_model.json ไม่ได้ หรือทำนายไม่ผ่าน: {exc}")
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
