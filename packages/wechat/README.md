# qrcode-decode-ultra-wechat

The opt-in **OpenCV WeChat QRCode** engine for
[QRCode Decode Ultra](https://github.com/zoexx/qrcode-decode-ultra). A CNN
detector + super-resolution model that decodes the small, blurry, damaged and
low-light QR codes the native and jsQR fast path miss — at the cost of a ~2.5 MB
WASM payload, loaded lazily only when the cascade reaches this tier.

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

## Notes

- Best for still images and "scan this hard photo", not 60fps video — this is the
  accuracy tier, not the speed tier.
- WeChat runs in-process on the main thread (the core worker build never includes
  it), but it still works with the worker default: the worker runs the
  native + jsQR fast path, and on a miss the main thread runs the WeChat decode.
  Still-image use can also pass `worker: false`.

## License

MIT for this package's wrapper code. The OpenCV WeChat engine and its model
weights are reached through the `qr-scanner-wechat` dependency (MIT wrapper,
© 2023 Anthony Fu) and are themselves **Apache-2.0** (Copyright (C) 2021 THL A29
Limited, a Tencent company). The upstream Apache-2.0 text is reproduced verbatim
at `assets/LICENSE` and attributions are in `NOTICE`; the weights' license was
verified against the upstream `WeChatCV/opencv_3rdparty@wechat_qrcode` LICENSE.
