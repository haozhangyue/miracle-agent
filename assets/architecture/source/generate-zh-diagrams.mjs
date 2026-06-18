import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "..");

const W = 1920;
const H = 1080;
const colors = {
  bg: "#07192d",
  text: "#f4f7fb",
  muted: "#4f6789",
  cyan: "#08bde2",
  cyanFill: "#c5edf4",
  blue: "#438eef",
  blueFill: "#d6e5f9",
  green: "#10c58a",
  greenFill: "#d2efe5",
  violet: "#8c61ef",
  violetFill: "#e5ddfb",
  amber: "#f5b516",
  amberFill: "#f8edc9",
  panel: "#f8fafc",
  arrow: "#bdeafb",
  footer: "#06475b",
};

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const text = (x, y, value, size = 24, fill = colors.muted, weight = 500, anchor = "start") =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif">${esc(value)}</text>`;

function multiline(x, y, lines, { size = 23, fill = colors.muted, weight = 500, gap = 34 } = {}) {
  return lines.map((line, index) => text(x, y + index * gap, line, size, fill, weight)).join("");
}

function panel({ x, y, w, h, title, lines, color, headerFill, titleSize = 29, bodySize = 22, bodyGap = 34 }) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${colors.panel}" stroke="${color}" stroke-width="3"/>
    <rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="59" rx="20" fill="${headerFill}"/>
    ${text(x + 28, y + 43, title, titleSize, "#18243e", 700)}
    ${multiline(x + 28, y + 93, lines, { size: bodySize, gap: bodyGap })}
  `;
}

function pill({ x, y, w, label, color, size = 24 }) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="64" rx="20" fill="${colors.panel}" stroke="${color}" stroke-width="3"/>
    ${text(x + w / 2, y + 42, label, size, "#18243e", 700, "middle")}
  `;
}

function arrow(x1, y1, x2, y2, label = "") {
  const labelSvg = label ? text((x1 + x2) / 2, y1 - 10, label, 16, "#c9d8eb", 500, "middle") : "";
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors.arrow}" stroke-width="4" marker-end="url(#arrow)"/>${labelSvg}`;
}

function base(title, subtitle, body, footer) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <marker id="arrow" markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L14,7 L0,14 z" fill="${colors.arrow}"/>
      </marker>
    </defs>
    <rect width="${W}" height="${H}" fill="${colors.bg}"/>
    <circle cx="1780" cy="70" r="270" fill="#0b3a49" opacity="0.75"/>
    <circle cx="95" cy="1030" r="380" fill="#243760" opacity="0.78"/>
    ${text(90, 82, title, 47, colors.text, 750)}
    ${text(92, 130, subtitle, 23, "#c6d5e8", 500)}
    ${body}
    <rect x="240" y="982" width="1440" height="60" rx="20" fill="${colors.footer}" stroke="${colors.cyan}" stroke-width="2"/>
    ${text(960, 1020, footer, 18, "#edf8fc", 650, "middle")}
  </svg>`;
}

const diagrams = [
  {
    file: "miracle-system-architecture-zh.png",
    svg: base(
      "Miracle 奇迹 Agent OS：系统总架构",
      "本地优先控制平面、明确的外部副作用协议、可重建的运行事实",
      `
        ${panel({ x: 70, y: 184, w: 352, h: 222, title: "用户与可视化层", lines: ["控制中心 / DAG / 无限画布", "Agent / 产物 / 审核视图", "所有编辑最终形成 Spec Diff"], color: colors.cyan, headerFill: colors.cyanFill })}
        ${panel({ x: 484, y: 184, w: 382, h: 222, title: "版本化配置层", lines: ["工作流 / 组件 / Agent Spec", "ArtifactSpec + review_policy", "必需 / 可选 EdgeSpec"], color: colors.violet, headerFill: colors.violetFill })}
        ${panel({ x: 930, y: 184, w: 390, h: 222, title: "工作流编排器", lines: ["校验 / 汇聚 / 选择器", "业务修订 + 输入冻结", "单写入器 / 故障恢复"], color: colors.green, headerFill: colors.greenFill })}
        ${panel({ x: 1384, y: 184, w: 456, h: 222, title: "运行时与能力提供方", lines: ["Runtime Adapter + Provider", "Codex / Hermes / OpenClaw / API", "支持时使用幂等键"], color: colors.blue, headerFill: colors.blueFill })}
        ${arrow(422, 295, 484, 295)}
        ${arrow(866, 295, 930, 295)}
        ${arrow(1320, 295, 1384, 295)}

        ${panel({ x: 104, y: 550, w: 422, h: 244, title: "冻结的运行上下文", lines: ["Workflow 快照 + Hash", "已解析组件 / ProviderPolicy", "业务修订 / 输入指纹"], color: colors.amber, headerFill: colors.amberFill })}
        ${panel({ x: 624, y: 550, w: 432, h: 244, title: "执行模型", lines: ["每个 run/node 仅一个 NodeRun", "多个不可变 NodeAttempt", "B→G 必需；F→G 可选"], color: colors.violet, headerFill: colors.violetFill })}
        ${panel({ x: 1149, y: 550, w: 332, h: 244, title: "事件日志", lines: ["attempt_dispatched", "完整 result_received", "result_committed"], color: colors.cyan, headerFill: colors.cyanFill })}
        ${panel({ x: 1540, y: 550, w: 300, h: 244, title: "可重建投影", lines: ["稳定键 Upsert", "Manifest / Gate / Run", "冲突时停止提交"], color: colors.green, headerFill: colors.greenFill, bodySize: 21 })}
        ${arrow(526, 675, 624, 675, "启动时冻结")}
        ${arrow(1056, 675, 1149, 675, "追加事实")}
        ${arrow(1481, 675, 1540, 675, "重建")}
        ${arrow(1605, 406, 1312, 550)}
        ${text(1446, 474, "脱敏 AdapterResult", 16, "#c9d8eb", 500, "middle")}
      `,
      "模板定义契约；dispatched 保护外部副作用；received 保存重建投影所需的完整数据",
    ),
  },
  {
    file: "miracle-product-architecture-zh.png",
    svg: base(
      "Miracle 产品能力架构",
      "产品视图必须呈现业务修订、汇聚规则以及可恢复的外部副作用状态",
      `
        ${panel({ x: 79, y: 184, w: 391, h: 226, title: "控制中心", lines: ["Run 状态与关注事项", "dispatched / received / committed", "对账与投影冲突处理"], color: colors.cyan, headerFill: colors.cyanFill, bodySize: 20 })}
        ${panel({ x: 514, y: 184, w: 391, h: 226, title: "工作流工作台", lines: ["必需 / 可选边样式", "join_policy 与边作用域选择器", "review_policy 编辑器"], color: colors.violet, headerFill: colors.violetFill })}
        ${panel({ x: 949, y: 184, w: 392, h: 226, title: "多 Agent 协同", lines: ["NodeRun + 业务修订", "Attempt 历史与 Provider 切换", "等待 / 阻塞 / 对账中"], color: colors.green, headerFill: colors.greenFill })}
        ${panel({ x: 1384, y: 184, w: 392, h: 226, title: "产物与审核", lines: ["版本化 Artifact Board", "GateInstance：3 个过程状态", "决策绑定精确 ID + Hash"], color: colors.amber, headerFill: colors.amberFill })}
        ${panel({ x: 279, y: 570, w: 571, h: 230, title: "配置平面", lines: ["Workflow / Artifact / Gate Spec", "ProviderPolicy / Registry", "仅保存可 Git 版本化契约"], color: colors.blue, headerFill: colors.blueFill })}
        ${panel({ x: 1090, y: 570, w: 550, h: 230, title: "运行平面", lines: ["RunSpec / NodeRun / NodeAttempt", "基于 subject 的 Event Journal", "稳定键、可重建投影"], color: colors.green, headerFill: colors.greenFill })}
        ${arrow(850, 685, 1090, 685, "启动时冻结快照")}
      `,
      "界面必须说明节点为何等待、Provider 是否可重试，以及最终放行的是哪个精确产物版本",
    ),
  },
  {
    file: "miracle-ops-architecture-zh.png",
    svg: base(
      "Miracle 运维与运行态架构",
      "崩溃恢复必须区分：尚未派发、外部结果未知、仅待完成投影",
      `
        ${pill({ x: 49, y: 205, w: 190, label: "校验", color: colors.cyan })}
        ${pill({ x: 284, y: 205, w: 191, label: "试运行", color: colors.blue })}
        ${pill({ x: 520, y: 205, w: 221, label: "解析并冻结输入", color: colors.amber, size: 22 })}
        ${pill({ x: 785, y: 205, w: 220, label: "创建 NodeAttempt", color: colors.violet, size: 22 })}
        ${pill({ x: 1049, y: 205, w: 251, label: "记录 DISPATCHED", color: colors.amber, size: 22 })}
        ${pill({ x: 1344, y: 205, w: 252, label: "调用 Provider", color: colors.violet, size: 22 })}
        ${pill({ x: 1640, y: 205, w: 230, label: "记录 RECEIVED", color: colors.green, size: 22 })}
        ${arrow(239, 237, 284, 237)}
        ${arrow(475, 237, 520, 237)}
        ${arrow(741, 237, 785, 237)}
        ${arrow(1005, 237, 1049, 237)}
        ${arrow(1300, 237, 1344, 237)}
        ${arrow(1596, 237, 1640, 237)}

        ${panel({ x: 84, y: 430, w: 392, h: 286, title: "恢复矩阵", lines: ["无 dispatched → 可安全调度", "有 dispatched、无 received → 先对账", "有 received、无 committed → 仅投影", "已有 committed → 执行完成"], color: colors.cyan, headerFill: colors.cyanFill, bodySize: 19 })}
        ${panel({ x: 550, y: 430, w: 391, h: 286, title: "业务操作边界", lines: ["重试 / fallback：同一 operation", "返工 / 用户重跑：新业务修订", "输入或模式变化：新 operation", "每次真实调用：新 attempt"], color: colors.violet, headerFill: colors.violetFill, bodySize: 21 })}
        ${panel({ x: 1014, y: 430, w: 392, h: 286, title: "完整 Received 事件", lines: ["Provider 回执 / 耗时 / 成本", "全部产物 ID、路径与 Hash", "失败信息 + Runtime 事件", "凭证始终脱敏"], color: colors.green, headerFill: colors.greenFill, bodySize: 21 })}
        ${panel({ x: 1480, y: 430, w: 355, h: 286, title: "投影提交", lines: ["按稳定 ID Upsert", "同 ID 同内容 = 幂等", "同 ID 内容冲突 = 停止", "committed 仅记录投影完成"], color: colors.amber, headerFill: colors.amberFill, bodySize: 21 })}
      `,
      "已派发但未收到结果代表外部结果未知：必须先对账，禁止盲目重试",
    ),
  },
  {
    file: "miracle-agent-collaboration-zh.png",
    svg: base(
      "Miracle 多 Agent 协同可视化",
      "Agent 状态回答谁在行动；边、业务操作与产物事实决定流程能否继续",
      `
        ${panel({ x: 69, y: 184, w: 352, h: 222, title: "情报 Agent", lines: ["采集 / 核验", "clean_events：自动审核", "AgentHealth：运行中"], color: colors.cyan, headerFill: colors.cyanFill })}
        ${panel({ x: 504, y: 184, w: 352, h: 222, title: "内容 Agent", lines: ["NodeRun：已完成", "审核返工后进入业务修订 r2", "md_master v2：待审核"], color: colors.green, headerFill: colors.greenFill, bodySize: 21 })}
        ${panel({ x: 940, y: 184, w: 351, h: 222, title: "审核 Agent", lines: ["GateInstance：pending_review", "决策绑定产物 ID + Hash", "临时问题记录为 attention"], color: colors.amber, headerFill: colors.amberFill, bodySize: 21 })}
        ${panel({ x: 1374, y: 184, w: 402, h: 222, title: "媒体 Agent", lines: ["可选视频分支：已启动", "Attempt 已派发、尚未收到结果", "NodeRun：对账中"], color: colors.violet, headerFill: colors.violetFill, bodySize: 21 })}
        ${arrow(421, 295, 504, 295, "必需产物")}
        ${arrow(856, 295, 940, 295, "精确版本")}
        ${arrow(1291, 295, 1374, 295, "可选分支")}

        ${panel({ x: 164, y: 555, w: 431, h: 236, title: "AgentHealth 健康视图", lines: ["心跳 / 当前 Attempt", "等待对象 / 恢复动作", "不决定产物是否放行"], color: colors.green, headerFill: colors.greenFill })}
        ${panel({ x: 744, y: 555, w: 431, h: 236, title: "依赖关系视图", lines: ["B → G：必需 md_master", "F → G：可选 final_video", "已启动最多等待 30 分钟", "无合格产物则继续纯 MD"], color: colors.cyan, headerFill: colors.cyanFill, bodySize: 20 })}
        ${panel({ x: 1324, y: 555, w: 431, h: 236, title: "审计与时间线", lines: ["基于 subject 的 TraceEvent", "业务修订 + Attempt 历史", "对账记录与审核决策"], color: colors.amber, headerFill: colors.amberFill })}
      `,
      "纯 MD 流程通过 B→G 进入分发；已启动的视频分支仍保持可见并被明确等待",
    ),
  },
  {
    file: "miracle-workflow-lifecycle-zh.png",
    svg: base(
      "Miracle 工作流生命周期",
      "同一张图同时支持完整媒体流程和纯 MD 流程，不依赖隐藏的选择器关系",
      `
        ${pill({ x: 44, y: 205, w: 216, label: "WorkflowSpec", color: colors.violet, size: 23 })}
        ${pill({ x: 300, y: 205, w: 190, label: "校验", color: colors.cyan })}
        ${pill({ x: 530, y: 205, w: 220, label: "Run 快照", color: colors.amber })}
        ${pill({ x: 790, y: 205, w: 190, label: "NodeRun", color: colors.green })}
        ${pill({ x: 1020, y: 205, w: 220, label: "业务操作 rN", color: colors.violet })}
        ${pill({ x: 1280, y: 205, w: 220, label: "NodeAttempt", color: colors.blue })}
        ${pill({ x: 1540, y: 205, w: 300, label: "事件日志 + 投影", color: colors.cyan })}
        ${arrow(260, 237, 300, 237)}
        ${arrow(490, 237, 530, 237)}
        ${arrow(750, 237, 790, 237)}
        ${arrow(980, 237, 1020, 237)}
        ${arrow(1240, 237, 1280, 237)}
        ${arrow(1500, 237, 1540, 237)}

        ${panel({ x: 89, y: 430, w: 431, h: 270, title: "汇聚与选择器规则", lines: ["选择器默认只查看入边", "必需输入必须由必需边提供", "可选边默认不阻塞", "全局 Run 查找必须显式声明"], color: colors.blue, headerFill: colors.blueFill, bodySize: 21 })}
        ${panel({ x: 604, y: 430, w: 431, h: 270, title: "Flow A-G 汇聚", lines: ["B → G：md_master 必需", "F → G：final_video 可选", "已启动最多等待 30 分钟", "无合格产物则继续纯 MD"], color: colors.green, headerFill: colors.greenFill, bodySize: 21 })}
        ${panel({ x: 1119, y: 430, w: 352, h: 270, title: "产物审核策略", lines: ["none → 直接 approved", "auto → 由校验器决定", "manual → 创建待审 GateInstance", "conditional → 解析并记录"], color: colors.amber, headerFill: colors.amberFill, bodySize: 20 })}
        ${panel({ x: 1554, y: 430, w: 281, h: 270, title: "审核门状态", lines: ["pending_review", "decided", "invalidated", "阻塞属于 attention"], color: colors.violet, headerFill: colors.violetFill, bodySize: 20 })}
      `,
      "执行依赖只来自 edges；布局和全局产物搜索都不能静默创建第二套 DAG",
    ),
  },
];

await fs.mkdir(outputDir, { recursive: true });

for (const diagram of diagrams) {
  await sharp(Buffer.from(diagram.svg))
    .png()
    .toFile(path.join(outputDir, diagram.file));
}

console.log(`Generated ${diagrams.length} Chinese architecture diagrams in ${outputDir}`);
