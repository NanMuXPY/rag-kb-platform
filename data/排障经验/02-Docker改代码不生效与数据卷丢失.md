---
title: "Docker 改代码后服务不生效的排查"
product: "知识库运维"
source: "项目运维实测经验"
---

# Docker 改代码后服务不生效的排查

## 现象

修改后端 Python 代码后执行 `docker compose restart`，服务起来了，但新代码的接口 404、旧 bug 依旧存在。

## 原因

后端代码是**烧进镜像**的（Dockerfile 里 COPY 进去），不是挂载进容器的。`restart` 只是把同一镜像的同一容器停掉再启动，镜像不变，代码自然不变。

## 解决方案

改代码后必须重建镜像并替换容器：

```bash
docker compose up -d --build
```

只改 `.env`、nginx.conf 这类挂载文件时，`restart` 或 `docker compose up -d` 即可生效；判断标准是"这个文件在不在 Dockerfile 的 COPY 列表里"。

## 连带坑：bind mount 丢失导致数据丢失

如果打包部署时，本地压缩包里的 `docker-compose.yaml` 覆盖了服务器上的版本，而本地版本**漏写了数据卷挂载**（如 `./data:/app/backend/data`），会出现连锁问题：

- 容器内路径变成镜像层可写层，SQLite 数据库（如用户表 users.db）写进容器层；
- 平时一切正常，**容器重建的瞬间数据全部丢失**，且不易察觉。

排查方法：`docker inspect <容器名> | grep -A5 Mounts`，核对挂载列表与预期一致；发现数据已写入容器层时，可在重建前用 `docker cp` 把数据抢救到宿主机。

## 预防措施

- 部署打包时明确排除本地 `.env`、`docker-compose.yaml`，服务器配置永远以服务器为准；
- 所有需要跨容器重建存活的数据（数据库、上传文件、回收站）一律 bind mount 或命名卷；
- 每次部署后用 `docker inspect` 核对一遍挂载点。
