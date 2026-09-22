import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "../src/services/totp.js";

describe("TOTP", () => {
  it("base32 aller-retour", () => {
    const buf = Buffer.from("CrackenMarket!");
    expect(base32Decode(base32Encode(buf)).toString()).toBe("CrackenMarket!");
  });
  it("vecteur de test RFC 6238 (SHA-1, 8 → 6 chiffres)", () => {
    // secret « 12345678901234567890 », T = 59 s → 94287082 ; sur 6 chiffres : 287082
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000)).toBe("287082");
  });
  it("accepte un code de la période précédente et refuse un code faux", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, "000000", now)).toBe(totpCode(secret, now) === "000000");
    expect(verifyTotp(secret, "12ab56", now)).toBe(false);
  });
});
