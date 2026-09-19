import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, post, setToken, getToken } from "../lib/api";
import type { DeclaredProfile, User } from "../lib/types";

interface AuthCtx {
  user: User | null;
  profile: DeclaredProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName: string, role: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<DeclaredProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<{ user: User; profile: DeclaredProfile }>("/auth/me");
      setUser(me.user);
      setProfile(me.profile);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const r = await post<{ user: User; token: string }>("/auth/login", { email, password });
    setToken(r.token);
    await refresh();
  };
  const register = async (email: string, password: string, fullName: string, role: string) => {
    const r = await post<{ user: User; token: string }>("/auth/register", { email, password, fullName, role });
    setToken(r.token);
    await refresh();
  };
  const logout = () => {
    setToken(null);
    setUser(null);
    setProfile(null);
  };

  return <Ctx.Provider value={{ user, profile, loading, login, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AuthProvider manquant");
  return c;
}
