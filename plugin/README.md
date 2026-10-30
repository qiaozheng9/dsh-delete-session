# dsh-delete-session runtime bundle

此目录是运行时组合包的元数据，`lib/` 由仓库的 `npm run build:plugin` 生成。

**不能单独安装此组合包来获得删除功能。** 当前版本还需要针对受支持的 DeepSeek Harness 桌面构建安装存储与生命周期补丁。请使用[仓库 README](https://github.com/qiaozheng9/dsh-delete-session#readme)中的完整安装流程。

This runtime bundle requires the matching, explicitly installed desktop patches. A standalone `dsh plugin add` is insufficient. No install-time script modifies the desktop application automatically.

The package remains private until it can be distributed with a complete, reproducible installation contract.
