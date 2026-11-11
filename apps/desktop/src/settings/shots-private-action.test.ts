import { describe, expect, it } from "vitest";

import {
  createPrivateActionIdentity,
  aiProviderModelIdSchema,
  aiProviderRequestSchema,
  aiProviderResultSchema,
  sealAutoFormatRequest,
  openAutoFormatRequest,
} from "./shots-private-action";

describe("private AI provider actions", () => {
  it("accepts bounded model discovery results for LLM providers only", () => {
    expect(aiProviderModelIdSchema.safeParse("m".repeat(128)).success).toBe(
      true,
    );
    expect(
      aiProviderModelIdSchema.safeParse("\u0000".repeat(128)).success,
    ).toBe(false);
    expect(
      aiProviderRequestSchema.parse({
        operation: "discover",
        type: "llm",
        providerId: "openai",
      }),
    ).toEqual({ operation: "discover", type: "llm", providerId: "openai" });
    expect(
      aiProviderRequestSchema.safeParse({
        operation: "discover",
        type: "stt",
        providerId: "openai",
      }).success,
    ).toBe(false);
    expect(
      aiProviderResultSchema.parse({
        configured: true,
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-5.6"],
      }).models,
    ).toEqual(["gpt-5.6"]);
    expect(
      aiProviderResultSchema.safeParse({
        configured: true,
        baseUrl: "",
        models: ["m".repeat(129)],
      }).success,
    ).toBe(false);
  });
});

describe("private summary format requests", () => {
  it("only lets the selected desktop read examples and the requesting browser read the result", async () => {
    const desktop = await createPrivateActionIdentity();
    const stranger = await createPrivateActionIdentity();
    const request = await sealAutoFormatRequest(desktop.publicKey, [
      "Private example with a customer name",
    ]);
    expect(request.argument).not.toContain("customer");
    await expect(
      openAutoFormatRequest(stranger.privateKey, request.argument),
    ).rejects.toThrow();
    const opened = await openAutoFormatRequest(
      desktop.privateKey,
      request.argument,
    );
    expect(opened.examples).toEqual(["Private example with a customer name"]);
    const reply = await opened.sealResult("- Use concise bullet points.");
    expect(reply).not.toContain("bullet");
    expect(await request.readResult(reply)).toBe(
      "- Use concise bullet points.",
    );
    await expect(request.readResult(request.argument)).rejects.toThrow();
    const another = await sealAutoFormatRequest(desktop.publicKey, [
      "Another example",
    ]);
    await expect(another.readResult(reply)).rejects.toThrow();
    await expect(
      sealAutoFormatRequest(desktop.publicKey, ["x".repeat(12001)]),
    ).rejects.toThrow();
    const tampered = JSON.parse(request.argument);
    tampered.ciphertext =
      (tampered.ciphertext[0] === "A" ? "B" : "A") +
      tampered.ciphertext.slice(1);
    await expect(
      openAutoFormatRequest(desktop.privateKey, JSON.stringify(tampered)),
    ).rejects.toThrow();
  });
});
