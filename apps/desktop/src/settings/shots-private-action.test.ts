import { describe, expect, it } from "vitest";

import {
  createPrivateActionIdentity,
  sealAutoFormatRequest,
  openAutoFormatRequest,
} from "./shots-private-action";

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
