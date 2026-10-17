# dsh-market-index

DeepSeek Harness（DSH）插件市场索引，**format 1**，供 DSH 的「插件 → 发现」标签页直接使用。

由 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录生成：
只收录 manifest 里声明了 `dsh.bundle` 的 npm 组合包，版本、发布时间、`engines.dsh` 全部取自
npm registry 真值（不采信目录里的版本声明）。**收录不代表安全审查**。

## 在 DSH 里使用

插件 → 实验性插件 → 更多 → 打开「自定义插件市场」→ 发现 → 添加索引源，填：

```
https://cdn.jsdelivr.net/gh/p8054076283-del/dsh-market-index@main/index.json
```

或直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://cdn.jsdelivr.net/gh/p8054076283-del/dsh-market-index@main/index.json
```

## 生成规则

| 步骤 | 规则 |
|---|---|
| 输入 | `https://awesome-dsh-plugin.com/plugins.json`（社区最大目录） |
| 过滤 | 只保留有 npm 包名的条目，并在 registry 上真实存在 |
| 版本 | 取 `dist-tags.latest`；其 manifest 必须声明 `dsh.bundle`，且未被 deprecated |
| 时间 | `publishTimestamp` 取 packument 的 `time[version]`（Unix 秒） |
| 来源 | `source.type = npm`，registry 指向 `registry.npmmirror.com`（国内直装快） |
| 兼容性 | `engines.dsh` 原样透传，兼容性由 DSH 自己计算 |
| 排序 | 额外声明 `stars` / `downloads` 两个排序键 |

`engines.dsh` 缺失的插件不会被丢弃——「发现」页会把它显示为未声明，而不是判定不兼容。

## 本地运行

```sh
npm install --omit=dev
node scripts/build-index.mjs --out index.json
node scripts/build-index.mjs --check          # 用 DSH 官方校验器验一遍
```

每天 03:17 UTC 由 GitHub Actions 自动重建；也可在 Actions 页手动触发。
