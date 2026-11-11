import { describe, expect, it } from "vitest";
import { looksSecret, redactSecrets, redactUrl } from "../src/redact.js";

describe("redactSecrets", () => {
  it("scrubs bearer authorization headers", () => {
    const out = redactSecrets("curl -H 'Authorization: Bearer sk-abcDEF1234567890xyz' https://api");
    expect(out).not.toContain("sk-abcDEF1234567890xyz");
    expect(out).toMatch(/REDACTED/);
  });

  it("scrubs provider keys, GitHub and Slack tokens, AWS keys, and JWTs", () => {
    const samples = [
      "OPENAI key is sk-proj-abcdefABCDEF1234567890",
      "pushed with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "slack xoxb-1234567890-abcdefghij",
      "aws AKIA1234567890ABCDEF",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    ];
    for (const sample of samples) {
      const out = redactSecrets(sample);
      expect(looksSecret(out), `still secret: ${sample}`).toBe(false);
    }
  });

  it("scrubs key=value assignments a tool may have echoed, keeping the key name", () => {
    const out = redactSecrets('api_key = "supersecretvalue"');
    expect(out).toContain("api_key");
    expect(out).not.toContain("supersecretvalue");
  });

  it("scrubs private keys across lines", () => {
    const out = redactSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlblNza1NWRQ\n-----END OPENSSH PRIVATE KEY-----");
    expect(out).not.toContain("b3BlblNza1NWRQ");
  });

  it("leaves ordinary prose alone", () => {
    const text = "npm test → 57 passed; edited src/index.ts and fixed the widget";
    expect(redactSecrets(text)).toBe(text);
    expect(looksSecret(text)).toBe(false);
  });

  it("is idempotent", () => {
    const once = redactSecrets("token: abcdef123456");
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("redactUrl", () => {
  it("hides userinfo and query strings, which is where MCP endpoints hide keys", () => {
    const out = redactUrl("https://user:hunter2@mcp.example.com:8892/mcp/mcp?key=sk-secret123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-secret123");
    expect(out).toContain("mcp.example.com");
  });

  it("keeps a clean endpoint readable", () => {
    expect(redactUrl("http://127.0.0.1:8892/mcp/mcp")).toContain("127.0.0.1:8892/mcp/mcp");
  });

  it("scrubs rather than echoes when the value is not a URL", () => {
    expect(redactUrl("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toContain("ghp_aaaaaaaaaaaaaaaa");
  });

  it("returns empty for undefined", () => {
    expect(redactUrl(undefined)).toBe("");
  });
});
