import { useState, useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { motion } from "framer-motion";

// Read the persisted choice; default to dark when the visitor hasn't chosen.
// Mirrors the inline pre-paint script in index.html (same 'theme' key).
const getInitialTheme = (): boolean => {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
  } catch {
    // localStorage unavailable (e.g. privacy mode) — fall back to default.
  }
  return true;
};

const ThemeToggle = () => {
  const [isDark, setIsDark] = useState<boolean>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      root.classList.remove("light");
    } else {
      root.classList.add("light");
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
      // Persistence is best-effort; ignore write failures.
    }
  }, [isDark]);

  return (
    <button
      onClick={() => setIsDark(!isDark)}
      className="relative w-10 h-10 rounded-full bg-muted flex items-center justify-center hover:bg-muted/80 transition-colors"
      aria-label="Toggle theme"
    >
      <motion.div
        initial={false}
        animate={{ rotate: isDark ? 0 : 180, scale: [1, 0.8, 1] }}
        transition={{ duration: 0.3 }}
      >
        {isDark ? <Moon className="w-4 h-4 text-foreground" /> : <Sun className="w-4 h-4 text-foreground" />}
      </motion.div>
    </button>
  );
};

export default ThemeToggle;
