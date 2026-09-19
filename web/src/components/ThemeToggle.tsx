import { useTheme } from "../hooks/useTheme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre";
  return (
    <button className="theme-toggle" onClick={toggle} title={label} aria-label={label}>
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
