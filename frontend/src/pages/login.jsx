import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";
import "../App.css";

export default function Login({ darkMode }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await login(username, password);
      localStorage.setItem("token", res.data.access_token);
      localStorage.setItem("username", res.data.username);
      navigate("/");
    } catch (err) {
      setError(err.response?.data?.detail || "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`page ${darkMode ? "dark" : ""}`}>
      <div className="login-wrap">
        <form className="login-card" onSubmit={handleSubmit}>
          <h2>เข้าสู่ระบบ</h2>
          <p className="muted small">เข้าสู่ระบบเพื่อใช้งาน Watchlist</p>

          <label className="field">
            <span>ชื่อผู้ใช้</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoFocus
            />
          </label>

          <label className="field">
            <span>รหัสผ่าน</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>

          {error && <div className="alert">⚠️ {error}</div>}

          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
          </button>

          <button type="button" className="link-btn" onClick={() => navigate("/")}>
            ← กลับหน้าหลัก
          </button>
        </form>
      </div>
    </div>
  );
}