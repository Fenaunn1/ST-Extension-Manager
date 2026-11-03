# 扩展管理器（Extension Manager）

一个纯前端的 SillyTavern UI 扩展，用来增强左侧「扩展」设置抽屉：吸顶顶栏、搜索扩展、已展开扩展标签页、一键折叠，以及可选的顶栏主题。

针对 **SillyTavern 1.16.0** 编写，不需要服务端插件，不修改 SillyTavern 本体文件。

## 功能

- **吸顶顶栏**：标题、通知开关、搜索、标签页固定在抽屉顶部，滚动时不会被推出。
- **搜索扩展**：按扩展标题实时过滤，支持中文标题和 `data-i18n` 英文键名；显示匹配数量，Esc 清空。
- **已展开标签页**：展开的扩展出现在标签条里，点击跳转；标签过多可横向滚动，当前标签自动高亮。
- **一键折叠**：标签条右侧的向内收拢图标折叠全部；每个标签的 ✕ 单独折叠。
- **收纳顶栏按钮**：默认把「管理扩展 / 安装扩展」收进 ⋯ 菜单，仍调用 ST 原生弹窗；可在设置里切回原生按钮。
- **顶栏主题**：跟随酒馆 / 日间 / 夜间，只作用于本扩展的顶栏、标签、搜索框和菜单，不改 ST 全局主题。
- **扩展设置**：列表里的「扩展管理器」可分别开关吸顶、搜索框、标签页、按钮收纳，并选择主题。

## 通过 GitHub 安装（推荐）

1. 打开 SillyTavern 左侧「扩展」抽屉。
2. 点击「安装扩展」（Install extension）。
3. 粘贴仓库地址：

   ```
   https://github.com/Fenaunn1/ST-Extension-Manager
   ```

4. 确认后刷新页面（建议 Ctrl+F5）。

之后可在扩展列表的「扩展管理器」里调整设置。

> 旧地址 `ST-Extension-Manager-Plus` 在 GitHub 改名后仍会重定向，但建议改用上面的新地址。

## 手动安装

把整个 `ST-Extension-Manager` 文件夹放到下面任一位置，然后刷新页面：

- 用户级：`<SillyTavern>/data/<用户名或 default-user>/extensions/ST-Extension-Manager/`
- 全局：`<SillyTavern>/public/scripts/extensions/third-party/ST-Extension-Manager/`

## 使用

1. 打开「扩展」抽屉，顶部会出现搜索框和标签条。
2. 展开任意扩展后，它会出现在标签条中；点击标签跳转，✕ 折叠单个，右上角一键全部折叠。
3. 标签条右侧的 ⚙ 打开本扩展设置；⋯ 菜单里是管理与安装入口。

## 设置项

设置保存在 `extension_settings.extension_manager`（会从旧的 `extension_manager_plus` 自动迁移）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `theme` | `auto` | 顶栏主题：`auto` 跟随酒馆，`day` 日间，`night` 夜间 |
| `sticky` | `true` | 顶栏吸顶 |
| `showSearch` | `true` | 显示搜索框 |
| `compactActions` | `true` | 收纳顶部按钮，把管理与安装收进 ⋯ 菜单 |
| `showTabs` | `true` | 显示已展开标签页 |

## 兼容性与限制

- 依赖 SillyTavern 的 `#rm_extensions_block`、`.extensions_block`、`.inline-drawer` 结构；ST 大改版后可能需要同步选择器。
- 只处理「扩展」抽屉里的顶层设置抽屉，不会把扩展内部的嵌套折叠项当成独立扩展。
- 仅操作页面 DOM/CSS，不发起额外网络请求；设置通过 SillyTavern 自带的设置保存机制持久化。
- 使用 `color-mix()` 等现代 CSS；Chrome / Edge 105+、Firefox 121+ 正常。

## 文件结构

```text
ST-Extension-Manager/
├─ manifest.json   # display_name = 扩展管理器，loading_order = 1000
├─ index.js        # 工具栏、搜索、标签、折叠、设置、主题
├─ style.css       # 顶栏 / 标签 / 下拉菜单 / 日间夜间配色
└─ README.md
```

## 版本

- 1.0.1：更名为「扩展管理器」，仓库改为 `ST-Extension-Manager`；收纳菜单图标统一为横向 ⋯；设置键迁移到 `extension_manager`。
- 1.0.0：正式版；左右留白、紧凑图标与设置面板间距；日间/夜间搜索框强制使用主题色；夜间改为中性灰黑；精简说明文案。
- 0.1.2：新增「跟随酒馆 / 日间 / 夜间」顶栏主题，跟随模式随 ST 主题实时更新。
- 0.1.1：加大搜索框与标签条间距；一键折叠改用向内收拢图标；设置项按字数排序、去括号、加图标；标题解析缓存。
- 0.1.0：首版，包含吸顶、搜索、标签页、一键折叠、按钮收纳。
