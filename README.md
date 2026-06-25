# 英语短语提取工具 - Chrome浏览器插件

这是一个Chrome浏览器侧边栏插件，可以从网页或文本中提取四级以上的英语短语，并提供中文释义和例句。

## 功能特点

- ✅ 侧边栏显示，不影响浏览体验
- ✅ 支持文本和网页链接两种输入方式
- ✅ 自动提取四级以上英语短语
- ✅ 提供中文释义和多个例句
- ✅ 历史记录保存
- ✅ 一键复制所有短语
- ✅ 导出为TXT或Markdown格式

## 安装步骤

### 1. 准备图标文件

在插件目录中创建三个图标文件（或使用占位图标）：
- `icon16.png` (16x16像素)
- `icon48.png` (48x48像素)
- `icon128.png` (128x128像素)

### 2. 加载插件到Chrome

1. 打开Chrome浏览器
2. 在地址栏输入 `chrome://extensions/`
3. 打开右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择包含这些文件的文件夹
6. 插件安装完成！

### 3. 使用插件

1. 点击Chrome工具栏中的插件图标
2. 侧边栏会自动打开
3. 点击右上角齿轮按钮，填写自己的 DashScope API Key 并保存
4. 选择输入类型（文章内容或网页链接）
5. 粘贴内容或输入链接
6. 点击"提取短语"按钮
7. 查看提取结果，可以复制或导出

## 调试方法

如果侧边栏显示空白：

1. 右键点击侧边栏 → 选择"检查"打开开发者工具
2. 查看Console标签页中的错误信息
3. 检查Network标签页确认API请求是否成功
4. 确保API密钥有效且有足够的额度

## 文件说明

- `manifest.json` - Chrome插件配置文件
- `background.js` - 后台服务脚本
- `sidepanel.html` - 侧边栏HTML页面
- `sidepanel.js` - 纯JavaScript实现（无需React）
- `README.md` - 说明文档
- `create-icons.html` - 图标生成工具

## 注意事项

1. 项目不内置 API Key，用户需要在插件设置中填写自己的 DashScope API Key
2. API Key 只保存在本机 `chrome.storage.local` 中，请勿提交到代码仓库
3. 确保网络连接正常
4. API调用可能产生费用，请注意使用量
5. 插件需要访问 `https://dashscope.aliyuncs.com/*` 的权限

## 技术栈

- 原生JavaScript（无需构建工具）
- Tailwind CSS
- Chrome Extension Manifest V3
- 阿里云通义千问API (qwen3.7-plus)

## 许可证

MIT License
