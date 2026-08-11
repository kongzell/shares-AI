import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  addWatchlist, getWatchlist, removeWatchlist, getWatchlistAlerts,
  isLoggedIn, getUsername, logout,
} from "../api";
import "../App.css";

const API_URL = "http://localhost:8000";
const QUICK_STOCKS = [
  "AAPL",   // Apple
  "MSFT",   // Microsoft
  "NVDA",   // Nvidia
  "GOOGL",  // Google
  "AMZN",   // Amazon
  "META",   // Meta
  "TSLA",   // Tesla
  "NFLX",   // Netflix
  "AMD",    // AMD
  "BTC-USD" // Bitcoin
];
// แต่ละช่วงใช้ความละเอียดของแท่งต่างกัน ให้จำนวนแท่งพอเหมาะกับความกว้างกราฟ
const RANGES = {
  today: { label: "Today", days: 1, interval: "5m" },
  week:  { label: "Week",  days: 7, interval: "30m" },
  month: { label: "Month", days: 30, interval: "1d" },
};

const UP = "#1D9E75";
const DOWN = "#E24B4A";

// ความถี่ในการเช็คการทุ่มตลาดของหุ้นใน watchlist
const ALERT_POLL_MS = 30 * 1000;
// แหล่งข้อมูลปล่อยแท่งใหม่ทุก 1-2 นาที (โดยดีเลย์คงที่ ~30 นาที)
// ดึงทุก 5 นาทีจึงเกาะติดได้เกือบสุดโดยไม่เปลืองเกินจำเป็น
const PRICE_REFRESH_MS = 5 * 60 * 1000;
// การ์ดหุ้นยอดนิยม 10 ตัว ดึงทีละหลาย request จึงไม่ต้องถี่เท่าหุ้นที่กำลังดูอยู่
const QUICK_REFRESH_MS = 30 * 60 * 1000;
// ผลทำนายเป็นราคาปิดวันถัดไป เปลี่ยนช้า รันโมเดลชั่วโมงละครั้งพอ
const PREDICT_REFRESH_MS = 60 * 60 * 1000;

/**
 * แท่งเทียน 1 แท่ง — recharts ไม่มี candlestick ในตัว จึงวาดเองผ่าน shape ของ Bar
 * Bar ถูกกำหนด dataKey เป็นช่วง [low, high] ดังนั้น y = ตำแหน่งของ high
 * และ height = ความสูงของช่วง low→high เป็นพิกเซล ใช้คำนวณตำแหน่งตัวแท่งได้
 */
const Candle = ({ x, y, width, height, payload }) => {
  const { open, close, high, low } = payload;
  const color = close >= open ? UP : DOWN;
  const range = high - low;
  const scale = range === 0 ? 0 : height / range;

  const bodyTop = y + (high - Math.max(open, close)) * scale;
  const bodyHeight = Math.max(Math.abs(close - open) * scale, 1); // อย่างน้อย 1px ตอนราคาปิด=เปิด
  const bodyWidth = Math.max(width, 1);
  const center = x + width / 2;

  return (
    <g>
      {/* ไส้เทียน: ช่วง low → high */}
      <line x1={center} y1={y} x2={center} y2={y + height} stroke={color} strokeWidth={1} />
      {/* ตัวเทียน: ช่วง open → close */}
      <rect x={x} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
    </g>
  );
};

export default function Dashboard({ darkMode, setDarkMode }) {
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState("AAPL");
  const [modelName, setModelName] = useState("lstm");
  const [stock, setStock] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyMeta, setHistoryMeta] = useState(null);
  const [quickData, setQuickData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastFetch, setLastFetch] = useState(null);
  const [range, setRange] = useState("week");
  const [alertScan, setAlertScan] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [starLoading, setStarLoading] = useState(false);
  const [showUser, setShowUser] = useState(false);
  const [username] = useState(getUsername());
  const bellRef = useRef(null);
  const userRef = useRef(null);

  const symbolOf = (currency) => {
    const map = { USD: "$", THB: "฿", EUR: "€", JPY: "¥", GBP: "£" };
    return map[currency] || (currency ? currency + " " : "$");
  };  

  const fetchData = async (target = symbol) => {
    if (!target.trim()) return;
    setLoading(true);
    setError("");
    try {
      const [stockRes, predRes, histRes] = await Promise.all([
        axios.get(`${API_URL}/stock/${target}`),
        axios.get(`${API_URL}/predict/${target}?model_name=${modelName}`),
        axios.get(`${API_URL}/stock/${target}/history?days=${RANGES[range].days}&interval=${RANGES[range].interval}`),
      ]);
      setStock(stockRes.data);
      setPrediction(predRes.data);
      setHistory(histRes.data.history);
      setHistoryMeta({
        lastUpdated: histRes.data.last_updated,
        ageMinutes: histRes.data.data_age_minutes,
        isIntraday: histRes.data.is_intraday,
      });
      setLastFetch(new Date().toLocaleTimeString("th-TH"));
    } catch (err) {
      setError(err.response?.data?.detail || "ไม่พบข้อมูลหุ้นนี้");
      setStock(null); setPrediction(null); setHistory([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (stock) fetchData();
  }, [range, modelName]);

  // ===== เฝ้าระวังการทุ่มตลาดของหุ้นใน watchlist =====
  // เรียกถี่กว่าการรีเฟรชราคามาก เพราะต้องรู้ทันตอนมีการเทขายในกรอบ 1-5 นาที
  const fetchAlert = async () => {
    if (!isLoggedIn()) {
      setAlertScan(null);
      return;
    }
    try {
      const res = await getWatchlistAlerts();
      setAlertScan(res.data);
    } catch {
      setAlertScan(null);
    }
  };

  useEffect(() => {
    if (!isLoggedIn()) return;
    fetchAlert();
    const t = setInterval(fetchAlert, ALERT_POLL_MS);
    return () => clearInterval(t);
  }, [watchlist.length]);

  // ดึงการ์ดหุ้นยอดนิยมด้านบน
  const fetchQuick = async () => {
    try {
      const results = await Promise.all(
        QUICK_STOCKS.map((s) => axios.get(`${API_URL}/stock/${s}`).catch(() => null))
      );
      setQuickData(results.filter(Boolean).map((r) => r.data));
    } catch { /* ไม่ต้องทำอะไร */ }
  };

  useEffect(() => {
    fetchData();
    fetchQuick();
    if (isLoggedIn()) fetchWatchlist();
  }, []);

  const fetchWatchlist = async () => {
    setWatchlistLoading(true);
    try {
      const res = await getWatchlist();
      setWatchlist(res.data.symbols || []);
    } catch {
      setWatchlist([]);
    } finally {
      setWatchlistLoading(false);
    }
  };

  const toggleWatchlist = () => {
    if (!isLoggedIn()) {
      navigate("/login");
      return;
    }
    if (!showWatchlist) fetchWatchlist();
    setShowWatchlist((v) => !v);
  };

  const handleRemoveWatchlist = async (target) => {
    await removeWatchlist(target);
    fetchWatchlist();
  };

  // เพิ่ม/ลบหุ้นที่กำลังดูอยู่ ออกจาก watchlist
  const inWatchlist = !!stock && watchlist.includes(stock.symbol);

  const toggleStar = async () => {
    if (!isLoggedIn()) {
      navigate("/login");
      return;
    }
    if (!stock) return;
    setStarLoading(true);
    try {
      if (inWatchlist) {
        await removeWatchlist(stock.symbol);
      } else {
        await addWatchlist(stock.symbol);
      }
      await fetchWatchlist();
    } catch (err) {
      // 409 = มีอยู่แล้ว ให้ sync รายการใหม่พอ
      if (err.response?.status === 409) await fetchWatchlist();
    } finally {
      setStarLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    setShowUser(false);
    setShowWatchlist(false);
    setWatchlist([]);
    navigate("/login");
  };

  // ปิดเมนูเมื่อคลิกนอกพื้นที่
  useEffect(() => {
    const onClickOutside = (e) => {
      if (bellRef.current && !bellRef.current.contains(e.target)) setShowAlerts(false);
      if (userRef.current && !userRef.current.contains(e.target)) setShowUser(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // รีเฟรชเฉพาะหุ้นที่กำลังดูอยู่ — ไม่แตะผลทำนาย เพื่อไม่ให้รันโมเดลถี่เกินจำเป็น
  const refreshPrice = async (target = symbol) => {
    if (!target.trim()) return;
    try {
      const [stockRes, histRes] = await Promise.all([
        axios.get(`${API_URL}/stock/${target}`),
        axios.get(`${API_URL}/stock/${target}/history?days=${RANGES[range].days}&interval=${RANGES[range].interval}`),
      ]);
      setStock(stockRes.data);
      setHistory(histRes.data.history);
      setHistoryMeta({
        lastUpdated: histRes.data.last_updated,
        ageMinutes: histRes.data.data_age_minutes,
        isIntraday: histRes.data.is_intraday,
      });
      setLastFetch(new Date().toLocaleTimeString("th-TH"));
    } catch { /* รอบถัดไปค่อยลองใหม่ ไม่ต้องรบกวนหน้าจอ */ }
  };

  useEffect(() => {
    const t = setInterval(() => refreshPrice(), PRICE_REFRESH_MS);
    return () => clearInterval(t);
  }, [symbol, range]);

  useEffect(() => {
    const t = setInterval(() => fetchQuick(), QUICK_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  // รันโมเดลทำนายใหม่ชั่วโมงละครั้ง
  useEffect(() => {
    const t = setInterval(async () => {
      if (!symbol.trim()) return;
      try {
        const res = await axios.get(
          `${API_URL}/predict/${symbol}?model_name=${modelName}`
        );
        setPrediction(res.data);
      } catch { /* ไม่ต้องทำอะไร */ }
    }, PREDICT_REFRESH_MS);
    return () => clearInterval(t);
  }, [symbol, modelName]);

  // มีหุ้นอย่างน้อยหนึ่งตัวที่ข้อมูลยังสด = ระบบกำลังเฝ้าอยู่จริง
  const anyLive = !!alertScan?.results?.some((r) => r.is_live);

  // สัญญาณของหุ้นที่กำลังดูอยู่ (แสดงป้ายเตือนบนกราฟ เฉพาะตัวที่อยู่ใน watchlist)
  const currentAlert = alertScan?.results?.find(
    (r) => r.symbol === stock?.symbol && r.has_anomaly
  );

  const formatVolume = (n) => {
    if (!n) return "-";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toString();
  };

  /*
   * ปรับช่องว่างระหว่างรอบซื้อขาย (gap) ให้แท่งเทียนต่อกันเป็นเส้นเดียว
   * เลื่อนทั้งแท่งด้วยค่าคงที่ (offset) เพื่อให้ราคาเปิดของแท่งนี้ = ราคาปิดของแท่งก่อนหน้า
   *   offset[i] = offset[i-1] + close[i-1] - open[i]
   * แล้วหักด้วย offset ของแท่งสุดท้าย เพื่อ "ตรึง" แท่งล่าสุดไว้ที่ราคาจริง
   * แท่งเก่าจึงถูกเลื่อนมาหาแท่งใหม่ ราคาปัจจุบันบนหน้าจอยังตรงกับตลาด
   * หมายเหตุ: ค่าที่แสดงบนแกน Y เป็นราคาที่ปรับแล้ว ส่วนราคาจริงเก็บไว้ใน real* สำหรับ tooltip
   */
  const chartData = useMemo(() => {
    if (history.length === 0) return [];

    const offsets = [0];
    for (let i = 1; i < history.length; i++) {
      offsets[i] = offsets[i - 1] + history[i - 1].close - history[i].open;
    }
    const base = offsets[offsets.length - 1];

    return history.map((d, i) => {
      const shift = offsets[i] - base;
      const adj = (v) => Math.round((v + shift) * 100) / 100;
      return {
        ...d,
        open: adj(d.open),
        high: adj(d.high),
        low: adj(d.low),
        close: adj(d.close),
        realOpen: d.open,
        realHigh: d.high,
        realLow: d.low,
        realClose: d.close,
        shift: Math.round(shift * 100) / 100,
      };
    });
  }, [history]);

  const tooltipStyle = darkMode
    ? {
        borderRadius: 10,
        border: "1px solid #344054",
        background: "#1d2939",
        fontSize: 12,
        color: "#f2f4f7",
      }
    : {
        borderRadius: 10,
        border: "1px solid #eaecf0",
        background: "#ffffff",
        fontSize: 12,
        color: "#101828",
      };

  // tooltip ของแท่งเทียน — แสดง เปิด/สูงสุด/ต่ำสุด/ปิด
  const CandleTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const cur = symbolOf(stock?.currency);
    const up = d.realClose >= d.realOpen;

    return (
      <div className="candle-tip" style={tooltipStyle}>
        <div className="candle-tip-date">{d.datetime}</div>
        <div className="candle-tip-row"><span>เปิด</span><b>{cur}{d.realOpen}</b></div>
        <div className="candle-tip-row"><span>สูงสุด</span><b>{cur}{d.realHigh}</b></div>
        <div className="candle-tip-row"><span>ต่ำสุด</span><b>{cur}{d.realLow}</b></div>
        <div className="candle-tip-row">
          <span>ปิด</span>
          <b style={{ color: up ? UP : DOWN }}>{cur}{d.realClose}</b>
        </div>
        {d.shift !== 0 && (
          <div className="candle-tip-note">
            แท่งถูกเลื่อน {d.shift > 0 ? "+" : ""}{d.shift} เพื่อปิดช่องว่าง
          </div>
        )}
      </div>
    );
  };

  return (
  <div className={`page ${darkMode ? "dark" : ""}`}>

      {/* ===== Header ===== */}
      <header className="navbar">
        <div className="nav-search">
          <span className="search-icon">🔍</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && fetchData()}
            placeholder="ค้นหาหุ้น เช่น AAPL, KBANK, PTT, BTC-USD"
          />
          <kbd className="kbd">Enter</kbd>
        </div>

        <div className="nav-actions">
          <button
            className="icon-btn"
            onClick={() => setDarkMode(!darkMode)}
            title="สลับธีม"
          >
            {darkMode ? "☀️" : "🌙"}
          </button>

          <div className="bell-wrap" ref={bellRef}>
            <button
              className="icon-btn"
              onClick={() => setShowAlerts(!showAlerts)}
              title="แจ้งเตือน"
            >
              🔔
              {alertScan?.has_anomaly && (
                <span className="badge">{alertScan.alert_count}</span>
              )}
            </button>

            {showAlerts && (
              <div className="alert-panel">
                <div className="alert-head">
                  <div>เฝ้าระวังการทุ่มตลาด</div>
                  <div className="alert-sub">
                    <span className={`live-dot ${anyLive ? "on" : ""}`} />
                    {!isLoggedIn()
                      ? "เข้าสู่ระบบเพื่อเฝ้าระวัง Watchlist"
                      : `Watchlist ${alertScan?.checked ?? 0} ตัว · ตรวจทุก 30 วินาที`}
                  </div>
                </div>

                {!isLoggedIn() ? (
                  <div className="alert-empty">
                    🔒 ระบบเฝ้าระวังหุ้นใน Watchlist ของคุณ
                  </div>
                ) : alertScan?.checked === 0 ? (
                  <div className="alert-empty">
                    ยังไม่มีหุ้นใน Watchlist — กดดาวบนกราฟเพื่อเพิ่ม
                  </div>
                ) : alertScan?.has_anomaly ? (
                  alertScan.results
                    .filter((r) => r.has_anomaly)
                    .map((r) =>
                      r.alerts.map((a, i) => (
                        <button
                          key={`${r.symbol}-${i}`}
                          className={`alert-item ${a.severity}`}
                          onClick={() => { setSymbol(r.symbol); fetchData(r.symbol); }}
                          title={`ดูกราฟ ${r.symbol}`}
                        >
                          <div className="alert-method">
                            {r.symbol}
                            {!r.is_live && (
                              <span className="alert-tag">ข้อมูลไม่สด</span>
                            )}
                          </div>
                          <div className="alert-msg">{a.message}</div>
                          <div className="alert-time">
                            ข้อมูล {r.last_updated}
                          </div>
                        </button>
                      ))
                    )
                ) : (
                  <div className="alert-empty">✅ ไม่พบสัญญาณทุ่มตลาด</div>
                )}
              </div>
            )}
          </div>

          {/* ===== เมนูผู้ใช้ ===== */}
          {isLoggedIn() ? (
            <div className="user-wrap" ref={userRef}>
              <button
                className="user-btn"
                onClick={() => setShowUser(!showUser)}
                title="บัญชีผู้ใช้"
              >
                <span className="avatar">
                  {username?.charAt(0).toUpperCase() || "U"}
                </span>
                <span className="user-name">{username}</span>
                <span className={`chev ${showUser ? "open" : ""}`}>⌄</span>
              </button>

              {showUser && (
                <div className="user-panel">
                  <div className="user-head">
                    <div className="user-head-name">{username}</div>
                    <div className="user-head-sub">บัญชีผู้ใช้</div>
                  </div>

                  <button className="user-item danger" onClick={handleLogout}>
                    ⎋ ออกจากระบบ
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="nav-select" onClick={() => navigate("/login")}>
              เข้าสู่ระบบ
            </button>
          )}
        </div>
      </header>

      {/* ===== แถบหุ้นยอดนิยม (เลื่อนได้) ===== */}
      <section className="stat-scroller">
        <div className="stat-track">
          {quickData.map((s) => (
            <button
              key={s.symbol}
              className={`stat-card ${s.symbol === stock?.symbol ? "active" : ""}`}
              onClick={() => { setSymbol(s.symbol); fetchData(s.symbol); }}
            >
              <div className="stat-head">
                <span className="ticker">{s.symbol}</span>
                <span className={`pill ${s.change >= 0 ? "up" : "down"}`}>
                  {s.change >= 0 ? "▲" : "▼"} {Math.abs(s.change_percent)}%
                </span>
              </div>
              <div className="stat-price">{symbolOf(s.currency)}{s.latest_price}</div>
            </button>
          ))}
        </div>
      </section>

      {error && <div className="alert">⚠️ {error}</div>}

      {/* ===== เนื้อหาหลัก ===== */}
      {stock && prediction && (
        <div className="main-grid">
          {/* กราฟ */}
          <div className="panel chart-panel">
            <div className="panel-head">
              <div>
                <div className="symbol-row">
                  <h2>{stock.symbol}</h2>
                  <button
                    className={`star-btn ${inWatchlist ? "active" : ""}`}
                    onClick={toggleStar}
                    disabled={starLoading}
                    title={
                      inWatchlist
                        ? `ลบ ${stock.symbol} ออกจาก Watchlist`
                        : `เพิ่ม ${stock.symbol} เข้า Watchlist`
                    }
                  >
                    {inWatchlist ? "★" : "☆"}
                    <span>{inWatchlist ? "อยู่ใน Watchlist" : "เพิ่มเข้า Watchlist"}</span>
                  </button>
                </div>
                {currentAlert && (
                  <span className={`warn-badge ${currentAlert.is_live ? "live" : ""}`}>
                    ⚠️ {currentAlert.alerts[0].message}
                    {!currentAlert.is_live && " (ข้อมูลไม่สด)"}
                  </span>
                )}
                <p className="muted">ราคาย้อนหลัง · ปรับช่องว่างระหว่างรอบซื้อขายให้ต่อเนื่อง</p>

                {historyMeta?.isIntraday && historyMeta.lastUpdated && (
                  <p className="data-age">
                    ข้อมูลถึง {historyMeta.lastUpdated.slice(11)}
                    <span className={historyMeta.ageMinutes > 20 ? "lag warn" : "lag"}>
                      ช้ากว่าปัจจุบัน {historyMeta.ageMinutes} นาที
                    </span>
                  </p>
                )}
              </div>

              <div className="head-right">
                {/* ===== ปุ่มเลือกช่วงเวลา ===== */}
                <div className="segmented">
                  {Object.entries(RANGES).map(([key, cfg]) => (
                    <button
                      key={key}
                      className={range === key ? "seg-btn active" : "seg-btn"}
                      onClick={() => setRange(key)}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>

                <div className="price-now">
                  <div className="big">{symbolOf(stock.currency)}{stock.latest_price}</div>
                  <div className={stock.change >= 0 ? "up" : "down"}>
                    {stock.change >= 0 ? "▲" : "▼"} {stock.change} ({stock.change_percent}%)
                  </div>
                </div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke={darkMode ? "#2a3547" : "#f0f1f5"}
                  vertical={false}
                />
                <XAxis dataKey="datetime" tick={{ fontSize: 10, fill: "#98a2b3" }} minTickGap={50} tickLine={false} axisLine={false} />
                <YAxis domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: "#98a2b3" }} tickLine={false} axisLine={false} />
                <Tooltip
                  content={<CandleTooltip />}
                  cursor={{ fill: darkMode ? "#ffffff10" : "#00000008" }}
                />
                {/* ค่าเป็นช่วง [low, high] เพื่อให้ Bar กินพื้นที่เต็มไส้เทียน แล้ววาดจริงใน <Candle> */}
                <Bar
                  dataKey={(d) => [d.low, d.high]}
                  shape={<Candle />}
                  maxBarSize={14}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
            {/* ===== กราฟ Volume ===== */}
            <div className="volume-label">ปริมาณซื้อขาย</div>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={history} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <XAxis dataKey="datetime" hide />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#98a2b3" }} tickFormatter={formatVolume} tickLine={false} axisLine={false} width={55} />
                <Tooltip
                  formatter={(v) => [formatVolume(v), "Volume"]}
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: darkMode ? "#f2f4f7" : "#101828", fontWeight: 500 }}
                  itemStyle={{ color: "#465fff" }}
                  cursor={{ fill: darkMode ? "#ffffff10" : "#00000008" }}
                />
                <Bar dataKey="volume" opacity={0.55} maxBarSize={60} radius={[3, 3, 0, 0]}>
                  {history.map((d, i) => (
                    <Cell
                      key={i}
                      fill={i > 0 && d.close >= history[i - 1].close ? "#1D9E75" : "#E24B4A"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ผลทำนาย */}
          <div className="panel predict-panel">
            <div className="predict-head">
              <div>
                <h3>ผลการพยากรณ์</h3>
                <p className="muted small">ราคาปิดวันทำการถัดไป</p>
              </div>
              <select
                className="model-select"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              >
                <option value="lstm">LSTM</option>
                <option value="gru">GRU</option>
                <option value="tcn">TCN</option>
                <option value="xgboost">XGBoost</option>
              </select>
            </div>

            <div className="predict-value">{symbolOf(prediction.currency)}{prediction.predicted_close_tomorrow}</div>
            <div className={`predict-diff ${prediction.diff_percent >= 0 ? "up" : "down"}`}>
              {prediction.diff_percent >= 0 ? "▲" : "▼"} {Math.abs(prediction.diff_percent)}%
            </div>

            {/* ย้อนทำนายวันที่รู้คำตอบแล้ว เพื่อดูว่าโมเดลแม่นแค่ไหน */}
            {prediction.predicted_close_today != null && (
              <div className="backtest">
                <div className="backtest-head">
                  <span>ทำนายราคาปิดวันนี้ ({prediction.last_close_date})</span>
                  <span
                    className={`backtest-dir ${prediction.today_direction_correct ? "ok" : "miss"}`}
                  >
                    {prediction.today_direction_correct ? "✓ ทิศทางถูก" : "✕ ทิศทางผิด"}
                  </span>
                </div>

                <div className="backtest-row">
                  <div>
                    <div className="backtest-label">ทำนายไว้</div>
                    <div className="backtest-num">
                      {symbolOf(prediction.currency)}{prediction.predicted_close_today}
                    </div>
                  </div>
                  <div className="backtest-arrow">→</div>
                  <div>
                    <div className="backtest-label">ราคาจริง</div>
                    <div className="backtest-num actual">
                      {symbolOf(prediction.currency)}{prediction.actual_close_today}
                    </div>
                  </div>
                  <div className="backtest-err">
                    <div className="backtest-label">คลาดเคลื่อน</div>
                    <div
                      className={`backtest-num ${Math.abs(prediction.today_error_percent) <= 1 ? "good" : "bad"}`}
                    >
                      {prediction.today_error_percent > 0 ? "+" : ""}
                      {prediction.today_error_percent}%
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="divider" />

            <div className="kv"><span>ราคาปิดล่าสุด</span><b>{symbolOf(prediction.currency)}{prediction.last_close}</b></div>
            <div className="kv"><span>โมเดล</span><b>{prediction.model.toUpperCase()}</b></div>
            <div className="kv"><span>ข้อมูลล่าสุด</span><b>{stock.updated_at}</b></div>
            <div className="kv">
              <span>ปริมาณซื้อขาย</span>
              <b>{formatVolume(stock.volume)}</b>
            </div>

            {stock.volume_ratio && (
              <div className="kv">
                <span>เทียบเฉลี่ย 20 วัน</span>
                <b className={stock.volume_ratio >= 2 ? "up" : ""}>
                  {stock.volume_ratio}× {stock.volume_ratio >= 2 && "⚠️"}
                </b>
              </div>
            )}

            <div className="divider" />

            <button className="nav-select" onClick={toggleWatchlist}>
              ⭐ Watchlist
            </button>

            {showWatchlist && (
              <div className="watchlist-list">
                {watchlistLoading ? (
                  <p className="muted small">กำลังโหลด...</p>
                ) : watchlist.length === 0 ? (
                  <p className="muted small">ยังไม่มีหุ้นใน Watchlist</p>
                ) : (
                  watchlist.map((sym) => (
                    <div
                      key={sym}
                      className={`wl-item ${stock?.symbol === sym ? "active" : ""}`}
                    >
                      <button
                        className="wl-name"
                        title={`ดูกราฟ ${sym}`}
                        onClick={() => { setSymbol(sym); fetchData(sym); }}
                      >
                        {sym}
                      </button>
                      <button
                        className="wl-remove"
                        title={`ลบ ${sym} ออกจาก Watchlist`}
                        onClick={() => handleRemoveWatchlist(sym)}
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="foot">เพื่อการศึกษาเท่านั้น ไม่ใช่คำแนะนำการลงทุน</footer>
    </div>

  );
}
