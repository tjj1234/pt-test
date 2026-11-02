# T17 candidate lockfile provenance regression — 2026-10-22

**结论：**新增本地回归将 candidate-17 归档身份、三个归档 lockfile、当前工作区 lockfile 字节及代表性精确依赖版本绑定起来；定向结果 2/2 PASS。该检查可由后续复验者重复运行，不访问网络、不读取环境秘密、不安装依赖、不调用模型，也不修改 candidate-17 归档或 unit。

回归文件：`tests/regression/t17-candidate-lockfile-provenance-test.mjs`。第一例核对 tar.gz SHA-256 为 `480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964`，抽取 `shell/package-lock.json`、`analytics/package-lock.json`、`business/attribution/package-lock.json` 后，分别验证归档字节、当前源码字节和记录的 SHA-256 一致，且三者均为 lockfile v3。第二例核对锁文件中 DSH/adapter/pi-ai/pg/nodemailer/Fastify 的版本、source class 前缀及 lock integrity 声明。

复验命令：`node --test tests/regression/t17-candidate-lockfile-provenance-test.mjs`；结果 **2 passed, 0 failed**。独立归档与工作区锁文件 hash：shell `96c89082800cc682307a61436d115f5d080bb40a6f3c53a08c0478023fc993f3`；analytics `7ba7d25c51f71024a302d1c0a3ea64489510b87875355cba207c35b25dd1ae04`；business/attribution `49944f7144baf429d5f827744bb519bdba972f96f02fef7ef31d12f642aa8d22`。candidate-17 的归档 checksum 与部署清单记录一致。

**边界：**npm lock 的 `resolved` / `integrity` 是锁定声明；本回归没有下载或重新计算 registry tarball integrity，不能证明包在供应商端仍可用、供应商支持/安全状态、生产机安装版本、配置生效、运行时出口、owner/复验周期、价格/region/SLA，也不覆盖整个 T17 或 AC23。candidate-17 内容未变；线上部署和真实资格 Run 仍待维护者执行并回传。
