# Sign of Time

浏览器里的文件时间戳工具。选原文件，可手动添加 OpenPGP 分离签名（私钥不进网页），选择给原文件或签名打戳；支持 DigiCert、FreeTSA 和 OpenTimestamps。`.asot` 仅含凭证和可选签名；`.fsot` 另含原文件。两者是未压缩的 POSIX tar；无需本站或专有解包器。归档里不放说明、清单或公钥。[独立验证说明](public/VERIFY.txt)在网页中可单独下载。

```sh
npm ci
npm run build
npm start
# http://127.0.0.1:4173/
```

`npm run dev` 为开发版本，不注册 Service Worker。正式部署在 HTTPS 域名根路径，将反代指向 `HOST=127.0.0.1 PORT=4173 npm start`；无需数据库。代理不要记录请求体，按需配置来源 IP 限流。服务器仅转发结构受限的 RFC 3161 请求到固定机构，浏览器直连 OTS 日历。别把开发服务器暴露到公网。

原文件及 `.sig` 本地处理，打戳只发送摘要、随机数等协议所需数据；申请新戳和 OTS 补全需要联网。生产版缓存完成后，离线可导入、打包、验 PGP / TSA；比特币证明需用户提供可信区块头（或主动选择联网查两个区块浏览器）。缓存不是长期归档。浏览器验证不查询在线证书撤销信息，不能替代依法要求的合规验证。

OTS 刚签发时通常只有待确认回执。任何持有该 `.ots` 的人都能在日历可用且已完成上链后补全；可用网页的「联网补全 OTS」，也可解包用 `ots upgrade`。请保留更新后的 `.ots` 或新归档，验证时就不用再依赖日历。

## 归档约定

- 顶层普通文件，POSIX ustar；非 ASCII 或较长文件名用 PAX `path`；不接受路径、链接、重复条目。
- `.fsot` 的第一个普通文件是原件，单个原件须小于 8 GiB；更大的原件用 `.asot`。`.asot` 优先以归档名（去扩展名）配对条目，配不上时再尝试外部原件文件名。
- `abc.sig` 是 `abc` 的 OpenPGP 分离签名；原件凭证为 `abc.ots` / `abc-<机构>.tsr`，签名凭证为 `abc.sig.ots` / `abc.sig-<机构>.tsr`。文件名只用于配对，验证仍以实际摘要与签名为准。
- `.asot` 可分发而不暴露原件；单独加 `.sig` 不会让它取得旧时间戳。不要同时改归档和原件的名字，否则网页可能无法自动配对；用通用工具解包后仍能验。

## 测试

`npm test` 验证 tar 与原生工具兼容、加密验证的正反例；`npm run build && npm run test:browser` 运行 Chrome 端到端测试。可用 `CHROME_BIN` 指定系统 Chrome。`LIVE=1 npm run test:browser` 额外测试真实 TSA 与 OTS 日历；涉及对外发送测试文本的摘要。

## 外部材料

OTS 浏览器库来自 OpenTimestamps 项目官网，对应 [javascript-opentimestamps](https://github.com/opentimestamps/javascript-opentimestamps)，LGPL-3.0；浏览器构建、源码来源见 `public/vendor/`。根证书和 FreeTSA 签发证书来自对应机构，其来源见验证说明。项目不依赖第三方 CDN 在运行时加载库。

当前 npm 锁文件内的旧 OTS 依赖有已知安全公告；网页实际使用的独立浏览器构建也尚未完成依赖审计。正式公开部署前应先替换或审计该依赖。
