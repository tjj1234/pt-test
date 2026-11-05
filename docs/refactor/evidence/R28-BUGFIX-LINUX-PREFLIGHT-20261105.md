# r28 Bug候选：服务器预检与Linux隔离安装
## 用户回传的root只读预检
northstar-shell active，PID302282，原r28目录未变；health正常。env文件0640 root:northstar，runtime/db/secrets目录0755 northstar:northstar，备份目录0700 root。配置名PT_PG_DSN/PT_DASH_INTERNAL_KEY/PT_RUNTIME_DIR存在；env中PT_MEDIA_ASSET_HOSTS/DSH_HOME未显式声明，不等于所有来源都缺该配置。迁移29；agent_runs cancelled1/completed104/failed168（合计273），查询时无非终态。仅状态聚合，不据此保证执行队列在未来切换时仍空。
未读取配置值，未停止服务/备份/迁移/切换，不把root预检完成当部署完成。目录0755不是文件内容权限证明，本轮不擅自更改生产权限。

## 新候选归档与Linux验证
独立生成r29-bugfix-draft准备包，SHA256 5128ab83b24660ac5647b476a9fa7bd870fa58ec4352d5b0576fa6ce9917acc9，217绑定源码/419成员。旧r28归档未覆盖。候选打包提交27cfa6df123124b2f06016feb9fd551f1d20ff6a仅新增打包器/审计器/指针和归档，运行源码仍db94e42，因R4两项回归保持NOT_FOR_DEPLOYMENT。
已上传服务器用户独占/tmp/pt-r29-validation-20261105，不进入/opt正式release。实际Node24.22.0/Linux x64干净npm ci，锁sha eb54f12313941e09c569058836b5662b2db82069a1fa721ae1a8b6c0113610d4。先前omit-dev缺校验器Arborist，补完整锁依赖后发现默认umask002导致依赖文件0664而非基线0644；按umask022重装后闭包严格匹配495包/31007文件，Arborist8.0.5，LINUX_INSTALL_STATIC_PASS。node --check server/app、Python媒体worker编译通过。未修改闭包期望或放宽校验。
此仅隔离安装/静态验证，不代表服务以northstar身份启动、真实PT、备份恢复、同版独立QA或正式切换通过；没有PT付费调用。后续待作者R4修正后新tip必须重新冻结对应包，不得部署此旧准备归档。
