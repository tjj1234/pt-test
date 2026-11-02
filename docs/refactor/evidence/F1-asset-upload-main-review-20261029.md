# 上传候选主审与公开CDN验证

结论：Gemini三文件现已全部出现，原27项离线通过；主审overlay修正三个反例、统一CLI核心并加入已有task的GET-only恢复。最终55项通过：原上传27、主审13、原生成引擎15（实际在两层补丁后的同一临时引擎执行）。未修改vendor引擎、worker、Run或上传授权；候选不在r7中，不能称Python参考图上传已接通。

| 反例 | 原候选实测 | 独立overlay |
|---|---|---|
| poll_timeout=NaN | 仍可POST并成功，deadline失效 | NaN/±Infinity提交前INVALID_TIMEOUT，0POST |
| POST code为任意字符串/对象 | 任意内容进入error_code，sentinel泄漏 | 固定错误码，不回显code |
| GET缺成功code但带asset_id | 返回成功 | 只接受整数200，否则拒绝 |

另移除HTTP timeout的0.1秒下限，避免timeout超出实际剩余时间。原始反例命令`python3 tests/probes/pt-asset-upload-main-review-20261029.py`；修后组合测试`python3 tests/regression/pt-asset-upload-main-review-test.py`。独立补丁`candidates/pt-asset-upload-main-review-20261029.patch`须在Gemini补丁之后应用；所有测试仅临时副本，socket阻断，不覆盖原候选/报告。

CLI group_name重复轮询已在独立overlay移除，CLI与产品共用私有上传核心；产品入口拒绝group_name与_group_name，CLI组名限制1024字节且无CRLF。尚需处理：真实read()的socket超时不等同绝对总deadline；宿主必须提供持久化hooks、独立上传授权/意图、恢复已有task_id的GET入口及取消处理。原报告“严格总时间≤120秒/完全兼容”不能由27项推断。不得借生成grant的一次POST额度上传；无真实上传/费用验证。

接续：`recover_uploaded_asset_for_product`已在overlay新增，只接已有task_id，无Key/图片/POST参数，与首次上传共享匿名轮询核心；校验GET无Authorization/Cookie、ID编码、超时/取消、保存失败保留两个ID、保存回调后再查期限/取消。它仍未接Run恢复API或worker。overlay应用前执行git apply --check及patch --dry-run；原生成15项由组合测试实际重跑，不能把仅上传测试外推生成兼容。

公开网络补充：从[PT Wan3官方页面](https://powertokens.ai/models/wan3.0-video)HTML取得其公开静态示例图片URL，执行`node tests/probes/managed-media-public-cdn-20261029.mjs`。沙箱首次FETCH_NETWORK_ERROR；明确获批后同命令匿名GET通过：host `pub-ee388a8463c1497c8b4f503044a80ee1.r2.dev`，image/jpeg，603179字节，SHA256 `8c029afcbf746d8790609b7e566879336cac88b7623b659ab6b89d95e2e6588a`。实际复用pinned DNS/TLS与流式2MiB/15秒上限、JPEG签名检查；图片不落仓库，不使用Key，无生成/上传POST。仅证明该公开静态CDN链，不能外推真实生成结果、全部CDN或PT业务验收。
