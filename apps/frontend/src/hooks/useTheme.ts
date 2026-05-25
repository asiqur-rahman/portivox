import { useEffect, useState } from "react";
import type { Theme } from "../app/types";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("ptx-theme") as Theme | null) ?? "light",
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ptx-theme", theme);
  }, [theme]);

  return { theme, setTheme };
}
