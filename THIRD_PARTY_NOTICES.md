# 第三方材料与许可

本项目的 LGPL-3.0-only 声明不改变第三方材料的许可。

## OpenTimestamps

`public/vendor/opentimestamps.min.js` 是 OpenTimestamps 官网的 0.4.9 浏览器构建的原样副本，作为独立脚本加载。下载出处、摘要、对应版本源码和编译说明见 [vendor 说明](public/vendor/README.txt)。上游许可声明见 [OPENTIMESTAMPS-LICENSE.txt](public/vendor/OPENTIMESTAMPS-LICENSE.txt)（LGPL-3.0-or-later）；其引用的 [GPL-3.0 正文](LICENSES/GPL-3.0.txt)也随源码提供。

## npm 依赖

- [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)：LGPL-3.0-or-later。
- [hash-wasm](https://github.com/Daninet/hash-wasm)：MIT。
- [ASN1.js](https://github.com/PeculiarVentures/ASN1.js) 和 [PKI.js](https://github.com/PeculiarVentures/PKI.js)：BSD-3-Clause。
- [javascript-opentimestamps](https://github.com/opentimestamps/javascript-opentimestamps)：上游源码许可声明为 LGPL-3.0-or-later。锁文件内的 npm 包不是网页加载的脚本。

具体版本见 [package-lock.json](package-lock.json)。其他直接及间接依赖的版权、许可与通知见对应 npm 包的原始文件；再分发构建产物时应保留适用的声明，并提供相应源码和重建方式。

## 外部数据

证书来自 DigiCert 与 FreeTSA，来源见 [独立验证说明](public/VERIFY.txt)。测试夹具的来源见 [test/fixtures/README.md](test/fixtures/README.md)。
