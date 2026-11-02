# 运维协助：新候选 Python 运行条件，只读核对
背景：r5目录热修已完成；candidate34是本地不可部署草案，当前不切服务、不上传新unit、不安装Python/依赖、不发起PT调用。需要确认未来可信worker默认解释器路径可用；Linux隔离Python3.12测试通过不代表现网存在该解释器。

请在当前FAT目标机执行并回传输出：
```bash
command -v python3
/usr/bin/python3 --version
sudo -u northstar /usr/bin/python3 -I -B -c 'import sys,ssl,urllib.request,json,hashlib,signal,threading,time; print(json.dumps({"version":list(sys.version_info[:3]),"minimumVersionOk":sys.version_info[:2]>=(3,10),"stdlibOk":True,"executable":sys.executable}))'
systemctl show northstar-shell --property=ActiveState --property=MainPID --property=WorkingDirectory
```
若命令缺失或失败，原样回传错误即可，不自行安装或改路径。不要提供env、数据库连接串、API Key、用户文件或日志正文；不要重启已正常运行的r5。以上不构成candidate34部署授权。
