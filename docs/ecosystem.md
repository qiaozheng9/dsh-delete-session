# DSH 插件生态接入状态

核对日期：2026-10-30。

## 当前可以做什么

- 将源码作为 MIT 开源项目发布，提供清晰的兼容性、构建和本地安装说明。
- 使用 GitHub 的 `deepseek-harness`、`dsh-plugin` 等主题帮助社区发现。主题标签不是官方审核、收录或安装成功的保证。
- 向有相应分类的社区目录申请以“需手动安装补丁的实验性增强工具”展示；具体是否收录由目录维护者决定。

## 当前不宜宣称什么

本项目的删除服务需要与日志写入器、运行任务、索引和客户端缓存协作。当前 DSH 构建缺少所需能力，因此安装器还要适配本机 DSH 程序文件。

运行时组合包虽然声明了 `dsh.bundle` 和对应版本的 `engines.dsh`，但单独安装该包不会完成上述适配。仓库根目录是开发与安装工具项目，也不是一个可以直接通过 GitHub 地址安装的成品组合包。

因此，目前不能将其描述为“已获官方收录”或“在插件市场一键安装即可使用”。本仓库不自动执行应用补丁安装，也未发布 npm 包或市场索引。

## 官方机制与接入条件

DSH 的[组合包发布文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)说明了 bundle manifest 与安装产物；[插件市场文档](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)描述的是可添加第三方 JSON 索引的机制，目前不随 DSH 提供默认索引源。它不是一个上传仓库就自动进入的统一官方商店。

后续适合按以下顺序推进：

1. 优先让上游提供稳定的删除、写入阻断和客户端失效接口，或者确定可独立交付、明确适用范围的适配机制。
2. 提供无需本机重新生成程序补丁的可安装产物，并在干净的受支持安装上验证完整安装、删除、恢复与卸载。
3. 保持 `dsh.bundle`、`engines.dsh`、版本及源码来源一致，并按[市场索引规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)固定发布来源。
4. 再向具体的第三方市场提交，由其维护者决定收录；若自行提供索引，也应明确实验状态和安装要求。

当前发布先完成可审查的源码与本地安装交付，不用宽泛的版本声明掩盖存储层适配限制。
