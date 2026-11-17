## 这个 PR 做了什么

## 关联 issue

Closes #

## 改动类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 重构（不改行为）
- [ ] 文档
- [ ] 抽取规范（`md/auction-extraction-spec.md`）

## 自查清单

- [ ] 所有 `.js` 都过 `node --check`（CI 会跑，本地先跑一遍更快）
- [ ] 改了解析口径的话，改的是 `md/auction-extraction-spec.md`，不是 `common.js` 里的提示词
- [ ] 抬了 `manifest.json` 的 `version`，并在 `CHANGELOG.md` 记了一笔
- [ ] 改动了 `common.js` 的 `BUILD_STAMP`（改共用逻辑时必须跟上，否则用户会跑到缓存的旧脚本）
- [ ] 没有提交任何 `sk-…` / `github_pat_…` / `.pem` / `.crx`
- [ ] 在真实页面上试过，不是只看代码

## 测试情况

- 浏览器与版本：
- 测过的站点与标的类型：
- 导出结果是否人工比对过：
