# 书源配置（小说资源模块）

> 「小说」和「小说榜单」两个页面的数据都来自**书源**。书源存在服务器的
> `state/book-sources.json`（DOWNLOAD_ROOT/state/book-sources.json），可随时改、
> 改完不用重启（每次请求都会重新读）。

内置一个**开箱即用的合法公版源**：

- `gutendex`：古登堡计划（Project Gutenberg）公版电子书，搜索 + 下载整本纯文本。

其余平台（起点/晋江/番茄/七猫/笔趣阁等）需要按下面的格式**自己加**（你已确认允许
"书源能抓到就下载"，但平台有反爬、书源会失效，需要持续维护）。

---

## 一、HTML 网页书源的格式

一个网页书源长这样（纯 CSS 选择器，不需要 JS 规则）：

```json
{
  "kind": "html",
  "id": "qidian",                       // 唯一 id
  "name": "起点中文网",                  // 显示名
  "enabled": true,                      // 是否启用
  "baseUrl": "https://www.qidian.com",  // 相对链接转绝对用
  "encoding": "utf-8",                  // utf-8 或 gbk（很多笔趣阁是 gbk）

  "searchUrl": "https://www.qidian.com/so/{q}.html",   // {q} 会被替换成搜索词

  "searchListSel": ".book-mid-info",     // 搜索结果列表：每个"条目"的选择器
  "searchTitleSel": "h4 a",             // 书名（相对上面条目）
  "searchAuthorSel": ".author a",        // 作者（可空）
  "searchUrlSel": "h4 a",               // 点书名那个 <a>，取它的 href 作为详情链接
  "searchIntroSel": ".intro",           // 简介（可空）

  "bookTitleSel": "h1",                 // 详情页书名
  "bookAuthorSel": ".author",           // 详情页作者（可空）
  "bookIntroSel": ".intro",             // 详情页简介（可空）
  "catalogListSel": ".catalog a",       // 目录：每个"章节"的选择器
  "catalogTitleSel": ".",               // 章节标题（"." = 用上面那个节点本身的文字）
  "catalogUrlSel": ".",                 // 章节链接（"." = 取上面那个节点的 href）

  "chapterContentSel": ".read-content", // 正文容器
  "removeSel": [".ad", "script", "style"]  // 正文里要去掉的广告/脚本节点
}
```

### 规则要点

1. 所有选择器都是 **CSS 选择器**；`searchListSel` / `catalogListSel` 选出"一批条目"，
   其余 `*Sel` 都是"相对这个条目"的子选择器。
2. `*UrlSel` 取的是那个节点的 `href` / `src` 属性；`*TitleSel`/`*AuthorSel`/`*IntroSel` 取文字。
3. 相对链接会自动用 `baseUrl`（或重定向后的最终 URL）转成绝对地址。
4. `encoding`：页面乱码就改成 `gbk`（依赖已内置 iconv-lite）。

---

## 二、榜单的格式

榜单是"书源 + 榜单页选择器"的组合，同样写在 `book-sources.json` 的 `rankBoards` 里：

```json
{
  "rankBoards": [
    {
      "key": "platform-qidian-hot",          // 唯一 key
      "category": "platform",                // platform=平台榜 / genre=类型榜
      "label": "起点 · 热门",                 // 页面显示的榜名
      "sourceId": "qidian",                  // 用哪个书源抓
      "url": "https://www.qidian.com/rank/hotsales/",  // 榜单页地址
      "listSel": ".book-img-text li",        // 榜单条目选择器
      "titleSel": ".book-mid-info h4 a",     // 书名
      "authorSel": ".author",                // 作者（可空）
      "urlSel": ".book-mid-info h4 a"        // 书的详情链接（href）
    }
  ]
}
```

- **平台榜**：给起点/晋江/番茄/七猫等各配一条，`category: "platform"`。
- **类型榜**：科幻/玄幻/修仙/穿越等各配一条，`category: "genre"`（把榜单 URL 换成该类型榜即可）。

---

## 三、怎么拿到真实书源

1. **legado 书源仓库**（GitHub/Gitee 上搜"阅读书源 / legado 书源 / 一程书源"）里有
   现成的起点/晋江/番茄/七猫/笔趣阁源——它们的格式是 legado 的（含 JS 规则），
   本模块用**简化版 CSS 选择器**，不能直接抄，但可以照着它的"搜索/详情/目录/正文 URL
   和选择器"手动转成上面的格式。
2. 自己用浏览器 F12 打开对应页面，照着"列表元素 → 书名/链接/作者"抄选择器即可。

> ⚠️ 版权提示：起点/晋江/番茄/七猫的签约作品受版权保护，抓取下载（尤其再分发给别人）
> 属侵权，风险自负。本模块只提供"书源"这套工具，不内置任何盗版书源。

---

## 四、改完怎么生效

```bash
# 编辑服务器上的书源文件
sudo nano /ttdownload/state/book-sources.json
# （改完保存即可，无需重启服务；刷新网页就生效）
```

以后也可以在网页里做"书源管理"（增删改、测速），先手写 JSON 也能用。
