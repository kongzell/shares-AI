import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  BarChart, Bar, Cell, ComposedChart, Area, Line, ReferenceLine,
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

// คาบของเส้น EMA ที่วาดทับกราฟ (คู่มาตรฐานเดียวกับที่ MACD ใช้)
const EMA_PERIODS = [12, 26];
// แยกสีตามธีม เพราะสีเดียวจะตัดกับพื้นได้ดีแค่ธีมเดียว
// วัดแล้ว: ส้มสดบนพื้นขาวได้ 2.35 ส่วนม่วงเข้มบนพื้นมืดได้ 3.25 ทั้งคู่บางเกินไป
const EMA_COLORS = {
  light: { 12: "#DC6803", 26: "#7A5AF8" },
  dark:  { 12: "#F79009", 26: "#B692F6" },
};
const emaColor = (period, darkMode) => EMA_COLORS[darkMode ? "dark" : "light"][period];

/**
 * เส้นค่าเฉลี่ยเคลื่อนที่แบบถ่วงน้ำหนัก
 * ค่าแรกใช้ค่าเฉลี่ยธรรมดาของ period แรกเป็นตัวตั้งต้นตามวิธีมาตรฐาน
 * แท่งก่อนหน้านั้นคืน null เพราะยังไม่มีข้อมูลพอ (recharts จะเว้นช่วงให้เอง)
 */
const emaSeries = (values, period) => {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === undefined) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
};

// ค่ามาตรฐานของ RSI — 14 คาบ เส้นเตือนที่ 70 (ซื้อมากเกิน) และ 30 (ขายมากเกิน)
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
// น้ำเงินหลักของแอปตัดกับพื้นมืดได้แค่ 3.04 บางเกินไปสำหรับเส้น จึงใช้เฉดอ่อนกว่าในโหมดมืด
const RSI_LINE = { light: "#465fff", dark: "#8ba0ff" };

/**
 * RSI ตามสูตรของ Wilder
 * ค่าตั้งต้นใช้ค่าเฉลี่ยธรรมดาของ 14 คาบแรก จากนั้นถัวเฉลี่ยแบบ Wilder (หาร period ไม่ใช่ period+1)
 *
 * ใช้ราคาปิด "จริง" เท่านั้น ห้ามใช้ราคาที่ถูกเลื่อนปิดช่องว่าง
 * เพราะ RSI คิดจากผลต่างระหว่างแท่ง การเลื่อนจะไปลบผลต่างตรงรอยต่อรอบซื้อขายทิ้ง
 */
const rsiSeries = (closes, period = RSI_PERIOD) => {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const toRsi = (gain, loss) =>
    loss === 0 ? 100 : Math.round((100 - 100 / (1 + gain / loss)) * 100) / 100;

  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
};

// มุมมองเต็มจอรายเดือน
const EXPAND_MONTHS = 12;        // จำนวนเดือนย้อนหลังในแถบเลือก
const EXPAND_PX_PER_BAR = 13;    // ความกว้างต่อแท่ง ใช้กำหนดว่าต้องเลื่อนไกลแค่ไหน
const EXPAND_Y_AXIS_W = 62;      // ต้องตรงกับ width ของ YAxis ไม่งั้นแถบวันจะเหลื่อม
const EXPAND_RIGHT_PAD = 12;     // ต้องตรงกับ margin.right ของกราฟ
const EXPAND_TIP_W = 150;        // ล็อกความกว้าง tooltip ไว้ จะได้คำนวณการพลิกด้านได้
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                     "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** รายการเดือนย้อนหลัง ใหม่สุดอยู่ท้าย เพื่อให้เลื่อนไปขวาสุด = เดือนปัจจุบัน */
const buildMonths = (count = EXPAND_MONTHS) => {
  const now = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    // เดือนถัดไปวันที่ 1 = ขอบบนของช่วง (yfinance ไม่รวมวัน end)
    const next = new Date(y, m + 1, 1);
    out.push({
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      label: `${THAI_MONTHS[m]} ${y}`,
      start: `${y}-${String(m + 1).padStart(2, "0")}-01`,
      end: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
    });
  }
  return out;
};

/**
 * ค่าที่ต้องเลื่อนแท่งแต่ละอันเพื่อปิดช่องว่างระหว่างรอบซื้อขาย
 * แยกออกมาเพราะทั้งกราฟหลักและกราฟเต็มจอต้องใช้สูตรเดียวกัน
 * ยึดแท่งสุดท้ายเป็นหลัก (shift = 0) ราคาล่าสุดบนกราฟจึงเป็นราคาจริงเสมอ
 */
const gapShifts = (history) => {
  const offsets = [0];
  for (let i = 1; i < history.length; i++) {
    offsets[i] = offsets[i - 1] + history[i - 1].close - history[i].open;
  }
  const base = offsets[offsets.length - 1];
  return offsets.map((o) => o - base);
};

/** แปลงข้อมูลดิบเป็นแท่งเทียนที่เลื่อนปิดช่องว่างแล้ว */
const toCandles = (history) => {
  const shifts = gapShifts(history);
  return history.map((d, i) => {
    const shift = shifts[i];
    const adj = (v) => Math.round((v + shift) * 100) / 100;
    return {
      ...d,
      open: adj(d.open), high: adj(d.high), low: adj(d.low), close: adj(d.close),
      realOpen: d.open, realHigh: d.high, realLow: d.low, realClose: d.close,
      shift: Math.round(shift * 100) / 100,
    };
  });
};

/** RSI อยู่โซนไหน ใช้เลือกสีป้ายกำกับ */
const rsiZone = (value) => {
  if (value >= RSI_OVERBOUGHT) return "hot";
  if (value <= RSI_OVERSOLD) return "cold";
  return "";
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
 * กราฟเต็มจอ เลือกดูทีละเดือน
 *
 * ดึงแท่งรายชั่วโมงของเดือนนั้น (~130-160 แท่ง) แล้ววางบนผืนกว้างกว่าจอ
 * ผู้ใช้จึงเลื่อนไล่ดูภายในเดือนได้จริง ถ้าเดือนเก่าเกินกว่าที่ yfinance
 * เก็บแท่งรายชั่วโมงไว้ backend จะถอยไปส่งแท่งรายวันมาแทน
 */
const ExpandedChart = ({ symbol, currency, darkMode, onClose }) => {
  const months = useMemo(() => buildMonths(), []);
  const [month, setMonth] = useState(months[months.length - 1].key);
  const [rows, setRows] = useState([]);
  const [interval, setIntervalUsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);
  const monthBarRef = useRef(null);
  const stripRef = useRef(null);

  // ปิดด้วย Esc และล็อกไม่ให้หน้าข้างหลังเลื่อนตาม
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // เลื่อนแถบเดือนไปสุดขวา = เดือนล่าสุด ให้เห็นตั้งแต่เปิด
  useEffect(() => {
    if (monthBarRef.current) monthBarRef.current.scrollLeft = monthBarRef.current.scrollWidth;
  }, []);

  useEffect(() => {
    const cfg = months.find((m) => m.key === month);
    if (!cfg || !symbol) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    axios
      .get(`${API_URL}/stock/${symbol}/history`, {
        params: { start: cfg.start, end: cfg.end, interval: "1h" },
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.history || []);
        setIntervalUsed(res.data.interval);
      })
      .catch(() => {
        if (!cancelled) { setRows([]); setError("ไม่มีข้อมูลของเดือนนี้"); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, month, months]);

  // ข้อมูลเดือนใหม่ควรเริ่มดูจากต้นเดือน
  const [scrollable, setScrollable] = useState(false);
  const [stripW, setStripW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = 0;
    const check = () => {
      setScrollable(el.scrollWidth > el.clientWidth + 1);
      // ใช้ความกว้างจริงของแถบ เพื่อตัดสินว่าช่องไหนแคบเกินกว่าจะใส่ป้ายวัน
      if (stripRef.current) setStripW(stripRef.current.clientWidth);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [rows]);

  const candles = useMemo(() => (rows.length ? toCandles(rows) : []), [rows]);
  const cur = currency === "THB" ? "฿" : "$";
  const width = Math.max(candles.length * EXPAND_PX_PER_BAR, 600);

  /**
   * จัดกลุ่มแท่งเป็น "รอบซื้อขาย" เพื่อทำแถบบอกวันด้านบน
   *
   * ห้ามจัดกลุ่มด้วยวันที่ตามปฏิทิน เพราะ backend แปลงเป็นเวลาไทยแล้ว
   * รอบเดียวของตลาดสหรัฐจะคาบเกี่ยวสองวัน (1 ก.ค. 20:30 → 2 ก.ค. 02:30)
   * จึงดูจากช่องว่างระหว่างแท่งแทน ถ้าห่างผิดปกติแปลว่าขึ้นรอบใหม่
   */
  const sessions = useMemo(() => {
    if (!candles.length) return [];
    if (interval === "1d") {
      return candles.map((c, i) => ({ start: i, count: 1, date: c.datetime.slice(0, 10) }));
    }
    const times = candles.map((c) => new Date(c.datetime.replace(" ", "T")).getTime());
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    const sorted = [...diffs].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)] || 3600000;

    const out = [{ start: 0, count: 1, date: candles[0].datetime.slice(0, 10) }];
    for (let i = 1; i < candles.length; i++) {
      if (times[i] - times[i - 1] > typical * 1.8) {
        out.push({ start: i, count: 1, date: candles[i].datetime.slice(0, 10) });
      } else {
        out[out.length - 1].count++;
      }
    }
    return out;
  }, [candles, interval]);

  const shortDate = (iso) => {
    const [, m, d] = iso.split("-");
    return `${Number(d)} ${THAI_MONTHS[Number(m) - 1]}`;
  };

  // เรียงเป็นบรรทัด ไม่ใช่บรรทัดเดียวยาว ๆ ไม่งั้นกล่องกว้างเกือบ 400px จนล้นกรอบที่มองเห็น
  const ExpandTooltip = ({ active, payload, coordinate }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const up = d.realClose >= d.realOpen;

    // recharts วางกล่องทางขวาของเคอร์เซอร์เสมอ โดยอิงผืนกราฟทั้งผืน
    // ชี้แท่งท้าย ๆ หรือชิดขอบขวาของช่องที่มองเห็น กล่องจึงยื่นออกไปจนโดนตัด
    // ถ้าจะล้นก็พลิกไปอยู่ทางซ้ายของเคอร์เซอร์แทน
    const el = scrollRef.current;
    const limit = el
      ? Math.min(el.scrollWidth, el.scrollLeft + el.clientWidth)
      : Infinity;
    const flip = coordinate ? coordinate.x + EXPAND_TIP_W + 20 > limit : false;

    const style = {
      borderRadius: 10,
      border: `1px solid ${darkMode ? "#344054" : "#eaecf0"}`,
      background: darkMode ? "#1d2939" : "#fff",
      fontSize: 12,
      padding: "8px 10px",
      width: EXPAND_TIP_W,
      transform: flip ? `translateX(-${EXPAND_TIP_W + 24}px)` : "none",
    };
    return (
      <div className="candle-tip" style={style}>
        <div className="candle-tip-date">{d.datetime}</div>
        <div className="candle-tip-row"><span>เปิด</span><b>{cur}{d.realOpen}</b></div>
        <div className="candle-tip-row"><span>สูงสุด</span><b>{cur}{d.realHigh}</b></div>
        <div className="candle-tip-row"><span>ต่ำสุด</span><b>{cur}{d.realLow}</b></div>
        <div className="candle-tip-row">
          <span>ปิด</span><b style={{ color: up ? UP : DOWN }}>{cur}{d.realClose}</b>
        </div>
      </div>
    );
  };

  return (
    <div className="expand-backdrop" onClick={onClose}>
      <div className="expand-panel" onClick={(e) => e.stopPropagation()}>
        <div className="expand-head">
          <div>
            <h2>{symbol}</h2>
            <span className="muted small">
              {loading
                ? "กำลังโหลด..."
                : candles.length
                ? `${candles.length} แท่ง · ${interval === "1d" ? "รายวัน" : "รายชั่วโมง"}`
                : error || "ไม่มีข้อมูล"}
            </span>
          </div>
          <button className="expand-close" onClick={onClose} aria-label="ปิด">✕</button>
        </div>

        <div className="month-bar" ref={monthBarRef}>
          {months.map((m) => (
            <button
              key={m.key}
              className={`month-btn ${m.key === month ? "active" : ""}`}
              onClick={() => setMonth(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {interval === "1d" && candles.length > 0 && (
          <p className="expand-note">
            เดือนนี้เก่าเกินกว่าที่แหล่งข้อมูลเก็บแท่งรายชั่วโมงไว้ จึงแสดงเป็นแท่งรายวันแทน
          </p>
        )}

        <div className="expand-scroll" ref={scrollRef}>
          {candles.length === 0 ? (
            <p className="muted small" style={{ padding: 24 }}>
              {loading ? "กำลังโหลด..." : error || "ไม่มีข้อมูลของเดือนนี้"}
            </p>
          ) : (
            // ผืนกว้างกว่าจอ ทำให้ตัวครอบด้านนอกเลื่อนได้จริง
            <div style={{ width, minWidth: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
              {/* แถบบอกวัน 1 ช่อง = 1 รอบซื้อขาย กว้างตามสัดส่วนจำนวนแท่งในรอบนั้น */}
              {/* แบ่งด้วยสัดส่วน flex ไม่ใช่พิกเซลที่คำนวณเอง เพราะความกว้างจริง
                  อาจกว้างกว่า candles×PX_PER_BAR เมื่อ minWidth:100% ดันให้เต็มกรอบ */}
              <div
                className="day-strip"
                ref={stripRef}
                style={{ marginLeft: EXPAND_Y_AXIS_W, marginRight: EXPAND_RIGHT_PAD }}
              >
                {sessions.map((s) => {
                  const px = stripW ? (s.count / candles.length) * stripW : 0;
                  return (
                    <div key={s.start} className="day-cell" style={{ flex: `${s.count} 0 0` }}>
                      {/* ช่องแคบเกินไปก็ไม่ต้องใส่ตัวหนังสือ ไม่งั้นทับกันอ่านไม่ออก */}
                      {px >= 44 ? shortDate(s.date) : ""}
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={candles} margin={{ top: 8, right: EXPAND_RIGHT_PAD, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke={darkMode ? "#2a3547" : "#f0f1f5"} vertical={false} />
                  <XAxis dataKey="datetime" hide />
                  <YAxis domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: "#98a2b3" }} tickLine={false} axisLine={false} width={EXPAND_Y_AXIS_W} />
                  <Tooltip
                    content={<ExpandTooltip />}
                    cursor={{ fill: darkMode ? "#ffffff10" : "#00000008" }}
                  />
                  <Bar dataKey={(d) => [d.low, d.high]} shape={<Candle />} maxBarSize={11} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
        {/* บอกให้เลื่อนเฉพาะตอนที่ผืนกว้างเกินกรอบจริง ไม่งั้นเป็นคำแนะนำที่ทำตามไม่ได้ */}
        <p className="expand-hint">
          {scrollable
            ? "เลื่อนกราฟไปทางซ้าย-ขวาเพื่อดูทั้งเดือน · กด Esc เพื่อปิด"
            : "กด Esc เพื่อปิด"}
        </p>
      </div>
    </div>
  );
};

/**
 * ประวัติการทำนายย้อนหลัง 1 เดือน — กราฟเทียบทำนายกับราคาจริง แล้วต่อด้วยตาราง
 * ตัวเลขสรุปบนหัวบอกว่าที่ผ่านมาโมเดลกับแถบพยากรณ์เชื่อได้แค่ไหนสำหรับหุ้นตัวนี้
 */
const PredictHistory = ({ data, loading, currencyOf, darkMode }) => {
  const [open, setOpen] = useState(true);
  const chartData = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.map((r) => ({
      date: r.date.slice(5),
      band: r.band_low != null ? [r.band_low, r.band_high] : null,
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
          <div className="history-title">
            <h2>ประวัติย้อนหลัง 1 เดือน</h2>
            <button
              className="collapse-btn"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? "▾ ซ่อน" : "▸ แสดง"}
            </button>
          </div>
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

      {/* ปิดแล้วเหลือแค่หัวข้อกับตัวเลขสรุป ซึ่งเป็นส่วนที่มีค่าที่สุดอยู่แล้ว */}
      {!open ? null : (
      <>
      <div className="history-legend">
        <span className="hl band">ช่วงที่ทำนาย {s.band_level}%</span>
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
            formatter={(value) => {
              if (Array.isArray(value)) return [`${cur}${value[0]} – ${cur}${value[1]}`, `ช่วงที่ทำนาย ${s.band_level}%`];
              return [`${cur}${value}`, "ราคาจริง"];
            }}
          />
          <Area dataKey="band" stroke="none" fill="#465fff" fillOpacity={0.18} connectNulls />
          <Line dataKey="actual" stroke={darkMode ? "#f2f4f7" : "#101828"} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="history-table-wrap">
        <table className="history-table">
          <thead>
            {/* ไม่มีคอลัมน์ทิศทาง เพราะ 36% ของแถวจะขึ้น "อยู่ในช่วง" คู่กับ "ผิด"
                ซึ่งอ่านแล้วขัดกันเอง ตัวเลขรวมดูได้ที่แถบสรุปด้านบนแทน */}
            <tr>
              <th>วันที่</th><th>ช่วงที่ทำนาย ({s.band_level}%)</th><th>ราคาจริง</th>
              {s.band_coverage != null && <th>ผล</th>}
            </tr>
          </thead>
          <tbody>
            {[...data.rows].reverse().map((r) => (
              <tr key={r.date}>
                <td>{r.date}</td>
                <td>
                  {r.band_low != null
                    ? `${cur}${r.band_low} – ${cur}${r.band_high}`
                    : "—"}
                </td>
                <td>{cur}{r.actual}</td>
                {s.band_coverage != null && (
                  <td className={r.in_band ? "up" : "down"}>
                    {r.in_band ? "อยู่ในช่วง" : "หลุดช่วง"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
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
  const [showEma, setShowEma] = useState(true);
  const [expanded, setExpanded] = useState(false);
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

    // คำนวณ EMA จากราคาปิด "จริง" แล้วค่อยเลื่อนเท่ากับแท่งของวันนั้น
    // ถ้าคำนวณจากราคาที่เลื่อนแล้ว ตัวเลขใน tooltip จะไม่ใช่ราคาจริงอีกต่อไป
    const closes = history.map((d) => d.close);
    const emas = Object.fromEntries(
      EMA_PERIODS.map((p) => [p, emaSeries(closes, p)])
    );
    const rsi = rsiSeries(closes);

    return toCandles(history).map((row, i) => {
      const adj = (v) => Math.round((v + row.shift) * 100) / 100;
      for (const p of EMA_PERIODS) {
        const v = emas[p][i];
        row[`ema${p}`] = v == null ? null : adj(v);
        row[`realEma${p}`] = v == null ? null : Math.round(v * 100) / 100;
      }
      row.rsi = rsi[i];
      return row;
    });
  }, [history]);

  // ค่า RSI ล่าสุดที่คำนวณได้ ใช้โชว์ตัวเลขกำกับหัวกราฟ
  const latestRsi = useMemo(() => {
    for (let i = chartData.length - 1; i >= 0; i--) {
      if (chartData[i].rsi != null) return chartData[i].rsi;
    }
    return null;
  }, [chartData]);

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
        {showEma && EMA_PERIODS.some((p) => d[`realEma${p}`] != null) && (
          <>
            <div className="candle-tip-sep" />
            {EMA_PERIODS.map((p) =>
              d[`realEma${p}`] == null ? null : (
                <div className="candle-tip-row" key={p}>
                  <span>EMA {p}</span>
                  <b style={{ color: emaColor(p, darkMode) }}>{cur}{d[`realEma${p}`]}</b>
                </div>
              )
            )}
          </>
        )}
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

                <button
                  className={`ema-toggle ${showEma ? "on" : ""}`}
                  onClick={() => setShowEma((v) => !v)}
                  aria-pressed={showEma}
                  title="เส้นค่าเฉลี่ยเคลื่อนที่แบบถ่วงน้ำหนัก"
                >
                  {EMA_PERIODS.map((p) => (
                    <span key={p} className="ema-swatch" style={{ background: emaColor(p, darkMode) }} />
                  ))}
                  EMA {EMA_PERIODS.join(" / ")}
                </button>

                <div className="price-now">
                  <div className="big">{symbolOf(stock.currency)}{stock.latest_price}</div>
                  <div className={stock.change >= 0 ? "up" : "down"}>
                    {stock.change >= 0 ? "▲" : "▼"} {stock.change} ({stock.change_percent}%)
                  </div>
                </div>
              </div>
            </div>
            {/* กดที่กราฟเพื่อเปิดมุมมองเต็มจอรายเดือน */}
            <div
              className="chart-clickable"
              onClick={() => setExpanded(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded(true); }}
              title="กดเพื่อขยายเต็มจอ"
            >
              <span className="expand-hint-badge">⤢ กดเพื่อขยาย</span>
            <ResponsiveContainer width="100%" height={380}>
              {/* ComposedChart ไม่ใช่ BarChart เพราะต้องวางเส้น EMA ทับแท่งเทียน */}
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                {showEma && EMA_PERIODS.map((p) => (
                  <Line
                    key={p}
                    dataKey={`ema${p}`}
                    stroke={emaColor(p, darkMode)}
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
            </div>
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

            {/* ===== กราฟ RSI ===== */}
            <div className="rsi-head">
              <span className="volume-label">RSI ({RSI_PERIOD})</span>
              {latestRsi != null && (
                <span className={`rsi-now ${rsiZone(latestRsi)}`}>
                  {latestRsi}
                  <span className="rsi-zone-text">
                    {latestRsi >= RSI_OVERBOUGHT
                      ? "ซื้อมากเกินไป"
                      : latestRsi <= RSI_OVERSOLD
                      ? "ขายมากเกินไป"
                      : "ปกติ"}
                  </span>
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={130}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis dataKey="datetime" hide />
                {/* ล็อกแกนไว้ 0-100 เสมอ ไม่ให้ recharts ปรับสเกลตามข้อมูล
                    เพราะระดับ 70/30 จะเลื่อนตำแหน่งจนอ่านผิด */}
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, RSI_OVERSOLD, 50, RSI_OVERBOUGHT, 100]}
                  tick={{ fontSize: 10, fill: "#98a2b3" }}
                  tickLine={false}
                  axisLine={false}
                  width={55}
                />
                <Tooltip
                  formatter={(v) => [v, `RSI ${RSI_PERIOD}`]}
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: darkMode ? "#f2f4f7" : "#101828", fontWeight: 500 }}
                  itemStyle={{ color: "#465fff" }}
                  cursor={{ stroke: darkMode ? "#475467" : "#d0d5dd" }}
                />
                {/* ทะลุ 70 ขึ้นไป = คนซื้อมากเกิน / ต่ำกว่า 30 = คนขายมากเกิน */}
                <ReferenceLine y={RSI_OVERBOUGHT} stroke={DOWN} strokeDasharray="5 4" strokeWidth={1} />
                <ReferenceLine y={RSI_OVERSOLD} stroke={UP} strokeDasharray="5 4" strokeWidth={1} />
                <Line
                  dataKey="rsi"
                  stroke={RSI_LINE[darkMode ? "dark" : "light"]}
                  strokeWidth={1.6}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </ComposedChart>
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

            {/* แสดงเป็นช่วงอย่างเดียว ความกว้างขึ้นกับว่าโมเดลเคยพลาดมากน้อยแค่ไหน
                ส่วนลูกศรบอกทิศทางที่โมเดลคาดไว้เทียบกับราคาปิดล่าสุด */}
            {prediction.band?.["80"] ? (
              <>
                <div className="predict-value">
                  {symbolOf(prediction.currency)}{prediction.band["80"].low}
                  {" – "}
                  {symbolOf(prediction.currency)}{prediction.band["80"].high}
                </div>
                <div className={`predict-diff ${prediction.diff_percent >= 0 ? "up" : "down"}`}>
                  {prediction.diff_percent >= 0 ? "▲" : "▼"} {Math.abs(prediction.diff_percent)}%
                  <span className="predict-note">ช่วง 80% · จาก {prediction.band_basis_days} วันหลังสุด</span>
                </div>
              </>
            ) : (
              /* ข้อมูลน้อยเกินกว่าจะสร้างช่วงได้ เหลือบอกได้แค่ทิศทาง */
              <div className={`predict-diff ${prediction.diff_percent >= 0 ? "up" : "down"}`}>
                {prediction.diff_percent >= 0 ? "▲" : "▼"} {Math.abs(prediction.diff_percent)}%
                <span className="predict-note">ข้อมูลไม่พอสร้างช่วง</span>
              </div>
            )}

            {/* ย้อนทำนายวันที่รู้คำตอบแล้ว เพื่อดูว่าโมเดลแม่นแค่ไหน */}
            {prediction.predicted_close_today != null && (
              <div className="backtest">
                <div className="backtest-head">
                  <span>ผลการคาดคะเนราคาของวันที่ ({prediction.last_close_date})</span>
                  {prediction.today_in_band != null && (
                    <span
                      className={`backtest-dir ${prediction.today_in_band ? "ok" : "miss"}`}
                    >
                      {prediction.today_in_band ? "✓ อยู่ในช่วง" : "✕ หลุดช่วง"}
                    </span>
                  )}
                </div>

                <div className="backtest-row">
                  <div>
                    <div className="backtest-label">ช่วงที่คาดคะเน (80%)</div>
                    <div className="backtest-num">
                      {prediction.band_today?.["80"]
                        ? `${symbolOf(prediction.currency)}${prediction.band_today["80"].low} – ${symbolOf(prediction.currency)}${prediction.band_today["80"].high}`
                        : "—"}
                    </div>
                  </div>
                  <div className="backtest-arrow">→</div>
                  <div>
                    <div className="backtest-label">ราคาจริง</div>
                    <div className="backtest-num actual">
                      {symbolOf(prediction.currency)}{prediction.actual_close_today}
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

      {expanded && stock && (
        <ExpandedChart
          symbol={stock.symbol}
          currency={stock.currency}
          darkMode={darkMode}
          onClose={() => setExpanded(false)}
        />
      )}

      <footer className="foot">เพื่อการศึกษาเท่านั้น ไม่ใช่คำแนะนำการลงทุน</footer>
    </div>

  );
}
