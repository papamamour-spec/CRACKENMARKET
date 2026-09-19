import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";

describe("compte administrateur (ADMIN_EMAIL / ADMIN_PASSWORD)", () => {
  it("ne crée rien quand les variables manquent", () => {
    const auth = new AuthService(openMemoryDb());
    expect(auth.ensureAdmin(undefined, undefined)).toBeUndefined();
    expect(auth.ensureAdmin("admin@example.com", undefined)).toBeUndefined();
    expect(() => auth.login("admin@example.com", "x")).toThrow();
  });

  it("refuse un mot de passe trop court", () => {
    const auth = new AuthService(openMemoryDb());
    expect(auth.ensureAdmin("admin@example.com", "court")).toBeUndefined();
    expect(() => auth.login("admin@example.com", "court")).toThrow();
  });

  it("crée le compte avec le rôle admin et permet la connexion", () => {
    const auth = new AuthService(openMemoryDb());
    const created = auth.ensureAdmin("Admin@Example.com", "motdepasse-solide");
    expect(created?.role).toBe("admin");
    expect(created?.email).toBe("admin@example.com");
    const user = auth.login("admin@example.com", "motdepasse-solide");
    expect(user.role).toBe("admin");
    // Un second démarrage ne crée pas de doublon
    expect(auth.ensureAdmin("admin@example.com", "motdepasse-solide")?.id).toBe(created?.id);
  });

  it("promeut un compte existant et aligne son mot de passe sur la variable", () => {
    const auth = new AuthService(openMemoryDb());
    const investor = auth.register("ghost@example.com", "ancien-mdp", "Ghost");
    expect(investor.role).toBe("investor");
    const admin = auth.ensureAdmin("ghost@example.com", "nouveau-mdp-admin");
    expect(admin?.id).toBe(investor.id);
    expect(admin?.role).toBe("admin");
    expect(auth.login("ghost@example.com", "nouveau-mdp-admin").role).toBe("admin");
    expect(() => auth.login("ghost@example.com", "ancien-mdp")).toThrow();
  });
});
