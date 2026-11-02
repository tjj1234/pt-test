# F1 上传桥 R1 主审：阻断接线

Gemini R1五文件及交付报告已落盘。独立重跑Python worker 8/8通过，Node桥22/22通过（先前并行写文件期间出现恢复taskId夹具断言失败，交付后复跑已消失，不作为当前失败）。这些测试均是离线协议夹具，不能证明生产URL或Run持久化。

主审以vendored `pt_video.py` 当前常量核对：真实资产POST是 `https://powertokens.ai/api/v1/asset/upload`，匿名查询是 `https://powertokens.ai/api/v1/asset/jobs/get-asset-id?task_id={}`。R1 worker运行时重写为可传baseUrl的 `/v1/asset/upload` 与 `/v1/asset/get-id`，既不匹配现有引擎，也允许任意HTTPS网关承接首帧Key。Node `on_task_id`/`on_asset_id`缺已确认前置顺序约束，assetId/`done`结果未严校，`stop()`在子进程实际close前reject。这些是安全与一致性阻断，R1不接产品、不进r10。独立R2任务包 `GEMINI-PT-ASSET-UPLOAD-BRIDGE-R2-PACKAGE-20261029.md`已写，仅新增五个文件；主Agent负责后续Run/DB/授权和同版验证。

宿主接线边界：当前 `createManagedMediaExecutor` 把可信上传图的data URL送进 `callMediaRoute`，对Python `image2video` 路由，`ptvideo-executor`要求公网URL或Seedance的 `asset://`，因此必须先把可信当前上传bytes经受审R2桥取得并**持久化**assetId，再让生成操作开始；不能把asset上传结果与生成付费操作混成一个状态，也不能在未知上传状态自动重提。Python `text2video`不需要资产上传，可独立验证现有生成桥。R2完成前不调用真实资产上传。
