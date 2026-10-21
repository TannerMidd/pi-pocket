/** A small data-only Simplified Chinese UI locale pack. It translates the fixed Pocket UI text that its own tests exercise; a complete dictionary belongs in a separate extension. */
import { defineExtension } from "@earendil-works/pi-durable";

// Keys are the exact English source strings used by t() at the UI call sites. A key that
// is absent here, and every user-written or model-written string, stays English.

const strings: Record<string, string> = {
    Menu: "菜单",
    Files: "文件",
    Extensions: "扩展",
    Appearance: "外观",
    Discover: "发现",
    "Installed extensions": "已安装扩展",
    "Install theme": "安装主题",
    "Install (stays off)": "安装（保持关闭）",
    "Index settings and status": "索引设置与状态",
    "Technical details": "技术详情",
    Installed: "安装时间",
    "View source": "查看源码",
    Update: "更新",
    Updates: "更新",
    "Reply speed": "回复速度",
    "Status line": "状态栏",
    "Mark unread": "标记为未读",
    "Mark read": "标记为已读",
    Select: "选择",
    Sessions: "会话",
    "New session": "新会话",
    People: "成员",
    Memory: "记忆",
    Providers: "模型提供方",
    Model: "模型",
    Save: "保存",
    Cancel: "取消",
    Close: "关闭",
    Search: "搜索",
    Rename: "重命名",
    Send: "发送",
    Stop: "停止",
    Copy: "复制",
    Theme: "主题",
    Edit: "编辑",
    Done: "完成",
    Loading: "加载中",
    "No matches.": "没有匹配项。",
    "Try again": "重试",
    "Turn off": "关闭",
    "Turn on": "开启",
    "Sign out": "退出登录",
    New: "新建",
    Open: "打开",
    Remove: "移除",
    Add: "添加",
    Back: "返回",
    Name: "名称",
    Details: "详情",
    Install: "安装",
    Uninstall: "卸载",
    Running: "运行中",
    Context: "上下文",
};

const templates: Record<string, string> = {
    "{{count}} entries need a newer Pi Pocket.": "{{count}} 个条目需要更新版本的 Pi Pocket。",
    "{{count}} entry needs a newer Pi Pocket.": "{{count}} 个条目需要更新版本的 Pi Pocket。",
    "Update {{title}}": "更新 {{title}}",
    "Source: {{title}}": "源码：{{title}}",
    "{{rate}} tokens a second": "每秒 {{rate}} 个 token",
    "its first token after {{seconds}}s": "首个 token 耗时 {{seconds}} 秒",
    "in {{seconds}}s": "{{seconds}} 秒后",
    "How fast the last answer came: {{detail}}": "上一条回复的生成速度：{{detail}}",
    "Could not attach {{name}}: {{error}}": "无法附加 {{name}}：{{error}}",
    "Back to {{tab}}": "返回{{tab}}",
    "{{model}} (not signed in)": "{{model}}（未登录）",
    "{{verb}} {{what}}. {{action}} to undo.": "{{verb}} {{what}}。{{action}}可撤销。",
    "{{count}} allowed: {{models}}": "已允许 {{count}} 个：{{models}}",
    "Back to sessions, {{count}} waiting for you": "返回会话列表，{{count}} 项待你处理",
};

export default function createZhCnUiLocale() {
    return {
        ...defineExtension({ name: "zh-cn-ui" }),
        uiLocales: [
            {
                locale: "zh-CN",
                label: "简体中文",
                default: true,
                strings,
                templates,
            },
        ],
    };
}
