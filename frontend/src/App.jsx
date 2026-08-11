import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/dashboard";
import Login from "./pages/login";
import "./App.css";

export default function App() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard darkMode={darkMode} setDarkMode={setDarkMode} />} />
        <Route path="/login" element={<Login darkMode={darkMode} />} />
      </Routes>
    </BrowserRouter>
  );
}