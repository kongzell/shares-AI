import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  BarChart, Bar, Cell, ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  addWatchlist, getWatchlist, removeWatchlist, getWatchlistAlerts,
  getWatchlistNews, getPredictHistory, isLoggedIn, getUsername, logout,
} from "../api";
import "../App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
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
const ALERT_POLL_MS = 2 * 60 * 1000;
// แหล่งข้อมูลปล่อยแท่งใหม่ทุก 1-2 นาที (โดยดีเลย์คงที่ ~30 นาที)
// ดึงทุก 5 นาทีจึงเกาะติดได้เกือบสุดโดยไม่เปลืองเกินจำเป็น
const PRICE_REFRESH_MS = 5 * 60 * 1000;
// การ์ดหุ้นยอดนิยม 10 ตัว ดึงทีละหลาย request จึงไม่ต้องถี่เท่าหุ้นที่กำลังดูอยู่
const QUICK_REFRESH_MS = 30 * 60 * 1000;
// ผลทำนายเป็นราคาปิดวันถัดไป เปลี่ยนช้า รันโมเดลชั่วโมงละครั้งพอ
const PREDICT_REFRESH_MS = 60 * 60 * 1000;
// ข่าวออกไม่ถี่ และฝั่ง backend ก็ cache ไว้ 10 นาทีอยู่แล้ว
const NEWS_REFRESH_MS = 10 * 60 * 1000;
// ความเร็วที่กระดานข่าวเลื่อนเอง ช้าพอให้อ่านเนื้อหาย่อทัน
const NEWS_SPEED_PX_SEC = 28;

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

/** อายุข่าวเป็นชั่วโมง → ข้อความไทยแบบย่อ */
const newsAge = (hours) => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} นาทีที่แล้ว`;
  if (hours < 24) return `${Math.round(hours)} ชม.ที่แล้ว`;
  return `${Math.round(hours / 24)} วันที่แล้ว`;
};

/**
 * กระดานข่าวท้ายหน้า dashboard — การ์ดข่าวเรียงแนวนอน เลื่อนเองแบบแถบหุ้น
 *
 * ใช้ scrollLeft แทน CSS transform เพราะแบบนี้ผู้ใช้ยังปัด/ลากอ่านเองได้ตามปกติ
 * วางการ์ดซ้ำสองชุด พอเลื่อนถึงครึ่งทางก็ดึงกลับมาที่ต้นชุดสอง ภาพจึงต่อเนียน
 */
const NewsBoard = ({ items, loading, hasWatchlist }) => {
  const trackRef = useRef(null);
  const hoverRef = useRef(false);
  const nudgeRef = useRef(false);
  const nudgeTimer = useRef(null);
  const wrapRef = useRef(0);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: 0 });

  useEffect(() => {
    const el = trackRef.current;
    if (!el || items.length === 0) return;

    // ระยะที่ต้องเลื่อนก่อนวนกลับ = ระยะจากการ์ดใบแรกของชุดหนึ่งไปยังใบแรกของชุดสอง
    // ใช้ scrollWidth/2 ไม่ได้ เพราะชุดสุดท้ายไม่มีช่องไฟต่อท้าย จะเพี้ยนไปหนึ่งช่องไฟ
    const period = () => {
      const first = el.children[0];
      const second = el.children[items.length];
      return second ? second.offsetLeft - first.offsetLeft : el.scrollWidth / 2;
    };

    wrapRef.current = period();
    const onResize = () => { wrapRef.current = period(); };
    window.addEventListener("resize", onResize);

    // เครื่องที่ตั้งค่าลดการเคลื่อนไหวไว้ ให้อยู่นิ่ง แต่ยังลาก/กดปุ่มลูกศรเลื่อนเองได้
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf;
    let last = performance.now();

    const step = (now) => {
      const dt = now - last;
      last = now;
      const drag = dragRef.current.active;
      if (!hoverRef.current && !drag && !nudgeRef.current) {
        // ผู้ใช้อาจเพิ่งลากไปเอง จึงยึดตำแหน่งจริงเป็นหลักก่อนเดินต่อ
        let pos = el.scrollLeft + (NEWS_SPEED_PX_SEC * dt) / 1000;
        if (pos >= wrapRef.current) pos -= wrapRef.current;
        el.scrollLeft = pos;
      }
      raf = requestAnimationFrame(step);
    };

    if (!still) raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      clearTimeout(nudgeTimer.current);
    };
  }, [items.length]);

  /** ปุ่มลูกศร — เลื่อนทีละเกือบเต็มหน้าจอ พร้อมหยุดตัวเลื่อนอัตโนมัติชั่วคราว */
  const nudge = (dir) => {
    const el = trackRef.current;
    if (!el) return;
    const step = el.clientWidth * 0.8;
    // ถอยหลังจนติดขอบซ้ายจะหลุดภาพวนไม่รู้จบ จึงกระโดดไปชุดถัดไปก่อน
    if (dir < 0 && el.scrollLeft < step) el.scrollLeft += wrapRef.current;
    nudgeRef.current = true;
    el.scrollTo({ left: el.scrollLeft + dir * step, behavior: "smooth" });
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => { nudgeRef.current = false; }, 600);
  };

  // ===== ลากด้วยเมาส์ =====
  // จอสัมผัสปัดได้เองอยู่แล้ว ถ้าดักด้วยจะกลายเป็นเลื่อนสองเท่า จึงรับเฉพาะเมาส์
  const onPointerDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = trackRef.current;
    dragRef.current = { active: true, startX: e.clientX, startScroll: el.scrollLeft, moved: 0 };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const dx = e.clientX - drag.startX;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    trackRef.current.scrollLeft = drag.startScroll - dx;
  };

  const endDrag = (e) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const el = trackRef.current;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  // ลากแล้วปล่อยบนการ์ด เบราว์เซอร์จะนับเป็นคลิกด้วย ต้องกันไม่ให้เปิดลิงก์
  const onClickCapture = (e) => {
    if (dragRef.current.moved > 5) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.moved = 0;
    }
  };

  let body;
  if (loading && items.length === 0) {
    body = <p className="muted small">กำลังโหลดข่าว...</p>;
  } else if (!hasWatchlist) {
    body = <p className="muted small">เพิ่มหุ้นเข้า Watchlist เพื่อดูข่าวของหุ้นนั้น</p>;
  } else if (items.length === 0) {
    body = <p className="muted small">ไม่มีข่าวของหุ้นใน Watchlist ในรอบ 1 สัปดาห์</p>;
  } else {
    body = (
      <div
        className="news-track"
        ref={trackRef}
        onMouseEnter={() => { hoverRef.current = true; }}
        onMouseLeave={() => { hoverRef.current = false; }}
        onTouchStart={() => { hoverRef.current = true; }}
        onTouchEnd={() => { hoverRef.current = false; }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        onDragStart={(e) => e.preventDefault()}
      >
        {/* aria-hidden ที่ชุดสอง กันโปรแกรมอ่านหน้าจออ่านข่าวซ้ำสองรอบ */}
        {[0, 1].map((copy) =>
          items.map((item) => (
            <a
              key={`${copy}-${item.id}`}
              className="news-card"
              href={item.link || undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-hidden={copy === 1 ? "true" : undefined}
              tabIndex={copy === 1 ? -1 : undefined}
            >
              <div className="news-card-head">
                <span className="news-sym">{item.symbol}</span>
                <span className="news-time">{newsAge(item.age_hours)}</span>
              </div>
              <h4 className="news-title">{item.title}</h4>
              {item.summary && <p className="news-summary">{item.summary}</p>}
              {item.publisher && <span className="news-src">{item.publisher}</span>}
            </a>
          ))
        )}
      </div>
    );
  }

  return (
    <section className="panel news-panel">
      <div className="panel-head">
        <h2>ข่าว Watchlist</h2>
        <div className="news-tools">
          <span className="muted small">ย้อนหลัง 7 วัน</span>
          {items.length > 0 && (
            <>
              <button className="news-arrow" onClick={() => nudge(-1)} title="ข่าวก่อนหน้า" aria-label="เลื่อนไปทางซ้าย">‹</button>
              <button className="news-arrow" onClick={() => nudge(1)} title="ข่าวถัดไป" aria-label="เลื่อนไปทางขวา">›</button>
            </>
          )}
        </div>
      </div>
      {body}
    </section>
  );
};

/**
 * ประวัติการทำนายย้อนหลัง 1 เดือน — กราฟเทียบทำนายกับราคาจริง แล้วต่อด้วยตาราง
 * ตัวเลขสรุปบนหัวบอกว่าที่ผ่านมาโมเดลกับแถบพยากรณ์เชื่อได้แค่ไหนสำหรับหุ้นตัวนี้
 */
const PredictHistory = ({ data, loading, currencyOf, darkMode }) => {
  const chartData = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.map((r) => ({
      date: r.date.slice(5),
      band: r.band_low != null ? [r.band_low, r.band_high] : null,
      predicted: r.predicted,
      actual: r.actual,
    }));
  }, [data]);

  if (loading && !data) {
    return (
      <section className="panel history-panel">
        <div className="panel-head"><h2>ประวัติย้อนหลัง 1 เดือน</h2></div>
        <p className="muted small">กำลังคำนวณ...</p>
      </section>
    );
  }
  if (!data?.rows?.length) return null;

  const s = data.summary;
  const cur = currencyOf(data.currency);
  const axisColor = darkMode ? "#98a2b3" : "#667085";
  const gridColor = darkMode ? "#344054" : "#eaecf0";

  return (
    <section className="panel history-panel">
      <div className="panel-head">
        <div>
          <h2>ประวัติย้อนหลัง 1 เดือน</h2>
          <div className="muted small">
            {data.symbol} · {data.model.toUpperCase()} · {s.count} วันทำการ ·{" "}
            {data.rows[0].date} ถึง {data.rows[s.count - 1].date}
          </div>
        </div>
        <div className="history-stats">
          <div>
            <div className="hs-label">คลาดเคลื่อนเฉลี่ย</div>
            <div className="hs-value">{s.mae_percent}%</div>
          </div>
          <div>
            <div className="hs-label">ทายทิศทางถูก</div>
            <div className={`hs-value ${s.direction_accuracy >= 55 ? "good" : ""}`}>
              {s.direction_correct}/{s.count} · {s.direction_accuracy}%
            </div>
          </div>
          {s.band_coverage != null && (
            <div>
              <div className="hs-label">อยู่ในแถบ {s.band_level}%</div>
              {/* ต่ำกว่าที่โฆษณาไว้มาก = แถบแคบเกินจริงสำหรับหุ้นตัวนี้ */}
              <div className={`hs-value ${s.band_coverage >= s.band_level - 5 ? "good" : "warn"}`}>
                {s.in_band}/{s.count} · {s.band_coverage}%
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="history-legend">
        <span className="hl band">แถบ {s.band_level}%</span>
        <span className="hl pred">ทำนาย</span>
        <span className="hl act">ราคาจริง</span>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis dataKey="date" stroke={axisColor} tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis stroke={axisColor} tick={{ fontSize: 11 }} domain={["auto", "auto"]} width={62} />
          <Tooltip
            contentStyle={{
              background: darkMode ? "#1d2939" : "#fff",
              border: `1px solid ${gridColor}`,
              borderRadius: 10,
              fontSize: 12,
            }}
            labelStyle={{ color: axisColor }}
            formatter={(value, name) => {
              if (Array.isArray(value)) return [`${cur}${value[0]} – ${cur}${value[1]}`, `แถบ ${s.band_level}%`];
              return [`${cur}${value}`, name === "predicted" ? "ทำนาย" : "ราคาจริง"];
            }}
          />
          <Area dataKey="band" stroke="none" fill="#465fff" fillOpacity={0.16} connectNulls />
          <Line dataKey="predicted" stroke="#465fff" strokeWidth={1.6} strokeDasharray="4 3" dot={false} />
          <Line dataKey="actual" stroke={darkMode ? "#f2f4f7" : "#101828"} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="history-table-wrap">
        <table className="history-table">
          <thead>
            <tr>
              <th>วันที่</th><th>ทำนาย</th><th>จริง</th><th>คลาดเคลื่อน</th>
              <th>ทิศทาง</th>{s.band_coverage != null && <th>แถบ {s.band_level}%</th>}
            </tr>
          </thead>
          <tbody>
            {[...data.rows].reverse().map((r) => (
              <tr key={r.date}>
                <td>{r.date}</td>
                <td>{cur}{r.predicted}</td>
                <td>{cur}{r.actual}</td>
                <td className={Math.abs(r.error_percent) <= 1 ? "up" : "down"}>
                  {r.error_percent > 0 ? "+" : ""}{r.error_percent}%
                </td>
                <td className={r.direction_correct ? "up" : "down"}>
                  {r.direction_correct ? "ถูก" : "ผิด"}
                </td>
                {s.band_coverage != null && (
                  <td className={r.in_band ? "" : "down"}>
                    {r.band_low != null ? `${r.band_low} – ${r.band_high}` : "—"}
                    {r.in_band === false && " ✕"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [predictHistory, setPredictHistory] = useState(null);
  const [predictHistoryLoading, setPredictHistoryLoading] = useState(false);
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

  // ===== ประวัติการทำนายย้อนหลัง =====
  // ผูกกับหุ้นที่กำลังดูและโมเดลที่เลือก ฝั่ง backend cache ไว้ 1 ชม. อยู่แล้ว
  useEffect(() => {
    let cancelled = false;
    const target = stock?.symbol;
    if (!target) {
      setPredictHistory(null);
      return;
    }
    setPredictHistoryLoading(true);
    getPredictHistory(target, modelName)
      .then((res) => { if (!cancelled) setPredictHistory(res.data); })
      .catch(() => { if (!cancelled) setPredictHistory(null); })
      .finally(() => { if (!cancelled) setPredictHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [stock?.symbol, modelName]);

  // ===== ข่าวของหุ้นใน watchlist =====

  const fetchNews = async () => {
    setNewsLoading(true);
    try {
      const res = await getWatchlistNews();
      setNews(res.data.items || []);
    } catch {
      setNews([]);
    } finally {
      setNewsLoading(false);
    }
  };

  // ดึงใหม่เมื่อ watchlist เปลี่ยนจำนวน เพราะข่าวผูกกับรายการหุ้นโดยตรง
  useEffect(() => {
    if (!isLoggedIn()) return;
    if (watchlist.length === 0) {
      setNews([]);
      return;
    }
    fetchNews();
    const t = setInterval(fetchNews, NEWS_REFRESH_MS);
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
              <div className="model-picker">
                <label className="model-label" htmlFor="model-select">
                  เลือก Model ที่ใช้ในการคาดคะเน
                </label>
                <select
                  id="model-select"
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
            </div>

            <div className="predict-value">{symbolOf(prediction.currency)}{prediction.predicted_close_tomorrow}</div>
            <div className={`predict-diff ${prediction.diff_percent >= 0 ? "up" : "down"}`}>
              {prediction.diff_percent >= 0 ? "▲" : "▼"} {Math.abs(prediction.diff_percent)}%
            </div>

            {/* ช่วงที่ราคาน่าจะตกอยู่ กว้างแค่ไหนขึ้นกับว่าโมเดลเคยพลาดมากน้อยแค่ไหน */}
            {prediction.band?.["80"] && (
              <div className="band">
                <div className="band-head">
                  <span>ช่วงที่น่าจะอยู่ (80%)</span>
                  <span className="band-basis">จาก {prediction.band_basis_days} วันหลังสุด</span>
                </div>
                <div className="band-range">
                  {symbolOf(prediction.currency)}{prediction.band["80"].low}
                  {" – "}
                  {symbolOf(prediction.currency)}{prediction.band["80"].high}
                </div>
                {prediction.band["90"] && (
                  <div className="band-wide">
                    ถ้าเอา 90%: {symbolOf(prediction.currency)}{prediction.band["90"].low}
                    {" – "}
                    {symbolOf(prediction.currency)}{prediction.band["90"].high}
                  </div>
                )}
              </div>
            )}

            {/* ย้อนทำนายวันที่รู้คำตอบแล้ว เพื่อดูว่าโมเดลแม่นแค่ไหน */}
            {prediction.predicted_close_today != null && (
              <div className="backtest">
                <div className="backtest-head">
                  <span>ผลการคาดคะเนราคาของวันที่ ({prediction.last_close_date})</span>
                  <span
                    className={`backtest-dir ${prediction.today_direction_correct ? "ok" : "miss"}`}
                  >
                    {prediction.today_direction_correct ? "✓ ทิศทางถูก" : "✕ ทิศทางผิด"}
                  </span>
                </div>

                <div className="backtest-row">
                  <div>
                    <div className="backtest-label">ราคาที่คาดคะเน</div>
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

      <PredictHistory
        data={predictHistory}
        loading={predictHistoryLoading}
        currencyOf={symbolOf}
        darkMode={darkMode}
      />

      {isLoggedIn() && (
        <NewsBoard
          items={news}
          loading={newsLoading}
          hasWatchlist={watchlist.length > 0}
        />
      )}

      <footer className="foot">เพื่อการศึกษาเท่านั้น ไม่ใช่คำแนะนำการลงทุน</footer>
    </div>

  );
}
