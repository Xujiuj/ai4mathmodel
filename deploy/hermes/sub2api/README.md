# Hermes Sub2API

该目录保存 Hermes 上现有 `/opt/sub2api` Docker Compose 部署的非敏感加固层。

## 约束

- Sub2API 只绑定 `127.0.0.1:18080`，不直接暴露公网。
- PostgreSQL 与 Redis 只加入 Compose 内部网络。
- `.env`、数据库、Redis 快照和上游凭据只保留在服务器。
- 镜像使用已验证摘要，升级时必须先备份、再更新摘要并重新验收。

## 应用

将 `docker-compose.hardening.yml` 与 `harden.sh` 放入 `/opt/sub2api` 后执行：

```bash
chmod 700 /opt/sub2api/harden.sh
/opt/sub2api/harden.sh /opt/sub2api
```

脚本会在 Redis 密码缺失时于服务器生成随机密码，验证 Compose，并只重建 Redis 与 Sub2API。验收要求包括 HTTP 健康、Redis 匿名请求被拒、认证请求返回 PONG，以及 Sub2API 容器健康；PostgreSQL 不参与定向重建。

## 回滚

每次修改前必须在 `/opt/sub2api/backups/<UTC timestamp>/` 保存 PostgreSQL dump、Redis dump、应用数据、`.env` 和 Compose 文件。

恢复配置时，从对应备份目录还原 `env.backup` 与 `docker-compose.local.yml`，然后使用备份时的 Compose 文件重新创建容器。数据库恢复应在独立实例验证 dump 后执行，不要直接覆盖正在运行的 PostgreSQL 数据目录。
