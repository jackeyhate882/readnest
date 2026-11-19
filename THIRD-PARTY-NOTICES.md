# 第三方组件与许可

本项目以 [MIT](LICENSE) 许可发布。仓库里打包了以下第三方组件，它们各自保留原许可：

| 组件 | 用途 | 许可 | 位置 |
| --- | --- | --- | --- |
| [Mozilla Readability](https://github.com/mozilla/readability) | 正文抽取 | Apache-2.0 | `vendor/Readability.js` |
| [KaTeX](https://katex.org/) | 数学公式渲染（含 20 个 woff2 字体） | MIT | `vendor/katex/` |
| [Newsreader](https://github.com/productiontype/Newsreader) | 正文字体（woff2 子集） | SIL Open Font License 1.1 | `vendor/fonts/newsreader-*.woff2` |
| [Cormorant Garamond](https://github.com/CatharsisFonts/Cormorant) | 标题字体（woff2 子集） | SIL Open Font License 1.1 | `vendor/fonts/cormorant-*.woff2` |

## 说明

- `vendor/Readability.js` 顶部保留了原项目的版权声明与 Apache-2.0 许可头。
- KaTeX 的 CSS/JS 文件内保留了原 MIT 许可声明；字体为 KaTeX 发行版自带的 woff2。
- 两套衬线字体只打包了 latin 子集，用于拉丁字母与数字；中文会回退到系统字体（Songti SC / Noto Serif SC 等）。
- 图标由 `test/gen-icons.mjs` 生成，属于本项目原创。

如果你再分发本项目，请保留上述声明。
