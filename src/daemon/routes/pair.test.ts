import { afterEach, describe, expect, it } from "vitest";
import type { DaemonHandle } from "../server.js";
import { baseUrl, pairDual, postJson, startDual } from "../e2e-kit.js";
import { getPeerByAddress, listPeers } from "../../core/peer.js";
import { resetDeliveryConfig } from "../../core/delivery.js";

const handles: DaemonHandle[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  while (handles.length) {
    const handle = handles.pop();
    await handle?.stop();
  }
});

async function dual(tag: string) {
  const sandbox = await startDual(`amail-pair-${tag}`);
  handles.push(sandbox.a, sandbox.b);
  return sandbox;
}

/** 翻转 base64 首字符（在 padding 之后追加字符会被解码器忽略，属无效篡改） */
function flipSig(sig: string): string {
  return `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
}

describe("e2e 配对（双 daemon + fake mdns）", () => {
  it("offer→answer→SAS 相等→双确认→双方 peers 落盘（含双公钥）+ pairing 事件", async () => {
    const { a, b, addrA, addrB } = await dual("ok");
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    a.bus.on((event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }));
    b.bus.on((event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }));

    const { offerNonce, sasA, sasB } = await pairDual({ a, b, addrA, addrB });

    expect(sasA).toMatch(/^\d{6}$/);
    expect(sasA).toBe(sasB);

    const peerA = getPeerByAddress(a.db, addrB);
    const peerB = getPeerByAddress(b.db, addrA);
    expect(peerA?.signPubKeyPem).toBe(b.identity.signPubPem);
    expect(peerA?.encPubKeyPem).toBe(b.identity.encPubPem);
    expect(peerA?.deviceId).toBe(b.identity.deviceId);
    expect(peerB?.signPubKeyPem).toBe(a.identity.signPubPem);
    expect(peerB?.encPubKeyPem).toBe(a.identity.encPubPem);

    const statusA = (await (await fetch(`${baseUrl(a)}/v1/pair/status/${offerNonce}`)).json()) as {
      stage: string;
    };
    const statusB = (await (await fetch(`${baseUrl(b)}/v1/pair/status/${offerNonce}`)).json()) as {
      stage: string;
    };
    expect(statusA.stage).toBe("confirmed");
    expect(statusB.stage).toBe("confirmed");

    expect(
      events.some(
        (e) => e.type === "pairing" && e.data.stage === "confirmed" && e.data.offerNonce === offerNonce,
      ),
    ).toBe(true);
  });

  it("confirmSig 篡改 → 401，会话不落盘；合法 confirm 仍可推进", async () => {
    const { a, b } = await dual("tamper");
    const baseA = baseUrl(a);
    const baseB = baseUrl(b);

    const offer = (await postJson<{ offer: { nonce: string } }>(baseA, "/v1/pair/local-offer")).json.offer;
    expect((await postJson(baseB, "/v1/pair/offer", offer)).status).toBe(200);
    const answered = await postJson<{ answer: unknown }>(baseB, `/v1/pair/local-answer/${offer.nonce}`);
    expect(answered.status).toBe(200);
    expect((await postJson(baseA, `/v1/pair/answer/${offer.nonce}`, answered.json.answer)).status).toBe(200);

    const confirm = (
      await postJson<{ confirm: { sig: string } & Record<string, unknown> }>(
        baseA,
        `/v1/pair/local-confirm/${offer.nonce}`,
      )
    ).json.confirm;
    const tampered = { ...confirm, sig: flipSig(confirm.sig) };
    const res = await postJson(baseB, `/v1/pair/confirm/${offer.nonce}`, tampered);
    expect(res.status).toBe(401);
    expect(listPeers(b.db)).toHaveLength(0);

    // 会话未被污染：同一合法 confirm 可继续推进
    expect((await postJson(baseB, `/v1/pair/confirm/${offer.nonce}`, confirm)).status).toBe(202);
  });

  it("offer 签名被篡改 → 401 拒收", async () => {
    const { a, b } = await dual("badsig");
    const offer = (
      await postJson<{ offer: { sig: string } & Record<string, unknown> }>(baseUrl(a), "/v1/pair/local-offer")
    ).json.offer;
    const res = await postJson(baseUrl(b), "/v1/pair/offer", { ...offer, sig: flipSig(offer.sig) });
    expect(res.status).toBe(401);
    expect(listPeers(b.db)).toHaveLength(0);
  });

  it("answer 前提交 confirm → 409 no-answer-yet", async () => {
    const { a, b } = await dual("early");
    const offer = (
      await postJson<{ offer: { nonce: string } }>(baseUrl(a), "/v1/pair/local-offer")
    ).json.offer;
    await postJson(baseUrl(b), "/v1/pair/offer", offer);
    const res = await postJson(baseUrl(b), `/v1/pair/confirm/${offer.nonce}`, {
      offerNonce: offer.nonce,
      answerNonce: "panswer_x",
      deviceIdA: "aaaaaaaaaaaaaaaa",
      deviceIdB: "bbbbbbbbbbbbbbbb",
      sig: "s",
    });
    expect(res.status).toBe(409);
  });
});
