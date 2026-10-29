---
title: "云服务器出网超时：内网 DNS 失效排查"
product: "知识库运维"
source: "项目运维实测经验"
---

# 云服务器出网超时：内网 DNS 失效排查

## 现象

阿里云 ECS 上 `pip install`、`docker pull`、访问外网域名全部超时，但 `ping` 公网 IP 正常；重装 Docker、换网络均无果。

## 排查思路

先区分"连不上"和"解析不了"：

1. 绕过 DNS 直接测连通性：`curl --resolve 域名:443:真实IP https://域名`，若秒回（哪怕是 401/403），说明 TCP 出方向正常，问题在 DNS；
2. 测 DNS：`nslookup` 或直接向 `/etc/resolv.conf` 里的服务器发 UDP 请求，若无响应即为 DNS 故障。

本例实测：云厂商内网 DNS 地址的 UDP 请求无响应，443 出方向 0.04 秒通——定位为**内网 DNS 失效**，而非防火墙或带宽问题。

## 解决方案

1. 将 `/etc/resolv.conf` 的 nameserver 换成公共 DNS（如 223.5.5.5、223.6.6.6）；
2. 云机会周期性用 DHCP 覆盖该文件，需执行 `chattr +i /etc/resolv.conf` 锁定；
3. 改前先备份原文件（如 `/etc/resolv.conf.bak`）。

## 连带问题：镜像加速器失效

DNS 修复后 `docker pull` 官方源仍超时（国内网络环境限制），需要在 `/etc/docker/daemon.json` 配置可用的镜像加速地址并重启 Docker。加速器地址会随时间失效，报错时先验证加速器本身是否可达，再怀疑其他环节。
