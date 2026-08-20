import axios from "axios";

// ตอน build บน Cloudflare Pages ให้ตั้ง VITE_API_URL เป็นโดเมนของ backend
// ถ้าไม่ได้ตั้ง จะชี้ไปที่ backend บนเครื่องตัวเองสำหรับตอนพัฒนา
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const api = axios.create({ baseURL: API_URL });

// แนบ token อัตโนมัติทุก request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ===== Auth =====
export const login = (username, password) =>
  api.post("/login", { username, password });

export const logout = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
};

export const isLoggedIn = () => !!localStorage.getItem("token");
export const getUsername = () => localStorage.getItem("username");

// ===== Watchlist =====
export const getWatchlist = () => api.get("/watchlist");
export const addWatchlist = (symbol) => api.post("/watchlist", { symbol });
export const removeWatchlist = (symbol) => api.delete(`/watchlist/${symbol}`);

// ===== Alert =====
// เฝ้าระวังการทุ่มตลาดเฉพาะหุ้นใน watchlist ของผู้ใช้
export const getWatchlistAlerts = () => api.get("/alert/watchlist");

// ===== News =====
// ข่าวภายใน 1 สัปดาห์ เฉพาะหุ้นใน watchlist ของผู้ใช้
export const getWatchlistNews = () => api.get("/news/watchlist");

// ประวัติการทำนายย้อนหลัง 1 เดือน พร้อมสรุปว่าที่ผ่านมาแม่นแค่ไหน
export const getPredictHistory = (symbol, modelName) =>
  api.get(`/predict/history/${symbol}`, { params: { model_name: modelName } });

export default api;