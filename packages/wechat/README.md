# qrcode-decode-ultra-wechat

The opt-in **OpenCV WeChat QRCode** engine for
[QRCode Decode Ultra](https://github.com/zoexx/qrcode-decode-ultra). A CNN
detector + super-resolution model that decodes the small, blurry, damaged and
low-light QR codes the native and jsQR fast path miss — at the cost of a ~6 MB
payload (~2.5 MB gzipped), loaded lazily only when the cascade reaches this tier.

It lives in its own package on purpose: a default `qrcode-decode-ultra` install
stays zero-WASM, and you add the heavy tier only when you need it.

```bash
npm install qrcode-decode-ultra-wechat qrcode-decode-ultra
```

## Usage

```ts
import { createScanner } from "qrcode-decode-ultra";
import { enableWechat } from "qrcode-decode-ultra-wechat";

enableWechat(); // registers the "wechat" engine with core

const scanner = createScanner({ engines: "max-accuracy" });
const results = await scanner.scanImage(hardPhoto);
```

`max-accuracy` resolves to `native → jsQR → WeChat`. Without `enableWechat()`
the `wechat` slot is simply absent from the cascade — `scanner.ready()` reports
it as `{ available: false, reason: "not installed" }` and the rest of the cascade
still works.

To keep the payload out of your initial bundle, import it lazily:

```ts
const { enableWechat } = await import("qrcode-decode-ultra-wechat");
enableWechat();
```

## How it runs

`enableWechat()` registers a **worker** for this tier, not just an engine. The
scanner then runs two workers: core's own for the `native + jsQR` fast path, and
this package's for WeChat, which it drives on a fast-path miss.

That matters because this tier is heavy. From the repo's own benchmark
(`pnpm benchmark`, numbers in the [root README](../../README.md#benchmark)):

| | cost |
|---|---|
| download | ~6 MB raw, ~2.5 MB gzipped |
| model load, once | 0.6–1.2 s depending on machine |
| decode, per escalated frame | ~250 ms (`downscale_32`) to ~325 ms (`torture`) — category medians |

On a live camera the fast path misses on *every* frame while the user lines up a
hard code, so on the main thread that would be a near-continuous freeze rather
than an occasional hitch. In its own worker it costs nothing visible.

The engine still runs in-process if there is nowhere else to put it — `worker:
false`, or an environment without `Worker`/`OffscreenCanvas`. That path loads the
payload lazily, so you only download it if you actually take it.

It is still the accuracy tier, not the speed tier: at ~250–325 ms per escalated
frame you will not get 60fps out of it, and it is at its best on still images and
"scan this hard photo".

## License

MIT for this package's wrapper code. The OpenCV WeChat engine and its model
weights are reached through the `qr-scanner-wechat` dependency (MIT wrapper,
© 2023 Anthony Fu) and are themselves **Apache-2.0** (Copyright (C) 2021 THL A29
Limited, a Tencent company). The upstream Apache-2.0 text is reproduced verbatim
at `assets/LICENSE` and attributions are in `NOTICE`; the weights' license was
verified against the upstream `WeChatCV/opencv_3rdparty@wechat_qrcode` LICENSE.
